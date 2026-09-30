import type { PaymentIntent } from '@prisma/client'
import { mapearStatusTopup } from '../../core/pagamentos/mapearStatusTopup'

/** Contrato LITERAL de `frontend/src/types/api.ts` (`MeTopupDTO`) — mudar um lado sem o outro quebra o PWA do motorista em silêncio. */
export interface MeTopupDto {
  id: string
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED'
  amountCents: number
  qrCodeString: string | null
  qrCodeImageBase64: string | null
  expiresAt: string | null
  paidAt: string | null
  createdAt: string
  debtSettledCents: number
}

export function toMeTopupDto(intent: PaymentIntent, qrCodeImageBase64: string | null, debtSettledCents: number): MeTopupDto {
  return {
    id: intent.id,
    status: mapearStatusTopup(intent.status),
    amountCents: intent.amountRequestedCents,
    qrCodeString: intent.pixQrCode,
    qrCodeImageBase64,
    expiresAt: intent.pixExpiresAt ? intent.pixExpiresAt.toISOString() : null,
    // Reaproveita `capturedAt` (não há coluna `paidAt` dedicada — Pix não
    // tem etapa de "captura" separada como cartão, mas semanticamente é o
    // mesmo fato: "quando o dinheiro foi confirmado recebido").
    paidAt: intent.capturedAt ? intent.capturedAt.toISOString() : null,
    createdAt: intent.createdAt.toISOString(),
    debtSettledCents,
  }
}
