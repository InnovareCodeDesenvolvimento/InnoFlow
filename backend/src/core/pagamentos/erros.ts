/**
 * Erros de domínio do fluxo de pagamento que a camada de rota precisa
 * distinguir por TIPO (não por mensagem) para responder com o `code` certo
 * (contrato `MePaymentMethodErrorCode`, ver `frontend/src/types/api.ts`).
 * Puro — sem Prisma, sem HTTP (mesma regra de `core/` do resto do módulo).
 */

/** `GET /1/card/{token}` (Cielo) devolveu "token desconhecido"/"inválido" — nunca confundir com timeout/erro de rede (`CARD_VERIFICATION_FAILED`). */
export class CartaoTokenInvalidoError extends Error {
  constructor(cardTokenMascarado: string) {
    super(`CardToken inválido/desconhecido na Cielo: ${cardTokenMascarado}`)
    this.name = 'CartaoTokenInvalidoError'
  }
}
