import { describe, expect, it } from "vitest"
import { AxiosError, type AxiosResponse } from "axios"
import {
  CHARGEBACK_BLOCKED_MESSAGE,
  blockedMessage,
  disabledCardReason,
  formatBlockedUntil,
  isChargebackIssue,
  issueErrorMessage,
  issueFromEligibility,
  issueFromError,
} from "./cardEligibility"

const apiError = (status: number, body: unknown) => new AxiosError("x", "ERR", undefined, undefined, { status, data: body } as AxiosResponse)

describe("issueFromEligibility", () => {
  it("elegível, ausente ou servidor antigo (sem o campo): sem problema", () => {
    expect(issueFromEligibility({ eligible: true, reason: null, blockedUntil: null })).toBeNull()
    expect(issueFromEligibility(undefined)).toBeNull()
    expect(issueFromEligibility(null)).toBeNull()
  })

  it("GOOGLE_LOGIN_REQUIRED e TEMPORARILY_BLOCKED (com horário)", () => {
    expect(issueFromEligibility({ eligible: false, reason: "GOOGLE_LOGIN_REQUIRED", blockedUntil: null })).toEqual({ reason: "GOOGLE_LOGIN_REQUIRED", blockedUntil: null })
    expect(issueFromEligibility({ eligible: false, reason: "TEMPORARILY_BLOCKED", blockedUntil: "2026-10-04T18:00:00.000Z" })).toEqual({
      reason: "TEMPORARILY_BLOCKED",
      blockedUntil: "2026-10-04T18:00:00.000Z",
    })
  })

  it("não elegível sem motivo conhecido cai em 'entre com o Google' (única ação possível)", () => {
    expect(issueFromEligibility({ eligible: false, reason: null, blockedUntil: null })?.reason).toBe("GOOGLE_LOGIN_REQUIRED")
  })

  it("horário de bloqueio de outro motivo é descartado", () => {
    expect(issueFromEligibility({ eligible: false, reason: "GOOGLE_LOGIN_REQUIRED", blockedUntil: "2026-10-04T18:00:00.000Z" })?.blockedUntil).toBeNull()
  })
})

describe("chargeback (L1.8)", () => {
  it("CHARGEBACK_BLOCKED do GET NÃO vira 'entre com o Google' (regressão: o mapa mandava todo motivo desconhecido ao Google)", () => {
    const issue = issueFromEligibility({ eligible: false, reason: "CHARGEBACK_BLOCKED", blockedUntil: null })
    expect(issue).toEqual({ reason: "CHARGEBACK_BLOCKED", blockedUntil: null })
    expect(isChargebackIssue(issue)).toBe(true)
  })

  it("horário que viesse junto é descartado (chargeback não tem prazo)", () => {
    expect(issueFromEligibility({ eligible: false, reason: "CHARGEBACK_BLOCKED", blockedUntil: "2026-10-05T18:00:00.000Z" })?.blockedUntil).toBeNull()
  })

  it("403 CARD_CHARGEBACK_BLOCKED (decide pelo code, não pelo texto)", () => {
    expect(issueFromError(apiError(403, { error: "qualquer texto", code: "CARD_CHARGEBACK_BLOCKED" }))).toEqual({ reason: "CHARGEBACK_BLOCKED", blockedUntil: null })
    // mesmo status 403 com outro code continua sendo o do Google; texto parecido sem o code não conta
    expect(issueFromError(apiError(403, { error: "x", code: "CARD_REQUIRES_VERIFIED_IDENTITY" }))?.reason).toBe("GOOGLE_LOGIN_REQUIRED")
    expect(issueFromError(apiError(403, { error: "O pagamento com cartão está indisponível para a sua conta." }))).toBeNull()
  })

  it("só chargeback é chargeback", () => {
    expect(isChargebackIssue({ reason: "TEMPORARILY_BLOCKED", blockedUntil: null })).toBe(false)
    expect(isChargebackIssue({ reason: "GOOGLE_LOGIN_REQUIRED", blockedUntil: null })).toBe(false)
    expect(isChargebackIssue(null)).toBe(false)
  })

  it("textos: o da API, sem culpar o motorista e com a alternativa", () => {
    const issue = { reason: "CHARGEBACK_BLOCKED", blockedUntil: null } as const
    expect(CHARGEBACK_BLOCKED_MESSAGE).toBe(
      "O pagamento com cartão está indisponível para a sua conta. O Pix e a carteira continuam disponíveis. Em caso de dúvida, fale com o suporte.",
    )
    expect(issueErrorMessage(issue)).toBe(CHARGEBACK_BLOCKED_MESSAGE)
    expect(disabledCardReason(issue)).toBe("Não pode ser usado para novas recargas.")
    expect(`${issueErrorMessage(issue)} ${disabledCardReason(issue)}`).not.toMatch(/Google|fraude|golpe|culp|contest/i)
  })
})

