import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from "axios"
import { api, TOKEN_STORAGE_KEY } from "./api"

/**
 * Contrato do interceptor de resposta: SÓ o 401 (fora das rotas de acesso)
 * desloga. 429 (limite de tentativas) e 403 `INVALID_CURRENT_PASSWORD` NUNCA
 * podem limpar a sessão nem redirecionar — o backend escolheu esses status
 * justamente por isso (ver comentário em `api.ts` e `ChangePasswordRequest`).
 */

/** Faz a próxima chamada do `api` falhar com este status/corpo, sem rede nem MSW. */
function failNextWith(status: number, data: { error: string; code: string }) {
  const adapter: AxiosAdapter = (config: InternalAxiosRequestConfig) => {
    const response = { status, statusText: "", data, headers: {}, config } as AxiosResponse
    return Promise.reject(new AxiosError(`HTTP ${status}`, "ERR_BAD_REQUEST", config, undefined, response))
  }
  api.defaults.adapter = adapter
}

const hrefSetter = vi.fn()

beforeEach(() => {
  localStorage.setItem(TOKEN_STORAGE_KEY, "token-de-sessao-valida")
  hrefSetter.mockReset()
  // jsdom não navega; observamos a tentativa de hard-redirect pelo setter de `href`.
  vi.stubGlobal("location", {
    pathname: "/app/carteira",
    search: "",
    set href(value: string) {
      hrefSetter(value)
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  api.defaults.adapter = undefined
})

describe("interceptor de resposta do api", () => {
  it.each([
    ["429 RATE_LIMITED_ACCOUNT (login, por conta)", 429, "RATE_LIMITED_ACCOUNT", "/api/auth/login"],
    ["429 RATE_LIMITED_AUTH (por IP)", 429, "RATE_LIMITED_AUTH", "/api/auth/login"],
    ["429 RATE_LIMITED_PASSWORD (troca de senha, por usuário)", 429, "RATE_LIMITED_PASSWORD", "/api/auth/password"],
    ["429 em rota autenticada qualquer", 429, "RATE_LIMITED", "/api/admin/sites"],
    ["403 INVALID_CURRENT_PASSWORD (troca de senha)", 403, "INVALID_CURRENT_PASSWORD", "/api/auth/password"],
  ])("%s: rejeita o erro SEM limpar a sessão e SEM redirecionar", async (_nome, status, code, url) => {
    failNextWith(status, { error: "x", code })
    await expect(api.post(url, {})).rejects.toMatchObject({ response: { status } })
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("token-de-sessao-valida")
    expect(hrefSetter).not.toHaveBeenCalled()
  })

  it("401 em rota comum continua sendo sessão expirada: limpa o token e manda pro login com ?redirect=", async () => {
    failNextWith(401, { error: "Sessão expirada.", code: "UNAUTHORIZED" })
    await expect(api.get("/api/me/wallet")).rejects.toBeDefined()
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull()
    expect(hrefSetter).toHaveBeenCalledWith("/login?redirect=%2Fapp%2Fcarteira")
  })

  it("401 de um pedido que saiu com token JÁ TROCADO (troca de senha em voo) não desloga a sessão nova", async () => {
    // O pedido sai com "token-de-sessao-valida"; antes da resposta chegar, a troca de senha grava o token novo.
    const adapter: AxiosAdapter = (config: InternalAxiosRequestConfig) => {
      localStorage.setItem(TOKEN_STORAGE_KEY, "token-novo-da-troca-de-senha")
      const response = { status: 401, statusText: "", data: { error: "x", code: "UNAUTHORIZED" }, headers: {}, config } as AxiosResponse
      return Promise.reject(new AxiosError("HTTP 401", "ERR_BAD_REQUEST", config, undefined, response))
    }
    api.defaults.adapter = adapter
    await expect(api.get("/api/me/sessions/active")).rejects.toBeDefined()
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("token-novo-da-troca-de-senha")
    expect(hrefSetter).not.toHaveBeenCalled()
  })

  it("401 das rotas de acesso (senha errada no login) não expulsa ninguém", async () => {
    failNextWith(401, { error: "E-mail ou senha inválidos.", code: "INVALID_CREDENTIALS" })
    await expect(api.post("/api/auth/login", {})).rejects.toBeDefined()
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("token-de-sessao-valida")
    expect(hrefSetter).not.toHaveBeenCalled()
  })
})
