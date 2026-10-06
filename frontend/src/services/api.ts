import axios from "axios"
import type { ApiErrorBody } from "@/types/api"
import { TOKEN_STORAGE_KEY } from "@/lib/storageKeys"
import { rememberReturnTo } from "@/lib/authRedirect"

/**
 * Base da API:
 *  1) VITE_API_URL explícita (produção, domínio próprio da API);
 *  2) sem env → caminho relativo `/api...`, que em dev cai no proxy do Vite
 *     (ver vite.config.ts, já aponta para VITE_DEV_API_TARGET) e em produção
 *     cai no mesmo domínio do site (nginx/reverse proxy resolve).
 */
export const API_BASE_URL = import.meta.env.VITE_API_URL || ""

// Definida em `lib/storageKeys` (módulo minúsculo, ver lá); reexportada para quem já importa daqui.
export { TOKEN_STORAGE_KEY }

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Backend não tem refresh token (sem /api/auth/refresh) — um 401 aqui é
// sempre "sessão inválida/expirada" de verdade, não algo a tentar renovar.
// Limpa a sessão e manda para o login, exceto quando o 401 já é da PRÓPRIA
// tentativa de login (senha errada não deve expulsar ninguém de lugar nenhum).
//
// SÓ o 401 desloga. Isto é contrato, não acaso — o backend escolhe o status
// de propósito para não expulsar ninguém por erro "de formulário":
//  - 429 (`RATE_LIMITED_AUTH` por IP, `RATE_LIMITED_ACCOUNT` por conta,
//    `RATE_LIMITED_PASSWORD` por usuário): "espere um pouco", a sessão segue
//    válida — NUNCA limpar token nem redirecionar.
//  - 403 `INVALID_CURRENT_PASSWORD` (`POST /api/auth/password`): senha atual
//    errada é 403 e não 401 justamente para passar por aqui sem deslogar.
// Coberto por `api.test.ts`.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url: string = error?.config?.url ?? ""
    // `/api/auth/google` também: `INVALID_GOOGLE_TOKEN` volta como 401 e, sem
    // isto, estando em `/cadastro` o interceptor daria hard-redirect pro login
    // e engoliria a mensagem de erro (mesma lógica da senha errada no login).
    const isAuthRoute = url.includes("/api/auth/login") || url.includes("/api/auth/register") || url.includes("/api/auth/google")
    // 401 de um pedido que saiu com um token que JÁ FOI TROCADO (o do `POST /api/auth/password` revoga todos e devolve um novo; um polling em voo pode ter
    // saído com o antigo) não é "sessão expirada": a sessão atual é outra e está válida. Sem esta guarda, a troca de senha deslogaria quem acabou de trocá-la.
    const sentToken = String(error?.config?.headers?.Authorization ?? "").replace(/^Bearer /, "")
    const currentToken = localStorage.getItem(TOKEN_STORAGE_KEY)
    const isStaleToken = sentToken !== "" && currentToken !== null && sentToken !== currentToken
    // `INVALID_GOOGLE_TOKEN` é a credencial do GOOGLE recusada (reautenticação da exclusão de conta, `POST /api/me/account/deletion`), não a sessão do app: a sessão segue válida e
    // a tela precisa mostrar o erro. Só ESTE código passa; um 401 `UNAUTHORIZED` na mesma rota continua sendo sessão expirada.
    const isGoogleCredentialRejected = error?.response?.data?.code === "INVALID_GOOGLE_TOKEN"
    if (error?.response?.status === 401 && !isAuthRoute && !isStaleToken && !isGoogleCredentialRejected) {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
      if (!window.location.pathname.startsWith("/login")) {
        // Hard redirect (perde o estado da SPA): o destino de retorno vai para o `sessionStorage` e o `/login` fica limpo.
        rememberReturnTo(window.location.pathname + window.location.search)
        window.location.href = "/login"
      }
    }
    return Promise.reject(error)
  },
)

/** Extrai a mensagem amigável de um erro do axios batendo no envelope `{error, code, details?}` da API. */
export function getApiErrorMessage(err: unknown, fallback = "Não foi possível completar a ação. Tente novamente."): string {
  if (axios.isAxiosError<ApiErrorBody>(err)) {
    return err.response?.data?.error ?? fallback
  }
  return fallback
}

/** Status HTTP do erro (`undefined` = sem resposta: rede caiu, timeout, CORS). */
export function getApiErrorStatus(err: unknown): number | undefined {
  if (axios.isAxiosError(err)) {
    return err.response?.status
  }
  return undefined
}

/** Código do erro (`err.response.data.code`), para tratar casos específicos por código em vez de por texto. */
export function getApiErrorCode(err: unknown): string | undefined {
  if (axios.isAxiosError<ApiErrorBody>(err)) {
    return err.response?.data?.code
  }
  return undefined
}

/** Mensagens por campo do 400 `VALIDATION_ERROR` (`details: [{ path, message }]`). Vazio quando o erro não é de validação. */
export function getApiErrorDetails(err: unknown): string[] {
  if (axios.isAxiosError<ApiErrorBody>(err)) {
    return (err.response?.data?.details ?? []).map((d) => d.message).filter((m): m is string => typeof m === "string" && m.length > 0)
  }
  return []
}
