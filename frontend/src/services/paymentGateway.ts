import { api } from "./api"
import type { PaymentGatewayConfigDTO, UpdatePaymentGatewayConfigRequest } from "@/types/api"

/**
 * `GET/PUT /api/admin/payment-gateway` — configuração da conta Cielo da
 * plataforma (F5.5). ADMIN-only (403 `FORBIDDEN` para OPERATOR). Segredos são
 * só de escrita: o GET devolve `...Set: boolean`, nunca o valor.
 */
export const paymentGatewayService = {
  async get(): Promise<PaymentGatewayConfigDTO> {
    const { data } = await api.get<PaymentGatewayConfigDTO>("/api/admin/payment-gateway")
    return data
  },

  /** Envia SÓ o que mudou. Devolve o DTO já atualizado. Erros por `code`: ver `parseGatewaySaveError`. */
  async update(payload: UpdatePaymentGatewayConfigRequest): Promise<PaymentGatewayConfigDTO> {
    const { data } = await api.put<PaymentGatewayConfigDTO>("/api/admin/payment-gateway", payload)
    return data
  },
}
