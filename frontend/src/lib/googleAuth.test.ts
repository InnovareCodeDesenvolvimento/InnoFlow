import { describe, expect, it } from "vitest"
import { clampGoogleButtonWidth, googleErrorMessageForCode, linkGoogleErrorMessage, shouldShowGoogleButton } from "./googleAuth"

describe("shouldShowGoogleButton", () => {
  it("mostra só quando há Client ID de verdade", () => {
    expect(shouldShowGoogleButton({ googleClientId: "123.apps.googleusercontent.com" })).toBe(true)
  })

  it("esconde com null (feature desligada), vazio, só espaços ou config ausente/que falhou", () => {
    expect(shouldShowGoogleButton({ googleClientId: null })).toBe(false)
    expect(shouldShowGoogleButton({ googleClientId: "" })).toBe(false)
    expect(shouldShowGoogleButton({ googleClientId: "   " })).toBe(false)
    expect(shouldShowGoogleButton(undefined)).toBe(false)
  })
})

describe("clampGoogleButtonWidth", () => {
  it("respeita a faixa do GIS (200–400px) e devolve inteiro", () => {
    expect(clampGoogleButtonWidth(240.7)).toBe(240)
    expect(clampGoogleButtonWidth(120)).toBe(200)
    expect(clampGoogleButtonWidth(900)).toBe(400)
  })
})

describe("googleErrorMessageForCode", () => {
  it("conta de operação/administração", () => {
    expect(googleErrorMessageForCode("GOOGLE_LOGIN_NOT_ALLOWED")).toMatch(/operação\/administração.*e-mail e senha/)
  })

  it("e-mail não verificado", () => {
    expect(googleErrorMessageForCode("GOOGLE_EMAIL_NOT_VERIFIED")).toMatch(/não foi verificado/)
  })

  it("token inválido e feature não configurada", () => {
    expect(googleErrorMessageForCode("INVALID_GOOGLE_TOKEN")).toMatch(/validar/)
    expect(googleErrorMessageForCode("GOOGLE_NOT_CONFIGURED")).toMatch(/indisponível/)
  })

  it("código desconhecido ou ausente (rede, 5xx) cai no genérico, sem vazar texto do backend", () => {
    const generic = googleErrorMessageForCode(undefined)
    expect(generic).toMatch(/Tente novamente/)
    expect(googleErrorMessageForCode("ALGO_NOVO")).toBe(generic)
  })
})

describe("linkGoogleErrorMessage (POST /api/auth/google/link)", () => {
  it("e-mail diferente: diz qual e-mail usar", () => {
    expect(linkGoogleErrorMessage("GOOGLE_EMAIL_MISMATCH", 403, "ana@x.com")).toBe("Use a conta Google com o mesmo e-mail desta conta (ana@x.com).")
    expect(linkGoogleErrorMessage("GOOGLE_EMAIL_MISMATCH", 403)).toBe("Use a conta Google com o mesmo e-mail desta conta.")
  })
  it("já vinculado, não verificado, não permitido, não configurado, token inválido, sessão expirada", () => {
    expect(linkGoogleErrorMessage("GOOGLE_ALREADY_LINKED", 409)).toMatch(/já está vinculada a outra conta, ou a sua conta já tem um Google vinculado/)
    expect(linkGoogleErrorMessage("GOOGLE_EMAIL_NOT_VERIFIED", 403)).toMatch(/não foi verificado/)
    expect(linkGoogleErrorMessage("GOOGLE_LOGIN_NOT_ALLOWED", 403)).toMatch(/não pode ser vinculada/)
    expect(linkGoogleErrorMessage("GOOGLE_NOT_CONFIGURED", 503)).toMatch(/indisponível/)
    expect(linkGoogleErrorMessage("INVALID_GOOGLE_TOKEN", 401)).toMatch(/validar a conta Google/)
    expect(linkGoogleErrorMessage("UNAUTHORIZED", 401)).toMatch(/sessão expirou/)
  })
  it("429 usa o texto de limite de tentativas; código desconhecido cai no genérico", () => {
    expect(linkGoogleErrorMessage("RATE_LIMITED_AUTH", 429)).toBe(googleErrorMessageForCode("RATE_LIMITED_AUTH", 429))
    expect(linkGoogleErrorMessage("ALGO_NOVO", 500)).toMatch(/Tente novamente em instantes/)
  })
})
