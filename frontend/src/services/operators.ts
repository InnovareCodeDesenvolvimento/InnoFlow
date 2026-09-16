import { api } from "./api"
import type { Operator, PaginatedResponse } from "@/types/api"

/** `GET /api/admin/operators` — ADMIN only (fecha a pendência deixada na F3c: antes disso não havia rota de listagem). */
export const operatorsService = {
  async list(): Promise<PaginatedResponse<Operator>> {
    const { data } = await api.get<PaginatedResponse<Operator>>("/api/admin/operators", { params: { pageSize: 100 } })
    return data
  },
}
