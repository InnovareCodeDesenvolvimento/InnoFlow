import { api } from "./api"
import type {
  CreateTariffAssignmentInput,
  PaginatedResponse,
  TariffAssignment,
  TariffAssignmentListParams,
  UpdateTariffAssignmentInput,
} from "@/types/api"

/**
 * `/api/admin/tariff-assignments` (OPERATOR + ADMIN; `backend/src/api/routes/tariffAssignments.routes.ts`).
 * `DELETE` é soft: responde 204 e a linha continua existindo com `validTo = agora` (aparece na listagem como encerrada).
 */
export const tariffAssignmentsService = {
  async list(params: TariffAssignmentListParams = {}): Promise<PaginatedResponse<TariffAssignment>> {
    const { data } = await api.get<PaginatedResponse<TariffAssignment>>("/api/admin/tariff-assignments", { params })
    return data
  },

  async create(payload: CreateTariffAssignmentInput): Promise<TariffAssignment> {
    const { data } = await api.post<TariffAssignment>("/api/admin/tariff-assignments", payload)
    return data
  },

  async update(id: string, payload: UpdateTariffAssignmentInput): Promise<TariffAssignment> {
    const { data } = await api.patch<TariffAssignment>(`/api/admin/tariff-assignments/${id}`, payload)
    return data
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/api/admin/tariff-assignments/${id}`)
  },
}
