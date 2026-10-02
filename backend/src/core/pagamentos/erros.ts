/**
 * Erros de domínio do fluxo de pagamento que a camada de rota precisa
 * distinguir por TIPO (não por mensagem) para responder com o `code` certo
 * (contrato `MePaymentMethodErrorCode`, ver `frontend/src/types/api.ts`).
 * Puro — sem Prisma, sem HTTP (mesma regra de `core/` do resto do módulo).
 */

/**
 * Produção sem credenciais da Cielo (e sem opt-in para o simulador): o gateway de
 * pagamento está indisponível por CONFIGURAÇÃO. As rotas já convertem qualquer erro
 * do resolvedor em 503 `PAYMENT_GATEWAY_UNAVAILABLE` — nunca fingem que cobraram.
 */
export class GatewayPagamentoNaoConfiguradoError extends Error {
  constructor() {
    super('Gateway de pagamento não configurado: defina CIELO_MERCHANT_ID e CIELO_MERCHANT_KEY (ou PAYMENT_ALLOW_FAKE_ADAPTER=true só para demonstração, sem cobrança real).')
    this.name = 'GatewayPagamentoNaoConfiguradoError'
  }
}

/** `GET /1/card/{token}` (Cielo) devolveu "token desconhecido"/"inválido" — nunca confundir com timeout/erro de rede (`CARD_VERIFICATION_FAILED`). */
export class CartaoTokenInvalidoError extends Error {
  constructor(cardTokenMascarado: string) {
    super(`CardToken inválido/desconhecido na Cielo: ${cardTokenMascarado}`)
    this.name = 'CartaoTokenInvalidoError'
  }
}
