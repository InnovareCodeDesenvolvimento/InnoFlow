/**
 * `MerchantOrderId` enviado à Cielo. A conta Cielo (EC) é COMPARTILHADA com o Parque das Feiras (decisão do dono, 04/10/2026): os dois sistemas gravam vendas no MESMO estabelecimento e a
 * consulta `GET /1/sales?merchantOrderId=` é por estabelecimento. O InnoFlow prefixa o id do intent com `IF-` ("InnoFlow") para o pedido nunca colidir com um id do Parque nem ser confundido
 * na reconciliação. Cabe nos 50 caracteres do campo (`IF-` + cuid de 25 = 28).
 *
 * O resto do sistema continua falando em `PaymentIntent.id`: o prefixo é posto na SAÍDA (payloads e consultas por pedido, em `cieloAdapter`/`cieloPayloads`) e tirado na ENTRADA (resultados),
 * então nenhum chamador vê o prefixo. Intents ANTIGOS (criados antes do prefixo) têm o id cru na Cielo: toda comparação aceita as DUAS formas, e a consulta por pedido tenta `IF-<id>` e depois o cru.
 */
export const PREFIXO_MERCHANT_ORDER_ID = 'IF-'
const LIMITE_MERCHANT_ORDER_ID = 50

/** Id do intent -> `MerchantOrderId` da Cielo. Se o prefixo estouraria os 50 caracteres, manda o id cru (nunca trunca). */
export function paraMerchantOrderIdDaCielo(intentId: string): string {
  if (intentId.startsWith(PREFIXO_MERCHANT_ORDER_ID)) return intentId
  const comPrefixo = `${PREFIXO_MERCHANT_ORDER_ID}${intentId}`
  return comPrefixo.length <= LIMITE_MERCHANT_ORDER_ID ? comPrefixo : intentId
}

/** `MerchantOrderId` da Cielo -> id do intent (tira o prefixo, se houver). */
export function intentIdDoMerchantOrderId(merchantOrderId: string): string {
  return merchantOrderId.startsWith(PREFIXO_MERCHANT_ORDER_ID) ? merchantOrderId.slice(PREFIXO_MERCHANT_ORDER_ID.length) : merchantOrderId
}

/** O `MerchantOrderId` devolvido pela Cielo pertence a este intent? Aceita a forma com prefixo e a antiga (sem). */
export function merchantOrderIdCorrespondeAoIntent(merchantOrderId: string, intentId: string): boolean {
  return merchantOrderId === intentId || merchantOrderId === paraMerchantOrderIdDaCielo(intentId)
}
