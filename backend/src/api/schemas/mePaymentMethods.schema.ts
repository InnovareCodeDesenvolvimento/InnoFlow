import { z } from 'zod'

/**
 * `POST /api/me/payment-methods` (F5.3, cadastro de cartão — D1: SAQ A-EP).
 * `cardToken` é o CardToken PERMANENTE que a página isolada da Lyra recebe
 * DIRETO da Cielo (Silent Order Post) — nunca passa pelo nosso backend antes
 * disto. `brand` vem do resultado da tokenização no navegador; o backend
 * consulta o token na Cielo (`consultarCartaoTokenizado`) só como ENRIQUECIMENTO de melhor esforço — ver rota.
 *
 * C1.3 (R2/F25): `GET /1/card/{token}` não está confirmado, então o cadastro NÃO depende dele. A página isolada envia `last4`, `expiryMonth` e
 * `expiryYear` (o script do SOP não devolve a bandeira nem o final; ela os conhece do que o motorista digitou). É PAN TRUNCADO (últimos 4) e a
 * validade — o PCI DSS permite guardar e transmitir; nunca o número inteiro nem o CVV (o schema é estrito para o PAN: só 4 dígitos). Os três são
 * opcionais por compatibilidade com a página anterior (que enviava só `cardToken` e `brand`); quando a Cielo devolver dados, os dela prevalecem.
 */
export const CARD_BRANDS = ['Visa', 'Master', 'Elo', 'Amex', 'Hipercard', 'Diners'] as const
export type CardBrand = (typeof CARD_BRANDS)[number]

/**
 * S-1 (auditoria): `cardToken` só pode ser o token do cofre da Cielo (GUID) — antes aceitava qualquer texto de até 256 caracteres, e um PAN inteiro passaria pela nossa API, seria cifrado e
 * enviado à Cielo, quebrando o escopo SAQ A-EP. Exceção controlada: o token do SOP SIMULADO da página isolada (`mocktok.<last4>.<MMAAAA>.<titular>.<selo>`), que só é válido com o
 * `FakeAdapter` ativo (a ROTA recusa `mocktok.*` com a Cielo real). Qualquer sequência de 13 a 19 dígitos (com ou sem separador) fora do selo do mock é recusada.
 */
const CARD_TOKEN_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CARD_TOKEN_MOCK_SOP = /^mocktok[.][0-9]{4}[.][0-9]{6}[.][A-Za-z0-9_=-]{0,200}[.][0-9]{1,24}$/
const SEQUENCIA_PARECIDA_COM_PAN = new RegExp('(?:[0-9][ -]?){13,19}')

export function cardTokenTemFormatoValido(token: string): boolean {
  if (CARD_TOKEN_GUID.test(token)) return true
  if (CARD_TOKEN_MOCK_SOP.test(token)) return true
  return false
}

/** `true` se o token é do SOP simulado (só aceito com o `FakeAdapter`). */
export function ehCardTokenDeMock(token: string): boolean {
  return token.startsWith('mocktok.')
}

export function pareceConterPan(token: string): boolean {
  return !CARD_TOKEN_MOCK_SOP.test(token) && SEQUENCIA_PARECIDA_COM_PAN.test(token)
}

export const meCreatePaymentMethodSchema = z
  .object({
    cardToken: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((t) => !pareceConterPan(t), { message: 'cardToken inválido' })
      .refine(cardTokenTemFormatoValido, { message: 'cardToken inválido: esperado o token do cofre da Cielo' }),
    brand: z.enum(CARD_BRANDS),
    makeDefault: z.boolean().optional(),
    /** Últimos 4 dígitos — exatamente 4 dígitos (um PAN inteiro ou lixo é recusado, nunca truncado em silêncio). */
    last4: z.string().regex(/^[0-9]{4}$/, 'last4 deve ter exatamente 4 dígitos').optional(),
    expiryMonth: z.number().int().min(1).max(12).optional(),
    /** Ano com 4 dígitos (a página normaliza para MM/AAAA, como o SOP exige). */
    expiryYear: z.number().int().min(2000).max(2200).optional(),
  })
  .refine((v) => (v.expiryMonth === undefined) === (v.expiryYear === undefined), { message: 'expiryMonth e expiryYear devem vir juntos', path: ['expiryYear'] })
export type MeCreatePaymentMethodInput = z.infer<typeof meCreatePaymentMethodSchema>

/**
 * `PATCH /api/me/payment-methods/:id` — só suporta MARCAR como padrão
 * (`isDefault: true`); não existe "desmarcar sem marcar outro" no contrato
 * (`frontend/src/types/api.ts`) — `z.literal(true)` reforça isso na entrada
 * em vez de aceitar `false` e não fazer nada.
 */
export const meUpdatePaymentMethodSchema = z.object({
  isDefault: z.literal(true),
})
export type MeUpdatePaymentMethodInput = z.infer<typeof meUpdatePaymentMethodSchema>
