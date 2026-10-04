/**
 * Expiração do QR Pix `Cielo2` (C1.5): `Payment.QrCode.Expiration` em segundos, padrão E máximo 86400 (24 h) — acima disso a Cielo recusaria a
 * cobrança inteira. Pura: o payload (`cieloPayloads.ts`), o `expiresAt` do adaptador real e o do `FakeAdapter` usam ESTA conta, para a expiração
 * que mostramos ao motorista ser a mesma que a Cielo aplica.
 */
export const PIX_EXPIRES_MAX_SECONDS = 86_400

export function expiracaoPixEfetivaSegundos(expiresInSeconds: number | undefined): number {
  const pedido = expiresInSeconds === undefined || !Number.isFinite(expiresInSeconds) ? PIX_EXPIRES_MAX_SECONDS : Math.floor(expiresInSeconds)
  return Math.min(PIX_EXPIRES_MAX_SECONDS, Math.max(1, pedido))
}
