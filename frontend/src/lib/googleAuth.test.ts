import { describe, expect, it } from "vitest"
import { clampGoogleButtonWidth, googleErrorMessageForCode, shouldShowGoogleButton } from "./googleAuth"

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
