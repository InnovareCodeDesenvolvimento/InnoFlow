import { describe, expect, it, vi } from "vitest"
import { AxiosError, type AxiosResponse } from "axios"
import {
  forgotPasswordError,
  isPasswordResetFlash,
  rateLimitMessage,
  readResetToken,
  resetPasswordError,
  RESET_LINK_INVALID_MESSAGE,
  retryAfterSeconds,
  scrubFragment,
  waitPhrase,
} from "./passwordReset"
import { NETWORK_ERROR_MESSAGE, SERVER_UNSTABLE_MESSAGE } from "./authErrors"
import { NEW_PASSWORD_SERVER_REJECTED } from "@/schemas/passwordReset.schema"

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE" // 43 caracteres base64url
const axiosError = (status: number | null, code?: string, extra?: { headers?: Record<string, string>; details?: Array<{ path: string; message: string }> }) => {
  const response = status === null ? undefined : ({ status, data: { error: "texto do backend", code, details: extra?.details }, headers: extra?.headers ?? {} } as AxiosResponse)
  return new AxiosError("falhou", undefined, undefined, undefined, response)
}

describe("readResetToken - lê o token do fragmento (#t=...)", () => {
  it("o token de 43 caracteres base64url sai de `#t=`", () => {
    expect(TOKEN).toHaveLength(43)
    expect(readResetToken(`#t=${TOKEN}`)).toBe(TOKEN)
    expect(readResetToken(`t=${TOKEN}`)).toBe(TOKEN) // sem o '#'
    expect(readResetToken(`#x=1&t=${TOKEN}`)).toBe(TOKEN)
  })

  it("sem fragmento, sem `t`, vazio, curto, longo ou com outro alfabeto: null (a tela mostra 'link inválido' sem gastar o limite do servidor)", () => {
    for (const hash of ["", "#", "#t=", "#x=1", `#t=${TOKEN.slice(1)}`, `#t=${TOKEN}A`, `#t=${TOKEN.slice(1)}+`, `#t=${TOKEN.slice(1)}=`, `#t=${TOKEN.slice(1)}%`, "#t=%20".padEnd(49, "a")]) {
      expect(readResetToken(hash), hash).toBeNull()
    }
  })

  it("o token NÃO é lido da querystring: só do fragmento", () => {
    expect(readResetToken(`?t=${TOKEN}`)).toBeNull()
  })
})

describe("scrubFragment - apaga o fragmento da URL na hora", () => {
  it("troca a entrada atual do histórico (replaceState) por caminho + querystring, preservando history.state", () => {
    const replaceState = vi.fn()
    const state = { key: "abc", idx: 3 }
    scrubFragment({ location: { hash: `#t=${TOKEN}`, pathname: "/redefinir-senha", search: "?a=1" }, history: { state, replaceState } } as unknown as Window)
    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledWith(state, "", "/redefinir-senha?a=1")
    expect(String(replaceState.mock.calls[0][2])).not.toContain(TOKEN)
  })

  it("idempotente: sem fragmento não mexe no histórico", () => {
    const replaceState = vi.fn()
    scrubFragment({ location: { hash: "", pathname: "/redefinir-senha", search: "" }, history: { state: null, replaceState } } as unknown as Window)
    expect(replaceState).not.toHaveBeenCalled()
  })

  it("no jsdom de verdade: o `location.hash` fica vazio e o caminho continua", () => {
    window.history.pushState(null, "", `/redefinir-senha#t=${TOKEN}`)
    expect(window.location.hash).toContain(TOKEN)
    scrubFragment()
    expect(window.location.hash).toBe("")
    expect(window.location.pathname).toBe("/redefinir-senha")
    expect(window.location.href).not.toContain(TOKEN)
  })
})

describe("Retry-After", () => {
  it("segundos inteiros do header (axios normaliza para minúsculas)", () => {
    expect(retryAfterSeconds(axiosError(429, "RATE_LIMITED_AUTH", { headers: { "retry-after": "300" } }))).toBe(300)
  })

  it("data HTTP vira segundos a partir de agora; passada = 0", () => {
    const now = Date.parse("2026-10-05T12:00:00Z")
    expect(retryAfterSeconds(axiosError(429, undefined, { headers: { "retry-after": "Mon, 05 Oct 2026 12:05:00 GMT" } }), now)).toBe(300)
    expect(retryAfterSeconds(axiosError(429, undefined, { headers: { "retry-after": "Mon, 05 Oct 2026 11:00:00 GMT" } }), now)).toBe(0)
  })

  it("header ausente (CORS não expõe), lixo ou erro que não é do axios: null", () => {
    expect(retryAfterSeconds(axiosError(429, "RATE_LIMITED_AUTH"))).toBeNull()
    expect(retryAfterSeconds(axiosError(429, undefined, { headers: { "retry-after": "logo" } }))).toBeNull()
    expect(retryAfterSeconds(new Error("x"))).toBeNull()
  })

  it("frase de espera: sem tempo exato diz 'alguns minutos'; com tempo, minutos arredondados para cima", () => {
    expect(waitPhrase(null)).toBe("alguns minutos")
    expect(waitPhrase(30)).toBe("menos de 1 minuto")
    expect(waitPhrase(60)).toBe("1 minuto")
    expect(waitPhrase(300)).toBe("5 minutos")
    expect(waitPhrase(301)).toBe("6 minutos")
    expect(waitPhrase(3600)).toBe("1 hora")
    expect(rateLimitMessage(null)).toBe("Muitas tentativas. Tente de novo em alguns minutos.")
    expect(rateLimitMessage(300)).toBe("Muitas tentativas. Tente de novo em 5 minutos.")
  })
})

