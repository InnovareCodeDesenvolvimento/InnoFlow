import { describe, expect, it } from "vitest"
import { AxiosError, type InternalAxiosRequestConfig } from "axios"
import { formatPixKeyForDisplay, parsePixKey, pixKeyError } from "@/lib/pixKey"
import {
  accountDeletedNotice,
  accountDeletedState,
  accountDeletionError,
  DELETION_WARNING_TEXT,
  exportErrorMessage,
  exportFileName,
  isDeletionWordConfirmed,
  readAccountDeletedFlash,
} from "@/lib/accountDeletion"
import { buildNotificationPatch, centsToFieldText, formStateFrom, notificationSaveError, parseThresholdCents } from "@/lib/notificationPrefs"
import { companyRows, hasCompanyData } from "@/lib/legalCompany"
import { isTermsOutdatedError, isTermsRequiredError } from "@/lib/termsAcceptance"
import { PRIVACIDADE, TERMOS } from "@/content/legal"

/** Erro do axios com status/corpo, sem rede. `status` ausente = sem resposta (rede caiu). */
function apiError(status: number | undefined, body?: { error?: string; code?: string; details?: Array<{ path?: string; message?: string }> }, headers: Record<string, string> = {}) {
  const config = { headers: {} } as InternalAxiosRequestConfig
  const response = status === undefined ? undefined : ({ status, statusText: "", data: body ?? {}, headers, config } as never)
  return new AxiosError("falha", status === undefined ? "ERR_NETWORK" : "ERR_BAD_REQUEST", config, undefined, response)
}

describe("chave Pix (espelha o servidor)", () => {
  it.each([
    ["529.982.247-25", "CPF", "52998224725"],
    ["11.222.333/0001-81", "CNPJ", "11222333000181"],
    ["(11) 91234-5678", "PHONE", "+5511912345678"],
    ["+55 11 91234-5678", "PHONE", "+5511912345678"],
    ["Fulano@Exemplo.com", "EMAIL", "fulano@exemplo.com"],
    ["123E4567-E89B-12D3-A456-426614174000", "RANDOM", "123e4567-e89b-12d3-a456-426614174000"],
  ])("aceita %s", (raw, kind, normalized) => {
    expect(parsePixKey(raw)).toEqual({ kind, normalized })
  })

  it.each(["", "   ", "111.111.111-11", "11.222.333/0001-82", "(11) 1234-5678", "(00) 91234-5678", "fulano@", "abc", "😀", "x".repeat(80)])("recusa %j", (raw) => {
    expect(parsePixKey(raw)).toBeNull()
  })

  it("mensagem: vazio pede a chave; inválido explica os formatos; válido = sem erro", () => {
    expect(pixKeyError("")).toMatch(/Informe a chave Pix/)
    expect(pixKeyError("abc")).toMatch(/CPF, CNPJ, celular, e-mail ou chave aleatória/)
    expect(pixKeyError("529.982.247-25")).toBeNull()
  })

  it("mostra a chave de volta numa forma legível para conferência", () => {
    expect(formatPixKeyForDisplay(parsePixKey("52998224725")!)).toBe("CPF 529.982.247-25")
    expect(formatPixKeyForDisplay(parsePixKey("11912345678")!)).toBe("celular +55 11 91234-5678")
  })
})

