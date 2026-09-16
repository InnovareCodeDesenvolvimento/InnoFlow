import { api } from "./api"
import type { AuthToken, CreateAuthTokenInput, PaginatedResponse, PaginationParams, UpdateAuthTokenInput } from "@/types/api"

/**
 * `AuthToken` (RFID/app) não tem `operatorId` — é identidade de rede, igual
 * ao motorista (ver comentário em `authTokens.routes.ts`). Por isso a rota
 * inteira é restrita a `ADMIN`; `OPERATOR` recebe 403 e nem deve ver o item
 * de menu (ver `adminNav.ts`).
 */
export const authTokensService = {
  async list(params: PaginationParams = {}): Promise<PaginatedResponse<AuthToken>> {
    const { data } = await api.get<PaginatedResponse<AuthToken>>("/api/admin/auth-tokens", { params })
    return data
  },

  async get(id: string): Promise<AuthToken> {
    const { data } = await api.get<AuthToken>(`/api/admin/auth-tokens/${id}`)
    return data
  },

  async create(payload: CreateAuthTokenInput): Promise<AuthToken> {
    const { data } = await api.post<AuthToken>("/api/admin/auth-tokens", payload)
    return data
  },

  async update(id: string, payload: UpdateAuthTokenInput): Promise<AuthToken> {
    const { data } = await api.patch<AuthToken>(`/api/admin/auth-tokens/${id}`, payload)
    return data
  },

  /** Soft "delete": o backend marca `status: BLOCKED`. */
  async remove(id: string): Promise<void> {
    await api.delete(`/api/admin/auth-tokens/${id}`)
  },
}
