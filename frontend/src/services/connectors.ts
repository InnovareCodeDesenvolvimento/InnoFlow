import { api } from "./api"
import type { Connector, CreateConnectorInput, PaginatedResponse, PaginationParams, UpdateConnectorInput } from "@/types/api"

export const connectorsService = {
  async list(params: PaginationParams = {}): Promise<PaginatedResponse<Connector>> {
    const { data } = await api.get<PaginatedResponse<Connector>>("/api/admin/connectors", { params })
    return data
  },

  async get(id: string): Promise<Connector> {
    const { data } = await api.get<Connector>(`/api/admin/connectors/${id}`)
    return data
  },

  async create(payload: CreateConnectorInput): Promise<Connector> {
    const { data } = await api.post<Connector>("/api/admin/connectors", payload)
    return data
  },

  async update(id: string, payload: UpdateConnectorInput): Promise<Connector> {
    const { data } = await api.patch<Connector>(`/api/admin/connectors/${id}`, payload)
    return data
  },

  /** Soft "delete": o backend marca `status: UNAVAILABLE` (Connector não tem coluna `active`). */
  async remove(id: string): Promise<void> {
    await api.delete(`/api/admin/connectors/${id}`)
  },
}
