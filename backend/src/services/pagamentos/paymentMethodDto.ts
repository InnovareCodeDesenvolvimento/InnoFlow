import type { PaymentMethod } from '@prisma/client'
import { decifrarSegredoOuNull } from '../../lib/crypto/paymentSecrets'

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
  /**
   * `true` = o token do cartão salvo NÃO decifra mais (o `JWT_SECRET` do servidor mudou: a chave dos segredos é derivada dele). O cartão não pode ser usado: a tela deve pedir "cadastre o cartão
   * novamente" (e deixar remover o antigo). Iniciar sessão com ele responde 409 `PAYMENT_METHOD_UNREADABLE`. Campo ADITIVO (decisão do dono 05/10/2026: chave derivada do JWT_SECRET, como no InnoChat).
   */
  unreadable: boolean
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
    unreadable: decifrarSegredoOuNull(row.cieloCardTokenCiphertext) === null,
  }
}
