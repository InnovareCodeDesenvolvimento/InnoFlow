import { AxiosError, AxiosHeaders } from "axios"
import { describe, expect, it } from "vitest"
import { parseReaisToCents } from "@/lib/money"
import {
  canRegisterChargeback,
  centsToInput,
  deadlineDateToIso,
  looksLikePersonalOrCardData,
  noticeDateToIso,
  parseReversalError,
  parseReversalLoadError,
  reasonMentionsDriver,
  responseDeadlineState,
  todayInputValue,
  toSingleLine,
  validateChargeback,
  validateDeletionProof,
  validateProofReference,
  validateRefund,
  validateUnblockReason,
  type ChargebackDraft,
  type RefundDraft,
} from "./reversals"

function axiosError(status: number, body?: unknown) {
  return new AxiosError("falhou", String(status), undefined, undefined, { status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data: body })
}

describe("reasonMentionsDriver — o motivo fica gravado e não pode identificar o motorista", () => {
  it("nome completo, parte do nome (4+ letras, palavra inteira, sem acento/caixa) e e-mail", () => {
    expect(reasonMentionsDriver("Cortesia para Tiago Travado", "Tiago Travado")).toBe(true)
    expect(reasonMentionsDriver("cortesia pro TIAGO pela demora", "Tiago Travado")).toBe(true)
    expect(reasonMentionsDriver("Reembolso da Jose por falha", "José Silva")).toBe(true)
    expect(reasonMentionsDriver("enviado para travado@innoelektron.com", "Tiago Travado", "travado@innoelektron.com")).toBe(true)
  })
  it("não acusa texto sem relação, nem pedaço de palavra, nem partículas curtas", () => {
    expect(reasonMentionsDriver("Carregador interrompeu a sessão por queda de energia", "Tiago Travado")).toBe(false)
    expect(reasonMentionsDriver("Sessão travada no carregador", "Maria da Silva")).toBe(false) // "travada" != "travado"; "da" tem 2 letras
    expect(reasonMentionsDriver("qualquer texto de motivo", null, null)).toBe(false)
    expect(reasonMentionsDriver("João foi cobrado em dobro", "Jo")).toBe(false) // partes < 4 letras não contam
  })
})

describe("validateRefund", () => {
  const draft: RefundDraft = { amountInput: "5,00", reason: "Cortesia por demora no atendimento", destination: "WALLET", portalReference: "" }
  const ctx = { refundableCents: 1882, driverName: "Tiago Travado", driverEmail: "travado@innoelektron.com" }

  it("aceita um estorno válido e devolve centavos inteiros", () => {
    const v = validateRefund(draft, ctx)
    expect(v.valid).toBe(true)
    expect(v.amountCents).toBe(500)
  })

  it("barra valor acima do teto, zero, vazio e formato inválido", () => {
    expect(validateRefund({ ...draft, amountInput: "18,83" }, ctx).errors.amount).toMatch(/passa do que ainda dá para estornar/)
    expect(validateRefund({ ...draft, amountInput: "18,82" }, ctx).valid).toBe(true)
    expect(validateRefund({ ...draft, amountInput: "0" }, ctx).errors.amount).toMatch(/maior que zero/)
    expect(validateRefund({ ...draft, amountInput: "" }, ctx).errors.amount).toBe("Informe o valor.")
    expect(validateRefund({ ...draft, amountInput: "12,5,0" }, ctx).errors.amount).toMatch(/inválido/)
  })

  it("motivo: 10 a 500, sem quebra de linha e sem o nome/e-mail do motorista", () => {
    expect(validateRefund({ ...draft, reason: "curto" }, ctx).errors.reason).toMatch(/mínimo de 10/)
    expect(validateRefund({ ...draft, reason: "x".repeat(501) }, ctx).errors.reason).toMatch(/no máximo 500/)
    expect(validateRefund({ ...draft, reason: "linha um\nlinha dois" }, ctx).errors.reason).toMatch(/quebra de linha/)
    expect(validateRefund({ ...draft, reason: "Cortesia para o Tiago pela demora" }, ctx).errors.reason).toMatch(/cita o nome ou o e-mail/)
  })

  it("a referência do portal só é conferida no destino cartão", () => {
    expect(validateRefund({ ...draft, portalReference: "a".repeat(121) }, ctx).valid).toBe(true)
    expect(validateRefund({ ...draft, destination: "CARD_VIA_PORTAL", portalReference: "a".repeat(121) }, ctx).errors.portalReference).toMatch(/no máximo 120/)
    expect(validateRefund({ ...draft, destination: "CARD_VIA_PORTAL", portalReference: "PORTAL-0042" }, ctx).valid).toBe(true)
  })
})

