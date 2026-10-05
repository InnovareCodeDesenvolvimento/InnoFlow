import { api } from "./api"
import type { AdminAccountDeletionRefundRequest, AdminAccountDeletionRow, AdminAccountDeletionsQuery, PaginatedResponse } from "@/types/api"

/**
 * `GET/POST /api/admin/account-deletions*` (L1.4, ADMIN-only) — a fila de devolução do saldo de quem excluiu a conta. O GET traz a chave Pix DECIFRADA dos pedidos pendentes
 * e cada leitura é AUDITADA no backend (`pix_refund_keys_viewed`): por isso o hook não refaz sozinho.
 */
export const accountDeletionsService = {
  async list(params: AdminAccountDeletionsQuery): Promise<PaginatedResponse<AdminAccountDeletionRow>> {
    const { data } = await api.get<PaginatedResponse<AdminAccountDeletionRow>>("/api/admin/account-deletions", { params })
    return data
  },

  /** Valor INTEGRAL do saldo do pedido + comprovante do Pix feito por fora + senha. Apaga a chave Pix guardada. */
  async refund(requestId: string, payload: AdminAccountDeletionRefundRequest): Promise<AdminAccountDeletionRow> {
    const { data } = await api.post<AdminAccountDeletionRow>(`/api/admin/account-deletions/${encodeURIComponent(requestId)}/refund`, payload)
    return data
  },
}
