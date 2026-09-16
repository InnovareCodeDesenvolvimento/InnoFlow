import { api } from "./api"
import type { CreateTariffInput, PaginatedResponse, PaginationParams, Tariff, UpdateTariffInput } from "@/types/api"

export const tariffsService = {
  async list(params: PaginationParams = {}): Promise<PaginatedResponse<Tariff>> {
    const { data } = await api.get<PaginatedResponse<Tariff>>("/api/admin/tariffs", { params })
    return data
  },

  async get(id: string): Promise<Tariff> {
    const { data } = await api.get<Tariff>(`/api/admin/tariffs/${id}`)
    return data
  },

  async create(payload: CreateTariffInput): Promise<Tariff> {
    const { data } = await api.post<Tariff>("/api/admin/tariffs", payload)
    return data
  },

  async update(id: string, payload: UpdateTariffInput): Promise<Tariff> {
    const { data } = await api.patch<Tariff>(`/api/admin/tariffs/${id}`, payload)
    return data
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/api/admin/tariffs/${id}`)
  },
}
