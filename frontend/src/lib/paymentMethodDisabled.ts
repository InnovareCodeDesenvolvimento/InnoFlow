import axios from "axios"
import type { ApiErrorBody, PaymentMethodDisabledDetail } from "@/types/api"

/**
 * `PAYMENT_METHOD_DISABLED` (409) tem DOIS sentidos nas rotas do motorista
 * (contrato em `types/api.ts`, `PaymentMethodDisabledDetail`):
 *  - sem `details[0].reason`: o CARTÃO escolhido foi removido/desativado pelo
 *    próprio motorista -> pedir outro cartão (comportamento de sempre);
 *  - `details: [{ method, reason: "GATEWAY_DISABLED" }]`: o ADMIN desligou o
 *    MEIO inteiro (cartão ou Pix) na configuração do gateway -> avisar
 *    "indisponível no momento" e NÃO pedir "escolha outro cartão".
 *
 * Funções PURAS (sem DOM/rede): é o que dá para provar com teste unitário.
 */

/** Lê `details[0]` e devolve o detalhe só se for o sentido "gateway desligado". Qualquer outra forma (ausente, vazio, `reason` desconhecido, lixo) => `null`. */
export function parseGatewayDisabledDetail(details: unknown): PaymentMethodDisabledDetail | null {
  if (!Array.isArray(details)) return null
  const first: unknown = details[0]
  if (!first || typeof first !== "object") return null
  const { method, reason } = first as { method?: unknown; reason?: unknown }
  if (reason !== "GATEWAY_DISABLED") return null
  return { method: method === "PIX" ? "PIX" : "CARD", reason: "GATEWAY_DISABLED" }
}

/** `true` só para o 409 `PAYMENT_METHOD_DISABLED` com `details[0].reason === "GATEWAY_DISABLED"` (o admin desligou o meio). */
export function isGatewayDisabledError(err: unknown): boolean {
  if (!axios.isAxiosError<ApiErrorBody>(err)) return false
  const body = err.response?.data
  return body?.code === "PAYMENT_METHOD_DISABLED" && parseGatewayDisabledDetail(body.details) !== null
}

/** Textos por tela — o motorista nunca vê "gateway": só que o meio está indisponível agora. */
export const CARD_GATEWAY_DISABLED_START_MESSAGE = "Pagamento com cartão indisponível no momento. Use a carteira."
export const CARD_GATEWAY_DISABLED_ADD_MESSAGE = "O cadastro de cartão está indisponível no momento."
export const PIX_GATEWAY_DISABLED_MESSAGE = "O Pix está indisponível no momento. Tente mais tarde."