describe("centsToInput", () => {
  it("é o inverso de parseReaisToCents (sem separador de milhar)", () => {
    for (const cents of [1, 50, 100, 1882, 123456, 10_000_000]) expect(parseReaisToCents(centsToInput(cents))).toBe(cents)
    expect(centsToInput(1882)).toBe("18,82")
  })
})

describe("validateProofReference — espelha o schema do servidor (confirmar à mão)", () => {
  it("aceita códigos de comprovante", () => {
    for (const ok of ["COMP-2026-0123", "A1B2C", "E1234567820261005ABC", "ab.cd_ef:gh/ij#kl-mn"]) expect(validateProofReference(ok), ok).toBeNull()
  })
  it("recusa curto, longo, espaço, e-mail, símbolo e começo inválido", () => {
    expect(validateProofReference("abcd")).toMatch(/ao menos 5/)
    expect(validateProofReference("a".repeat(121))).toMatch(/no máximo 120/)
    expect(validateProofReference("comprovante 1234")).toMatch(/sem espaços nem e-mail/)
    expect(validateProofReference("fulano@email.com")).toMatch(/sem espaços nem e-mail/)
    expect(validateProofReference("-ABCDE")).toMatch(/sem espaços nem e-mail/)
  })
  it("recusa CPF com máscara e número de cartão (Luhn), mas não um número longo qualquer", () => {
    expect(validateProofReference("123.456.789-09")).toMatch(/CPF ou número de cartão/)
    expect(validateProofReference("4111111111111111")).toMatch(/CPF ou número de cartão/)
    expect(validateProofReference("1234567890123456")).toBeNull() // 16 dígitos que NÃO passam no Luhn
    expect(looksLikePersonalOrCardData("4111111111111111")).toBe(true)
  })
})

describe("validateDeletionProof / validateUnblockReason", () => {
  it("comprovante do Pix: 1 a 120, sem controle, sem CPF/cartão", () => {
    expect(validateDeletionProof("")).toMatch(/Informe o comprovante/)
    expect(validateDeletionProof("E123 456 com espaço é livre")).toBeNull() // texto livre: espaço pode
    expect(validateDeletionProof("a".repeat(121))).toMatch(/no máximo 120/)
    expect(validateDeletionProof("123.456.789-09")).toMatch(/CPF ou número de cartão/)
  })
  it("motivo do desbloqueio: 10 a 500", () => {
    expect(validateUnblockReason("curto")).toMatch(/mínimo de 10/)
    expect(validateUnblockReason("Motorista comprovou a titularidade")).toBeNull()
    expect(validateUnblockReason("x".repeat(501))).toMatch(/no máximo 500/)
  })
})

describe("validateChargeback", () => {
  const now = new Date(2026, 9, 5, 10, 0, 0) // 05/10/2026 10:00 (fuso do teste)
  const draft: ChargebackDraft = { amountInput: "37,82", notifiedDate: "2026-10-05", caseReference: "CASO-1", reasonCode: "", deadlineDate: "" }

  it("aceita o mínimo (valor, data do aviso, referência) e o prazo é opcional", () => {
    const v = validateChargeback(draft, 3782, now)
    expect(v.valid).toBe(true)
    expect(v.amountCents).toBe(3782)
  })
  it("valor acima do capturado, vazio e inválido", () => {
    expect(validateChargeback({ ...draft, amountInput: "37,83" }, 3782, now).errors.amount).toMatch(/passa do que foi capturado/)
    expect(validateChargeback({ ...draft, amountInput: "" }, 3782, now).errors.amount).toMatch(/Informe o valor/)
    expect(validateChargeback({ ...draft, amountInput: "abc" }, 3782, now).errors.amount).toMatch(/inválido/)
  })
  it("aviso no futuro, referência vazia e prazo anterior ao aviso", () => {
    expect(validateChargeback({ ...draft, notifiedDate: "2026-10-06" }, 3782, now).errors.notifiedDate).toMatch(/futuro/)
    expect(validateChargeback({ ...draft, notifiedDate: "" }, 3782, now).errors.notifiedDate).toMatch(/Informe a data/)
    expect(validateChargeback({ ...draft, caseReference: "  " }, 3782, now).errors.caseReference).toMatch(/Informe a referência/)
    expect(validateChargeback({ ...draft, deadlineDate: "2026-10-04" }, 3782, now).errors.deadlineDate).toMatch(/anterior ao aviso/)
    expect(validateChargeback({ ...draft, deadlineDate: "2026-10-12" }, 3782, now).valid).toBe(true)
    expect(validateChargeback({ ...draft, reasonCode: "x".repeat(41) }, 3782, now).errors.reasonCode).toMatch(/no máximo 40/)
  })
})

