import { describe, expect, it } from "vitest"
import { AxiosError, type AxiosResponse } from "axios"
import { NETWORK_ERROR_MESSAGE, RATE_LIMITED_ACCOUNT_MESSAGE, SERVER_UNSTABLE_MESSAGE } from "./authErrors"
import {
  CPF_IN_USE_MESSAGE,
  PASSWORD_CHANGE_FALLBACK_MESSAGE,
  PROFILE_LOAD_FALLBACK_MESSAGE,
  PROFILE_SAVE_FALLBACK_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  passwordChangeError,
  profileLoadError,
  profileSaveError,
} from "./profileErrors"

/** `status: null` = sem resposta (rede caiu/timeout/CORS). O texto do backend é um isca: nenhuma mensagem pode ser ELE. */
function axiosError(status: number | null, code?: string, details?: unknown[]): AxiosError {
  const response = status === null ? undefined : ({ status, data: { error: "TEXTO-DO-BACKEND", code, details } } as AxiosResponse)
  return new AxiosError("falhou", undefined, undefined, undefined, response)
}

describe("passwordChangeError - por code, nunca pelo texto do backend", () => {
  it("senha atual errada (403) vai no CAMPO da senha atual", () => {
    expect(passwordChangeError(axiosError(403, "INVALID_CURRENT_PASSWORD"))).toEqual({ field: "currentPassword", message: "Senha atual incorreta." })
  })

  it("atual obrigatória, nova igual e validação do servidor vão no campo certo", () => {
    expect(passwordChangeError(axiosError(400, "CURRENT_PASSWORD_REQUIRED"))).toEqual({ field: "currentPassword", message: "Informe a senha atual." })
    expect(passwordChangeError(axiosError(400, "PASSWORD_UNCHANGED"))).toEqual({ field: "newPassword", message: "A nova senha precisa ser diferente da atual." })
    expect(passwordChangeError(axiosError(400, "VALIDATION_ERROR")).field).toBe("newPassword")
  })

  it("429 (por usuário): texto de limite de authErrors, sem campo", () => {
    expect(passwordChangeError(axiosError(429, "RATE_LIMITED_PASSWORD"))).toEqual({ message: RATE_LIMITED_ACCOUNT_MESSAGE })
    expect(passwordChangeError(axiosError(429, undefined))).toEqual({ message: RATE_LIMITED_ACCOUNT_MESSAGE })
  })

  it("sem resposta = rede (não é senha errada); 5xx = instabilidade; ambos com os textos de authErrors", () => {
    expect(passwordChangeError(axiosError(null))).toEqual({ message: NETWORK_ERROR_MESSAGE })
    expect(passwordChangeError(axiosError(503))).toEqual({ message: SERVER_UNSTABLE_MESSAGE })
    expect(passwordChangeError(axiosError(500, "INTERNAL_ERROR"))).toEqual({ message: SERVER_UNSTABLE_MESSAGE })
  })

  it("401 = sessão expirada; code desconhecido e erro que não é do axios caem num texto fixo nosso", () => {
    expect(passwordChangeError(axiosError(401, "UNAUTHORIZED"))).toEqual({ message: SESSION_EXPIRED_MESSAGE })
    expect(passwordChangeError(axiosError(400, "OUTRO_CODIGO"))).toEqual({ message: PASSWORD_CHANGE_FALLBACK_MESSAGE })
    expect(passwordChangeError(new Error("boom"))).toEqual({ message: PASSWORD_CHANGE_FALLBACK_MESSAGE })
  })

  it("nenhuma mensagem é o texto do backend", () => {
    for (const status of [400, 401, 403, 409, 429, 500]) {
      expect(passwordChangeError(axiosError(status, "X")).message).not.toContain("BACKEND")
    }
  })
})

describe("profileSaveError", () => {
  it("CPF de outra conta (409): no campo CPF", () => {
    expect(profileSaveError(axiosError(409, "CPF_IN_USE"))).toEqual({ message: CPF_IN_USE_MESSAGE, fields: { cpf: CPF_IN_USE_MESSAGE } })
  })

  it("400 VALIDATION_ERROR: o PATH decide o campo (o texto do servidor é ignorado)", () => {
    const err = axiosError(400, "VALIDATION_ERROR", [
      { path: "cpf", message: "texto do servidor" },
      { path: "phone", message: "outro texto" },
    ])
    const out = profileSaveError(err)
    expect(Object.keys(out.fields ?? {}).sort()).toEqual(["cpf", "phone"])
    expect(JSON.stringify(out)).not.toContain("servidor")
  })

  it("400 sem path conhecido: aviso do formulário, sem campos", () => {
    expect(profileSaveError(axiosError(400, "VALIDATION_ERROR", [{ path: "", message: "x" }]))).toEqual({ message: "Confira os dados informados." })
  })

  it("429, rede e 5xx: textos de authErrors", () => {
    expect(profileSaveError(axiosError(429, "RATE_LIMITED_PROFILE"))).toEqual({ message: RATE_LIMITED_ACCOUNT_MESSAGE })
    expect(profileSaveError(axiosError(null))).toEqual({ message: NETWORK_ERROR_MESSAGE })
    expect(profileSaveError(axiosError(502))).toEqual({ message: SERVER_UNSTABLE_MESSAGE })
  })

  it("code desconhecido: texto fixo nosso", () => {
    expect(profileSaveError(axiosError(400, "OUTRO"))).toEqual({ message: PROFILE_SAVE_FALLBACK_MESSAGE })
  })
})

describe("profileLoadError", () => {
  it("rede, 5xx e 429 têm texto próprio; o resto cai no texto fixo de carregamento", () => {
    expect(profileLoadError(axiosError(null))).toBe(NETWORK_ERROR_MESSAGE)
    expect(profileLoadError(axiosError(500))).toBe(SERVER_UNSTABLE_MESSAGE)
    expect(profileLoadError(axiosError(429))).toBe(RATE_LIMITED_ACCOUNT_MESSAGE)
    expect(profileLoadError(axiosError(404, "NOT_FOUND"))).toBe(PROFILE_LOAD_FALLBACK_MESSAGE)
  })
})