describe("forgotPasswordError - por status/code, nunca pelo texto do backend", () => {
  it("400 VALIDATION_ERROR vai NO CAMPO (e-mail malformado)", () => {
    expect(forgotPasswordError(axiosError(400, "VALIDATION_ERROR"))).toEqual({ kind: "field", message: "E-mail inválido." })
  })

  it("429 RATE_LIMITED_AUTH: aviso do formulário, com o tempo quando legível", () => {
    expect(forgotPasswordError(axiosError(429, "RATE_LIMITED_AUTH"))).toEqual({ kind: "form", message: "Muitas tentativas. Tente de novo em alguns minutos." })
    expect(forgotPasswordError(axiosError(429, "RATE_LIMITED_AUTH", { headers: { "retry-after": "600" } })).message).toBe("Muitas tentativas. Tente de novo em 10 minutos.")
  })

  it("429 sem code (proxy) também é limite", () => {
    expect(forgotPasswordError(axiosError(429)).message).toMatch(/^Muitas tentativas/)
  })

  it("rede (sem resposta) e 5xx usam os textos de authErrors", () => {
    expect(forgotPasswordError(axiosError(null))).toEqual({ kind: "form", message: NETWORK_ERROR_MESSAGE })
    expect(forgotPasswordError(axiosError(500))).toEqual({ kind: "form", message: SERVER_UNSTABLE_MESSAGE })
    expect(forgotPasswordError(axiosError(503, "SERVICE_UNAVAILABLE"))).toEqual({ kind: "form", message: SERVER_UNSTABLE_MESSAGE })
  })

  it("erro que não é do axios: texto fixo nosso", () => {
    expect(forgotPasswordError(new Error("boom")).kind).toBe("form")
  })

  it("nenhuma mensagem confirma nem nega a existência da conta", () => {
    for (const err of [axiosError(400, "VALIDATION_ERROR"), axiosError(429, "RATE_LIMITED_AUTH"), axiosError(null), axiosError(500)]) {
      expect(forgotPasswordError(err).message).not.toMatch(/n[ãa]o existe|n[ãa]o encontrad|n[ãa]o cadastrad|cadastrado/i)
    }
  })
})

describe("resetPasswordError", () => {
  it("RESET_TOKEN_INVALID: o link morreu (a tela troca o formulário por 'link inválido')", () => {
    expect(resetPasswordError(axiosError(400, "RESET_TOKEN_INVALID"))).toEqual({ kind: "invalid-link", message: RESET_LINK_INVALID_MESSAGE })
    expect(RESET_LINK_INVALID_MESSAGE).toBe("Este link é inválido ou expirou. Peça um novo.")
  })

  it("VALIDATION_ERROR em newPassword: erro no CAMPO (formulário mantido)", () => {
    const err = axiosError(400, "VALIDATION_ERROR", { details: [{ path: "newPassword", message: "x" }] })
    expect(resetPasswordError(err)).toEqual({ kind: "field", message: NEW_PASSWORD_SERVER_REJECTED })
  })

  it("VALIDATION_ERROR em `token` (corpo gigante): o link não serve", () => {
    const err = axiosError(400, "VALIDATION_ERROR", { details: [{ path: "token", message: "x" }] })
    expect(resetPasswordError(err).kind).toBe("invalid-link")
  })

  it("429 com Retry-After legível; sem o header, 'alguns minutos'", () => {
    expect(resetPasswordError(axiosError(429, "RATE_LIMITED_AUTH", { headers: { "retry-after": "300" } }))).toEqual({ kind: "form", message: "Muitas tentativas. Tente de novo em 5 minutos." })
    expect(resetPasswordError(axiosError(429, "RATE_LIMITED_AUTH")).message).toBe("Muitas tentativas. Tente de novo em alguns minutos.")
  })

  it("503 SERVICE_UNAVAILABLE, 500 e rede: aviso do formulário (o token continua válido)", () => {
    expect(resetPasswordError(axiosError(503, "SERVICE_UNAVAILABLE"))).toEqual({ kind: "form", message: SERVER_UNSTABLE_MESSAGE })
    expect(resetPasswordError(axiosError(500))).toEqual({ kind: "form", message: SERVER_UNSTABLE_MESSAGE })
    expect(resetPasswordError(axiosError(null))).toEqual({ kind: "form", message: NETWORK_ERROR_MESSAGE })
  })

  it("código desconhecido: texto fixo nosso, nunca o do backend", () => {
    const mapped = resetPasswordError(axiosError(418, "ALGO_NOVO"))
    expect(mapped.kind).toBe("form")
    expect(mapped.message).not.toContain("texto do backend")
  })
})

describe("aviso 'senha alterada' (estado de rota)", () => {
  it("só o estado `{ flash: 'password-reset' }` conta", () => {
    expect(isPasswordResetFlash({ flash: "password-reset" })).toBe(true)
    for (const state of [null, undefined, {}, { flash: "outro" }, "password-reset", { justCompleted: true }]) expect(isPasswordResetFlash(state)).toBe(false)
  })
})
