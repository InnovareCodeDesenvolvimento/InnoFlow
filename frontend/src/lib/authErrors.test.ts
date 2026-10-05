import { describe, expect, it } from "vitest"
import { AxiosError, type AxiosResponse } from "axios"
import { authErrorMessage, NETWORK_ERROR_MESSAGE, SERVER_UNSTABLE_MESSAGE, authRateLimitMessage, RATE_LIMITED_ACCOUNT_MESSAGE, RATE_LIMITED_AUTH_MESSAGE } from "./authErrors"
import { googleErrorMessageForCode } from "./googleAuth"

function axiosError(status: number | null, code?: string, error = "texto do backend"): AxiosError {
  const response = status === null ? undefined : ({ status, data: { error, code } } as AxiosResponse)
  return new AxiosError("falhou", undefined, undefined, undefined, response)
}

describe("authRateLimitMessage", () => {
  it("429 por CONTA e por IP têm mensagens distintas", () => {
    const account = authRateLimitMessage(429, "RATE_LIMITED_ACCOUNT")
    const ip = authRateLimitMessage(429, "RATE_LIMITED_AUTH")
    expect(account).toBe(RATE_LIMITED_ACCOUNT_MESSAGE)
    expect(ip).toBe(RATE_LIMITED_AUTH_MESSAGE)
    expect(account).not.toBe(ip)
  })

  it("por conta fala em 'esta conta' e em aguardar minutos; não confirma que o e-mail existe", () => {
    expect(RATE_LIMITED_ACCOUNT_MESSAGE).toMatch(/esta conta.*alguns minutos/i)
    expect(RATE_LIMITED_ACCOUNT_MESSAGE).not.toMatch(/senha|e-mail|cadastrad|existe/i)
  })

  it("429 sem code conhecido (proxy na frente) cai na mensagem por IP", () => {
    expect(authRateLimitMessage(429, undefined)).toBe(RATE_LIMITED_AUTH_MESSAGE)
    expect(authRateLimitMessage(429, "RATE_LIMITED")).toBe(RATE_LIMITED_AUTH_MESSAGE)
  })

  it("o code manda mesmo se o status faltar", () => {
    expect(authRateLimitMessage(undefined, "RATE_LIMITED_ACCOUNT")).toBe(RATE_LIMITED_ACCOUNT_MESSAGE)
  })

  it("outros erros não são limite de tentativas", () => {
    expect(authRateLimitMessage(401, "INVALID_CREDENTIALS")).toBeNull()
    expect(authRateLimitMessage(undefined, undefined)).toBeNull()
  })
})

describe("authErrorMessage", () => {
  it("429 usa o nosso texto e ignora o texto do backend", () => {
    const msg = authErrorMessage(axiosError(429, "RATE_LIMITED_ACCOUNT", "Muitas tentativas de login para esta conta."), "fallback")
    expect(msg).toBe(RATE_LIMITED_ACCOUNT_MESSAGE)
  })

  it("senha errada (401) segue mostrando a mensagem do backend", () => {
    expect(authErrorMessage(axiosError(401, "INVALID_CREDENTIALS", "E-mail ou senha inválidos."), "fallback")).toBe("E-mail ou senha inválidos.")
  })

  // MUDANÇA DELIBERADA (L1.1): sem resposta do servidor (rede/timeout/CORS) deixou de cair no fallback "E-mail ou senha inválidos" — não é senha errada.
  it("sem resposta (rede) diz que não há conexão, nunca \"senha inválida\"", () => {
    expect(authErrorMessage(axiosError(null), "E-mail ou senha inválidos.")).toBe(NETWORK_ERROR_MESSAGE)
  })

  it("5xx diz que o serviço está instável e ignora o texto do backend", () => {
    expect(authErrorMessage(axiosError(500, "INTERNAL", "stack trace"), "fallback")).toBe(SERVER_UNSTABLE_MESSAGE)
    expect(authErrorMessage(axiosError(503, undefined), "fallback")).toBe(SERVER_UNSTABLE_MESSAGE)
  })

  it("4xx de negócio (400/409) segue com a mensagem do backend", () => {
    expect(authErrorMessage(axiosError(409, "EMAIL_IN_USE", "E-mail já cadastrado."), "fallback")).toBe("E-mail já cadastrado.")
  })

  it("erro que não é de HTTP usa o fallback da tela", () => {
    expect(authErrorMessage(new Error("boom"), "fallback")).toBe("fallback")
  })
})

describe("googleErrorMessageForCode + limite de tentativas", () => {
  it("usa as mesmas mensagens do login (por IP e por conta)", () => {
    expect(googleErrorMessageForCode("RATE_LIMITED_AUTH", 429)).toBe(RATE_LIMITED_AUTH_MESSAGE)
    expect(googleErrorMessageForCode("RATE_LIMITED_ACCOUNT", 429)).toBe(RATE_LIMITED_ACCOUNT_MESSAGE)
    expect(googleErrorMessageForCode(undefined, 429)).toBe(RATE_LIMITED_AUTH_MESSAGE)
  })
})