describe("issueFromError", () => {
  it("403 CARD_REQUIRES_VERIFIED_IDENTITY", () => {
    expect(issueFromError(apiError(403, { error: "x", code: "CARD_REQUIRES_VERIFIED_IDENTITY" }))).toEqual({ reason: "GOOGLE_LOGIN_REQUIRED", blockedUntil: null })
  })

  it("429 CARD_TEMPORARILY_BLOCKED lê details.blockedUntil (objeto ou array)", () => {
    const until = "2026-10-04T18:00:00.000Z"
    expect(issueFromError(apiError(429, { error: "x", code: "CARD_TEMPORARILY_BLOCKED", details: { blockedUntil: until } }))).toEqual({ reason: "TEMPORARILY_BLOCKED", blockedUntil: until })
    expect(issueFromError(apiError(429, { error: "x", code: "CARD_TEMPORARILY_BLOCKED", details: [{ blockedUntil: until }] }))?.blockedUntil).toBe(until)
  })

  it("bloqueio sem horário utilizável ainda é bloqueio (nunca 'Invalid Date')", () => {
    expect(issueFromError(apiError(429, { error: "x", code: "CARD_TEMPORARILY_BLOCKED" }))).toEqual({ reason: "TEMPORARILY_BLOCKED", blockedUntil: null })
    expect(issueFromError(apiError(429, { error: "x", code: "CARD_TEMPORARILY_BLOCKED", details: { blockedUntil: "lixo" } }))?.blockedUntil).toBeNull()
  })

  it("outros erros não são deste tipo", () => {
    expect(issueFromError(apiError(409, { error: "x", code: "PAYMENT_METHOD_DISABLED" }))).toBeNull()
    expect(issueFromError(new Error("rede"))).toBeNull()
  })
})

describe("formatBlockedUntil / mensagens", () => {
  const noon = new Date(2026, 9, 4, 12, 0, 0)
  it("hoje: só HH:MM", () => {
    expect(formatBlockedUntil(new Date(2026, 9, 4, 14, 35).toISOString(), noon)).toBe("14:35")
  })
  it("outro dia: data e hora", () => {
    expect(formatBlockedUntil(new Date(2026, 9, 5, 0, 20).toISOString(), noon)).toBe("05/10 às 00:20")
  })
  it("ausente ou inválido: null", () => {
    expect(formatBlockedUntil(null)).toBeNull()
    expect(formatBlockedUntil("nada")).toBeNull()
  })
  it("textos: com e sem horário", () => {
    const until = new Date(Date.now() + 60_000)
    expect(blockedMessage({ reason: "TEMPORARILY_BLOCKED", blockedUntil: until.toISOString() })).toMatch(/^Pagamento com cartão indisponível até \d{2}:\d{2}|até \d{2}\/\d{2} às/)
    expect(blockedMessage({ reason: "TEMPORARILY_BLOCKED", blockedUntil: null })).toBe("Pagamento com cartão indisponível por um tempo.")
    expect(issueErrorMessage({ reason: "GOOGLE_LOGIN_REQUIRED", blockedUntil: null })).toContain("conta Google")
  })
})

describe("disabledCardReason", () => {
  it("identidade: manda entrar com o Google; bloqueio: diz quando volta (sem repetir 'indisponível' do selo)", async () => {
    const { disabledCardReason } = await import("./cardEligibility")
    expect(disabledCardReason({ reason: "GOOGLE_LOGIN_REQUIRED", blockedUntil: null })).toContain("Entre com o Google")
    expect(disabledCardReason({ reason: "TEMPORARILY_BLOCKED", blockedUntil: new Date(Date.now() + 60_000).toISOString() })).toMatch(/^Volta a ficar disponível (às \d{2}:\d{2}|em \d{2}\/\d{2} às \d{2}:\d{2})\.$/)
    expect(disabledCardReason({ reason: "TEMPORARILY_BLOCKED", blockedUntil: null })).toBe("Volta a ficar disponível em instantes.")
  })
})