describe("datas enviadas ao servidor", () => {
  it("aviso de hoje = agora (o servidor recusa o futuro); dia passado = meio-dia local; prazo = fim do dia local", () => {
    const now = new Date(2026, 9, 5, 10, 0, 0)
    expect(todayInputValue(now)).toBe("2026-10-05")
    expect(noticeDateToIso("2026-10-05", now)).toBe(now.toISOString())
    expect(new Date(noticeDateToIso("2026-10-01", now)).getHours()).toBe(12)
    expect(new Date(noticeDateToIso("2026-10-01", now)).getTime()).toBeLessThan(now.getTime())
    const deadline = new Date(deadlineDateToIso("2026-10-10"))
    expect([deadline.getDate(), deadline.getHours(), deadline.getMinutes()]).toEqual([10, 23, 59])
  })
})

describe("responseDeadlineState — prazo do chargeback em DIAS DE CALENDÁRIO", () => {
  const now = new Date(2026, 9, 5, 14, 0, 0)
  const at = (day: number, h = 23, m = 59) => new Date(2026, 9, day, h, m, 0).toISOString()

  it("só o EM ABERTO tem prazo vivo; sem prazo é dito", () => {
    expect(responseDeadlineState(at(6), "WON", now).kind).toBe("none")
    expect(responseDeadlineState(null, "OPEN", now)).toMatchObject({ kind: "none", label: "Sem prazo cadastrado" })
  })
  it("próximo (até 3 dias) x tranquilo (mais que isso)", () => {
    expect(responseDeadlineState(at(5), "OPEN", now)).toMatchObject({ kind: "near", label: "Vence hoje" })
    expect(responseDeadlineState(at(6), "OPEN", now)).toMatchObject({ kind: "near", label: "Vence em 1 dia" })
    expect(responseDeadlineState(at(8), "OPEN", now)).toMatchObject({ kind: "near", label: "Vence em 3 dias" })
    expect(responseDeadlineState(at(9), "OPEN", now)).toMatchObject({ kind: "ok", label: "Vence em 4 dias" })
  })
  it("vencido: hoje (a hora passou), há 1 dia, há N dias", () => {
    expect(responseDeadlineState(at(5, 9, 0), "OPEN", now)).toMatchObject({ kind: "overdue", label: "Venceu hoje" })
    expect(responseDeadlineState(at(4), "OPEN", now)).toMatchObject({ kind: "overdue", label: "Vencido há 1 dia", days: 1 })
    expect(responseDeadlineState(at(2), "OPEN", now)).toMatchObject({ kind: "overdue", label: "Vencido há 3 dias", days: 3 })
  })
})

