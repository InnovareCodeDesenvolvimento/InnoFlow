import type { PaymentMethod } from '@prisma/client'

/**
 * Contrato LITERAL de `frontend/src/types/api.ts` (`MePaymentMethodDTO`) —
 * mudar um lado sem o outro quebra o cadastro de cartão do PWA do motorista
 * em silêncio (mesmo espírito de `topupDto.ts`). NUNCA inclui
 * `cieloCardTokenCiphertext` (nem cifrado) — o cliente não precisa e não
 * deve receber de volta nada que identifique o token.
 */
export interface MePaymentMethodDto {
  id: string
  brand: string
  last4: string | null
  holderName: string | null
  expiryMonth: number | null
  expiryYear: number | null
  isDefault: boolean
  createdAt: string
}

export function toMePaymentMethodDto(row: PaymentMethod): MePaymentMethodDto {
  return {
    id: row.id,
    brand: row.brand ?? '',
    last4: row.last4,
    holderName: row.holderName,
    expiryMonth: row.expiryMonth,
    expiryYear: row.expiryYear,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
  }
}
