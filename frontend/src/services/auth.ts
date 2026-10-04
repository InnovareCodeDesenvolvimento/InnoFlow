import { api } from "./api"
import type { AuthResponse, GoogleAuthRequest, LinkGoogleResponse } from "@/types/api"

export interface LoginPayload {
  email: string
  password: string
}

export interface RegisterPayload {
  name: string
  email: string
  password: string
  phone?: string
}

/**
 * `POST /api/auth/register` sempre cria um DRIVER — não existe rota pública
 * para criar ADMIN/OPERATOR (só via seed, ver PROGRESSO.md). Não construímos
 * tela para isso.
 */
export const authService = {
  async login(payload: LoginPayload): Promise<AuthResponse> {
    const { data } = await api.post<AuthResponse>("/api/auth/login", payload)
    return data
  },

  async register(payload: RegisterPayload): Promise<AuthResponse> {
    const { data } = await api.post<AuthResponse>("/api/auth/register", payload)
    return data
  },

  /**
   * `POST /api/auth/google` — cria conta de motorista (201) ou entra numa
   * existente (200); o formato de resposta é o mesmo, então o cliente não
   * distingue os dois. Só DRIVER (ADMIN/OPERATOR → 403 `GOOGLE_LOGIN_NOT_ALLOWED`).
   */
  async google(payload: GoogleAuthRequest): Promise<AuthResponse> {
    const { data } = await api.post<AuthResponse>("/api/auth/google", payload)
    return data
  },

  /**
   * `POST /api/auth/google/link` (AUTENTICADO) - vincula o Google à conta JÁ LOGADA. Não troca de conta, não zera a senha e não devolve token novo:
   * a sessão atual segue valendo. Só vincula se o e-mail verificado do Google for igual ao da conta. Erros: ver `LinkGoogleErrorCode`.
   */
  async linkGoogle(payload: GoogleAuthRequest): Promise<LinkGoogleResponse> {
    const { data } = await api.post<LinkGoogleResponse>("/api/auth/google/link", payload)
    return data
  },
}