describe("parseReversalError — por `code`, nunca o texto do servidor", () => {
  it("senha errada, rate limit, step-up fora e erro de regra de cada domínio", () => {
    expect(parseReversalError(axiosError(403, { code: "INVALID_CURRENT_PASSWORD", error: "SEGREDO ecoado" }), "refund")).toMatchObject({ code: "INVALID_CURRENT_PASSWORD", message: "Senha incorreta." })
    expect(parseReversalError(axiosError(503, { code: "STEPUP_UNAVAILABLE" }), "refund").message).toMatch(/Nada foi registrado/)
    expect(parseReversalError(axiosError(429, { code: "RATE_LIMITED" }), "chargeback").message).toMatch(/Muitas tentativas/)
    expect(parseReversalError(axiosError(429, { code: "RATE_LIMITED_ACCOUNT_DELETION" }), "deletion").message).toMatch(/Muitas tentativas de senha/)
    expect(parseReversalError(axiosError(409, { code: "NO_CARD_PAYMENT" }), "refund").message).toMatch(/não foi paga com cartão/)
    expect(parseReversalError(axiosError(409, { code: "REFUND_NOT_CONFIRMABLE" }), "refund").message).toMatch(/não pode mais ser confirmada/)
    expect(parseReversalError(axiosError(409, { code: "CHARGEBACK_NOT_LOST" }), "chargeback").message).toMatch(/perdido ou aceito/)
    expect(parseReversalError(axiosError(409, { code: "PARTIAL_REFUND_NOT_ALLOWED" }), "deletion").message).toMatch(/saldo integral/)
    expect(parseReversalError(axiosError(503, { code: "PAYMENT_SECRETS_KEY_MISSING" }), "deletion").message).toMatch(/chave de segredos do servidor está inválida ou indisponível.*administrador do servidor/)
  })
  it("nunca ecoa o texto do servidor (pode trazer dado do corpo)", () => {
    const parsed = parseReversalError(axiosError(409, { code: "ALGO_NOVO", error: "senha1234 e Tiago Travado" }), "refund")
    expect(parsed.message).not.toMatch(/senha1234|Tiago/)
  })
  it("o mesmo code pode ter texto de domínio diferente (NOT_FOUND)", () => {
    expect(parseReversalError(axiosError(404, { code: "NOT_FOUND" }), "chargeback").message).toBe("Chargeback não encontrado.")
    expect(parseReversalError(axiosError(404, { code: "NOT_FOUND" }), "deletion").message).toBe("Este pedido de devolução não foi encontrado.")
  })
  it("sem `code` (proxy): 401 = sessão expirada, 429 = limite, 5xx = interno", () => {
    expect(parseReversalError(axiosError(401), "refund")).toMatchObject({ code: "UNAUTHORIZED", sessionExpired: true })
    expect(parseReversalError(axiosError(429), "refund").code).toBe("RATE_LIMITED")
    expect(parseReversalError(axiosError(502), "refund").message).toMatch(/nada foi registrado/)
  })
  it("sem resposta (rede caiu) e teto atual do 409 AMOUNT_EXCEEDS_REFUNDABLE", () => {
    expect(parseReversalError(new Error("Network Error"), "refund").message).toMatch(/falar com o servidor/)
    expect(parseReversalError(axiosError(409, { code: "AMOUNT_EXCEEDS_REFUNDABLE", details: { refundableCents: 100 } }), "refund").refundableCents).toBe(100)
    expect(parseReversalError(axiosError(409, { code: "AMOUNT_EXCEEDS_REFUNDABLE", details: { refundableCents: -1 } }), "refund").refundableCents).toBeNull()
    expect(parseReversalError(axiosError(409, { code: "AMOUNT_EXCEEDS_REFUNDABLE" }), "refund").refundableCents).toBeNull()
  })
  it("erro ao CARREGAR: texto por code ou null (a tela usa o genérico)", () => {
    expect(parseReversalLoadError(axiosError(503, { code: "STEPUP_UNAVAILABLE" }), "deletion")).toMatch(/Nada foi registrado/)
    expect(parseReversalLoadError(axiosError(500, { code: "ALGO" }), "deletion")).toBeNull()
    expect(parseReversalLoadError(new Error("x"), "deletion")).toBeNull()
  })
})

describe("canRegisterChargeback / toSingleLine", () => {
  it("só venda de cartão capturada com valor", () => {
    expect(canRegisterChargeback({ provider: "CIELO_CARD", status: "CAPTURED", amountCapturedCents: 100 })).toBe(true)
    expect(canRegisterChargeback({ provider: "CIELO_CARD", status: "CAPTURED", amountCapturedCents: 0 })).toBe(false)
    expect(canRegisterChargeback({ provider: "CIELO_CARD", status: "DENIED", amountCapturedCents: null })).toBe(false)
    expect(canRegisterChargeback({ provider: "CIELO_PIX", status: "CAPTURED", amountCapturedCents: 100 })).toBe(false)
    expect(canRegisterChargeback({ provider: "WALLET", status: "CAPTURED", amountCapturedCents: 100 })).toBe(false)
  })
  it("troca quebra de linha e tab por espaço", () => {
    expect(toSingleLine("a\nb\r\nc\td")).toBe("a b c d")
  })
})
