/**
 * Ping de validação da URL de notificação (C1.4, fato F26/F28). Ao SALVAR a URL no Site Cielo (E-commerce > Gestão API E-commerce >
 * Configurações), a Cielo faz um POST de teste que chega SEM `PaymentId`/`ChangeType`; se a resposta não for 200 a URL não é aceita.
 * Mesma regra do Parque das Feiras (`interpretarNotificacao`: sem `PaymentId` ou sem `ChangeType` => "sem dados" => 200): não há o que
 * processar, e responder erro só provocaria retentativa (a Cielo repete de 30 em 30 min, 3 vezes).
 *
 * Pura, sem Express/Prisma. Quem chama decide a ORDEM (conferir o token do caminho primeiro; ver `webhooksCielo.routes.ts`).
 * Um `PaymentId` PRESENTE porém malformado (não é texto, longo demais) NÃO é ping: segue para a validação do schema e dá 400.
 */
export function ehPingDeValidacaoDaCielo(corpo: unknown): boolean {
  if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo)) return true
  const { PaymentId, ChangeType } = corpo as Record<string, unknown>
  const semPaymentId = PaymentId === undefined || PaymentId === null || (typeof PaymentId === 'string' && PaymentId.trim() === '')
  const semChangeType = ChangeType === undefined || ChangeType === null
  return semPaymentId || semChangeType
}
