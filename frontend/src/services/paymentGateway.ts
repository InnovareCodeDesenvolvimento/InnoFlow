import { api } from "./api"
import type { PaymentGatewayConfigDTO, PaymentGatewayTestResult, UpdatePaymentGatewayConfigRequest } from "@/types/api"

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

  /** `POST /api/admin/payment-gateway/test-connection` - sem corpo; sempre 200 com o resultado por passo (credencial errada é RESULTADO, não erro HTTP). */
  async testConnection(): Promise<PaymentGatewayTestResult> {
    const { data } = await api.post<PaymentGatewayTestResult>("/api/admin/payment-gateway/test-connection")
    return data
  },
}
