import axios from "axios"
import type { ApiErrorBody } from "@/types/api"

/**
 * Base da API:
 *  1) VITE_API_URL explícita (produção, domínio próprio da API);
 *  2) sem env → caminho relativo `/api...`, que em dev cai no proxy do Vite
 *     (ver vite.config.ts, já aponta para VITE_DEV_API_TARGET) e em produção
 *     cai no mesmo domínio do site (nginx/reverse proxy resolve).
 */
export const API_BASE_URL = import.meta.env.VITE_API_URL || ""

export const TOKEN_STORAGE_KEY = "innoelektron_token"

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
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url: string = error?.config?.url ?? ""
    const isAuthRoute = url.includes("/api/auth/login") || url.includes("/api/auth/register")
    if (error?.response?.status === 401 && !isAuthRoute) {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
      if (!window.location.pathname.startsWith("/login")) {
        const redirect = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.href = `/login?redirect=${redirect}`
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

/** Código do erro (`err.response.data.code`), para tratar casos específicos por código em vez de por texto. */
export function getApiErrorCode(err: unknown): string | undefined {
  if (axios.isAxiosError<ApiErrorBody>(err)) {
    return err.response?.data?.code
  }
  return undefined
}