describe("exclusão de conta", () => {
  it("o texto de aviso é o definido pelo time (sem reescrever)", () => {
    expect(DELETION_WARNING_TEXT.startsWith("Exclusão da conta é definitiva.")).toBe(true)
    expect(DELETION_WARNING_TEXT).toContain("Saldo restante é devolvido por Pix, em até 30 dias, para a chave que você informar.")
  })

  it("a palavra de confirmação ignora caixa e espaços das pontas, mas exige a palavra inteira", () => {
    expect(isDeletionWordConfirmed("EXCLUIR")).toBe(true)
    expect(isDeletionWordConfirmed("  excluir ")).toBe(true)
    expect(isDeletionWordConfirmed("EXCLUI")).toBe(false)
    expect(isDeletionWordConfirmed("")).toBe(false)
  })

  type Expected = { step?: string; field?: string; blocking?: boolean; resetGoogle?: boolean; link?: string }
  it.each<[string, number, Expected]>([
    ["OPEN_DEBT", 409, { step: "info", blocking: true, link: "/app/carteira" }],
    ["ACTIVE_SESSION", 409, { step: "info", blocking: true, link: "/app/sessao" }],
    ["PAYMENT_IN_PROGRESS", 409, { step: "info", blocking: true, link: "/app/carteira" }],
    ["REFUND_PIX_KEY_REQUIRED", 400, { step: "pix", field: "pix" }],
    ["CURRENT_PASSWORD_REQUIRED", 400, { step: "confirm", field: "password" }],
    ["INVALID_CURRENT_PASSWORD", 403, { step: "confirm", field: "password" }],
    ["INVALID_GOOGLE_TOKEN", 401, { step: "confirm", field: "google", resetGoogle: true }],
  ])("%s -> passo, campo e saída certos", (code, status, expected) => {
    const mapped = accountDeletionError(apiError(status, { error: "x", code }))
    expect(mapped).toMatchObject(Object.fromEntries(Object.entries(expected).filter(([k]) => k !== "link")))
    if (expected.link) expect(mapped.link?.to).toBe(expected.link)
  })

  it("400 VALIDATION_ERROR decide o campo por details[].path", () => {
    expect(accountDeletionError(apiError(400, { error: "x", code: "VALIDATION_ERROR", details: [{ path: "refundPixKey" }] }))).toMatchObject({ step: "pix", field: "pix" })
    expect(accountDeletionError(apiError(400, { error: "x", code: "VALIDATION_ERROR", details: [{ path: "googleCredential" }] }))).toMatchObject({ step: "confirm", field: "google" })
    expect(accountDeletionError(apiError(400, { error: "x", code: "VALIDATION_ERROR", details: [] })).field).toBeUndefined()
  })

  it("429 com Retry-After fala o tempo; 503 diz que a conta NÃO foi excluída; rede também", () => {
    expect(accountDeletionError(apiError(429, { error: "x", code: "RATE_LIMITED_ACCOUNT_DELETION" }, { "retry-after": "600" })).message).toContain("10 minutos")
    expect(accountDeletionError(apiError(429, { error: "x", code: "RATE_LIMITED_ACCOUNT_DELETION" })).message).toContain("alguns minutos")
    expect(accountDeletionError(apiError(503, { error: "x", code: "PAYMENT_SECRETS_KEY_MISSING" })).message).toContain("Sua conta não foi excluída")
    expect(accountDeletionError(apiError(503, { error: "x", code: "STEPUP_UNAVAILABLE" })).message).toContain("Sua conta não foi excluída")
    expect(accountDeletionError(apiError(undefined)).message).toContain("Sua conta não foi excluída")
    expect(accountDeletionError(apiError(500, { error: "x", code: "INTERNAL_ERROR" })).message).toContain("Sua conta não foi excluída")
  })

  it("403 FORBIDDEN bloqueia (não adianta repetir); código desconhecido cai no texto fixo", () => {
    expect(accountDeletionError(apiError(403, { error: "x", code: "FORBIDDEN" })).blocking).toBe(true)
    expect(accountDeletionError(apiError(418, { error: "x", code: "NOVO" })).message).toContain("Nada foi apagado")
  })

  it("aviso do login: estado da rota -> desfecho, e só o NOSSO flash vale", () => {
    expect(readAccountDeletedFlash(accountDeletedState("DELETED_PENDING_REFUND"))).toBe("DELETED_PENDING_REFUND")
    expect(readAccountDeletedFlash(accountDeletedState("DELETED"))).toBe("DELETED")
    expect(readAccountDeletedFlash({ flash: "password-reset" })).toBeNull()
    expect(readAccountDeletedFlash(null)).toBeNull()
    expect(accountDeletedNotice("DELETED_PENDING_REFUND")).toContain("30 dias")
    expect(accountDeletedNotice("DELETED")).not.toContain("Pix")
  })
})

describe("exportação", () => {
  it("nome do arquivo: innoflow-meus-dados-AAAAMMDD.json", () => {
    expect(exportFileName(new Date(2026, 9, 5))).toBe("innoflow-meus-dados-20261005.json")
  })
  it("429 (3 por dia), rede, 5xx e sessão têm texto próprio", () => {
    expect(exportErrorMessage(apiError(429, { error: "x", code: "RATE_LIMITED_EXPORT" }))).toContain("amanhã")
    expect(exportErrorMessage(apiError(429, { error: "x", code: "RATE_LIMITED_EXPORT" }, { "retry-after": "7200" }))).toContain("2 horas")
    expect(exportErrorMessage(apiError(undefined))).toMatch(/Sem conexão/)
    expect(exportErrorMessage(apiError(500, { error: "x", code: "INTERNAL_ERROR" }))).toMatch(/instável/)
    expect(exportErrorMessage(apiError(401, { error: "x", code: "UNAUTHORIZED" }))).toMatch(/sessão expirou/)
  })
})

