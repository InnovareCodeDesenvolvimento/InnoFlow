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
 *  - `details: [{ method, reason: "SANDBOX_RESTRICTED" }]` (F5.7): servidor de
 *    produção em ambiente SANDBOX e este motorista não está na lista de
 *    testadores. Cai no MESMO ramo de `GATEWAY_DISABLED`, com as mesmas
 *    mensagens: o motorista NUNCA fica sabendo que existe restrição por
 *    testador (revelar o motivo só ajudaria quem quer cobrança de graça).
 *
 * Funções PURAS (sem DOM/rede): é o que dá para provar com teste unitário.
 */

/** `reason`s que significam "este meio está indisponível AGORA para você" (mesmo tratamento na UI). */
const UNAVAILABLE_REASONS: ReadonlySet<unknown> = new Set<PaymentMethodDisabledDetail["reason"]>(["GATEWAY_DISABLED", "SANDBOX_RESTRICTED"])

/** Lê `details[0]` e devolve o detalhe só se for o sentido "meio indisponível" (gateway desligado OU sandbox restrito). Qualquer outra forma (ausente, vazio, `reason` desconhecido, lixo) => `null`. */
export function parseGatewayDisabledDetail(details: unknown): PaymentMethodDisabledDetail | null {
  if (!Array.isArray(details)) return null
  const first: unknown = details[0]
  if (!first || typeof first !== "object") return null
  const { method, reason } = first as { method?: unknown; reason?: unknown }
  if (!UNAVAILABLE_REASONS.has(reason)) return null
  return { method: method === "PIX" ? "PIX" : "CARD", reason: reason as PaymentMethodDisabledDetail["reason"] }
}

/** `true` só para o 409 `PAYMENT_METHOD_DISABLED` com `details[0].reason` `GATEWAY_DISABLED` (o admin desligou o meio) ou `SANDBOX_RESTRICTED` (sandbox em produção, fora da lista de testadores). */
export function isGatewayDisabledError(err: unknown): boolean {
  if (!axios.isAxiosError<ApiErrorBody>(err)) return false
  const body = err.response?.data
  return body?.code === "PAYMENT_METHOD_DISABLED" && parseGatewayDisabledDetail(body.details) !== null
}

/** Textos por tela — o motorista nunca vê "gateway": só que o meio está indisponível agora. */
export const CARD_GATEWAY_DISABLED_START_MESSAGE = "Pagamento com cartão indisponível no momento. Use a carteira."
export const CARD_GATEWAY_DISABLED_ADD_MESSAGE = "O cadastro de cartão está indisponível no momento."
export const PIX_GATEWAY_DISABLED_MESSAGE = "O Pix está indisponível no momento. Tente mais tarde."
