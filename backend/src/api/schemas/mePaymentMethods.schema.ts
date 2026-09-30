import { z } from 'zod'

/**
 * `POST /api/me/payment-methods` (F5.3, cadastro de cartão — D1: SAQ A-EP).
 * `cardToken` é o CardToken PERMANENTE que a página isolada da Lyra recebe
 * DIRETO da Cielo (Silent Order Post) — nunca passa pelo nosso backend antes
 * disto. `brand` vem do resultado da tokenização no navegador; o backend
 * ainda VALIDA o token contra a Cielo (`consultarCartaoTokenizado`) antes de
 * gravar — ver rota.
 */
export const CARD_BRANDS = ['Visa', 'Master', 'Elo', 'Amex', 'Hipercard', 'Diners'] as const
export type CardBrand = (typeof CARD_BRANDS)[number]

export const meCreatePaymentMethodSchema = z.object({
  cardToken: z.string().trim().min(1),
  brand: z.enum(CARD_BRANDS),
  makeDefault: z.boolean().optional(),
})
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