describe("preferências de notificação", () => {
  const saved = { sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: 2000 }

  it("limiar: de R$ 5,00 a R$ 500,00, em reais", () => {
    expect(parseThresholdCents("20,00")).toBe(2000)
    expect(parseThresholdCents("5")).toBe(500)
    expect(parseThresholdCents("500,00")).toBe(50000)
    expect(parseThresholdCents("4,99")).toBeNull()
    expect(parseThresholdCents("500,01")).toBeNull()
    expect(parseThresholdCents("abc")).toBeNull()
    expect(parseThresholdCents("")).toBeNull()
    expect(centsToFieldText(2000)).toBe("20,00")
  })

  it("manda SÓ o que mudou; nada mudou = sem patch", () => {
    expect(buildNotificationPatch(formStateFrom(saved), saved)).toEqual({ ok: true, patch: null })
    expect(buildNotificationPatch({ ...formStateFrom(saved), sessionReceiptEmail: false }, saved)).toEqual({ ok: true, patch: { sessionReceiptEmail: false } })
    expect(buildNotificationPatch({ ...formStateFrom(saved), thresholdText: "35,50" }, saved)).toEqual({ ok: true, patch: { lowBalanceThresholdCents: 3550 } })
  })

  it("limiar inválido barra com o aviso ligado; com o aviso desligado não é validado nem enviado", () => {
    expect(buildNotificationPatch({ ...formStateFrom(saved), thresholdText: "1" }, saved)).toMatchObject({ ok: false })
    expect(buildNotificationPatch({ ...formStateFrom(saved), lowBalanceEnabled: false, thresholdText: "1" }, saved)).toEqual({ ok: true, patch: { lowBalanceEnabled: false } })
  })

  it("erros por code: 400 vai no campo do limiar; 429 e rede têm texto próprio", () => {
    expect(notificationSaveError(apiError(400, { error: "x", code: "VALIDATION_ERROR" })).threshold).toBe(true)
    expect(notificationSaveError(apiError(429, { error: "x", code: "RATE_LIMITED" })).message).toMatch(/Muitas alterações/)
    expect(notificationSaveError(apiError(undefined)).message).toMatch(/Sem conexão/)
  })
})

describe("aceite dos termos e dados da empresa", () => {
  it("reconhece o 400 do Google (path acceptedTermsVersion) e o 409 de versão antiga", () => {
    expect(isTermsRequiredError(apiError(400, { error: "x", code: "VALIDATION_ERROR", details: [{ path: "acceptedTermsVersion" }] }))).toBe(true)
    expect(isTermsRequiredError(apiError(400, { error: "x", code: "VALIDATION_ERROR", details: [{ path: "email" }] }))).toBe(false)
    expect(isTermsRequiredError(apiError(401, { error: "x", code: "INVALID_GOOGLE_TOKEN" }))).toBe(false)
    expect(isTermsOutdatedError(apiError(409, { error: "x", code: "TERMS_VERSION_OUTDATED" }))).toBe(true)
  })

  it("dados da empresa: some o que está vazio (nunca inventa)", () => {
    const empty = { name: null, cnpj: null, supportEmail: null, supportPhone: null, dpoEmail: null }
    expect(companyRows(empty)).toEqual([])
    expect(hasCompanyData(empty)).toBe(false)
    expect(hasCompanyData(undefined)).toBe(false)
    const rows = companyRows({ ...empty, cnpj: "11.222.333/0001-81", dpoEmail: "dpo@x.com", name: "  " })
    expect(rows.map((r) => r.label)).toEqual(["CNPJ", "Encarregado de dados (DPO)"])
    expect(rows[1]).toMatchObject({ href: "mailto:dpo@x.com" })
  })
})

describe("conteúdo legal", () => {
  it("a política traz o texto de retenção definido, palavra por palavra", () => {
    const text = PRIVACIDADE.sections.flatMap((s) => s.paragraphs).join(" ")
    expect(text).toContain(
      "Ao excluir a conta, apagamos o IP e o dispositivo (user-agent) registrados no início das suas recargas e o IP do aceite dos termos. Mantemos, sem identificação, as sessões, o extrato e os pagamentos por 5 anos (obrigação legal e fiscal). Registros de auditoria de segurança anteriores à exclusão podem conter e-mail, nome e IP do titular e são apagados por expurgo automático por idade (24 meses).",
    )
  })

  it.each([TERMOS, PRIVACIDADE])("$title: ids únicos, todas as seções com texto, e uma seção mostra os dados da empresa", (doc) => {
    const ids = doc.sections.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of doc.sections) expect(s.paragraphs.length).toBeGreaterThan(0)
    expect(doc.sections.some((s) => s.showCompany)).toBe(true)
  })
})
