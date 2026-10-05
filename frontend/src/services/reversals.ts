import { api } from "./api"
import type {
  CancelRefundRequest,
  CancelRefundResponse,
  ChargebackDTO,
  ChargebackDossier,
  ChargebacksListQuery,
  ChargebacksListResponse,
  ConfirmRefundRequest,
  ConfirmRefundResponse,
  CreateChargebackRequest,
  CreateChargebackResponse,
  CreateSessionRefundRequest,
  CreateSessionRefundResponse,
  SessionRefundsResponse,
  UnblockCardRequest,
  UpdateChargebackRequest,
} from "@/types/api"

/**
 * Estorno de sessão e chargeback (L1.8) — TUDO ADMIN-only. Nenhuma rota fala com a Cielo (DL8): o ADMIN faz a devolução no portal e REGISTRA aqui. As escritas com senha
 * (`currentPassword`) NUNCA são repetidas por reflexo: um 403/429 não grava nada, e a tela devolve o foco ao campo de senha.
 */
export const reversalsService = {
  /** `GET /api/admin/sessions/:id/refunds` — o que a sessão cobrou, o que já foi estornado e quanto ainda dá. */
  async sessionRefunds(sessionId: string): Promise<SessionRefundsResponse> {
    const { data } = await api.get<SessionRefundsResponse>(`/api/admin/sessions/${encodeURIComponent(sessionId)}/refunds`)
    return data
  },

  async createRefund(sessionId: string, payload: CreateSessionRefundRequest): Promise<CreateSessionRefundResponse> {
    const { data } = await api.post<CreateSessionRefundResponse>(`/api/admin/sessions/${encodeURIComponent(sessionId)}/refunds`, payload)
    return data
  },

  async cancelRefund(refundId: string, payload: CancelRefundRequest): Promise<CancelRefundResponse> {
    const { data } = await api.post<CancelRefundResponse>(`/api/admin/refunds/${encodeURIComponent(refundId)}/cancel`, payload)
    return data
  },

  async confirmRefund(refundId: string, payload: ConfirmRefundRequest): Promise<ConfirmRefundResponse> {
    const { data } = await api.post<ConfirmRefundResponse>(`/api/admin/refunds/${encodeURIComponent(refundId)}/confirm`, payload)
    return data
  },

  /** `POST /api/admin/payments/:intentId/chargebacks` — SEM senha (contrato): registrar abre o caso e já bloqueia o cartão do motorista. */
  async registerChargeback(paymentIntentId: string, payload: CreateChargebackRequest): Promise<CreateChargebackResponse> {
    const { data } = await api.post<CreateChargebackResponse>(`/api/admin/payments/${encodeURIComponent(paymentIntentId)}/chargebacks`, payload)
    return data
  },

  async listChargebacks(params: ChargebacksListQuery): Promise<ChargebacksListResponse> {
    const { data } = await api.get<ChargebacksListResponse>("/api/admin/chargebacks", { params })
    return data
  },

  async resolveChargeback(chargebackId: string, payload: UpdateChargebackRequest): Promise<ChargebackDTO> {
    const { data } = await api.patch<ChargebackDTO>(`/api/admin/chargebacks/${encodeURIComponent(chargebackId)}`, payload)
    return data
  },

  async unblockCard(chargebackId: string, payload: UnblockCardRequest): Promise<ChargebackDTO> {
    const { data } = await api.post<ChargebackDTO>(`/api/admin/chargebacks/${encodeURIComponent(chargebackId)}/unblock-card`, payload)
    return data
  },

  /** Cada GET do dossiê é AUDITADO no backend: só é chamado quando o ADMIN clica em "Baixar" (nunca por query/refetch). */
  async dossier(chargebackId: string): Promise<ChargebackDossier> {
    const { data } = await api.get<ChargebackDossier>(`/api/admin/chargebacks/${encodeURIComponent(chargebackId)}/dossier`)
    return data
  },
}
