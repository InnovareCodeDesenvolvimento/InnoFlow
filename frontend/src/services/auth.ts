import { api } from "./api"
import type { AuthResponse } from "@/types/api"

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
}
