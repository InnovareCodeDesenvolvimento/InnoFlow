import { z } from 'zod'

export const tariffModelEnum = z.enum(['PER_KWH', 'PER_MINUTE', 'PER_SESSION', 'HYBRID'])

export const createTariffSchema = z.object({
  operatorId: z.string().cuid().optional(), // idem site.schema — só para ADMIN
  name: z.string().trim().min(1).max(100),
  model: tariffModelEnum,
  // Preço unitário em REAIS (não centavos) — bate com Tariff.pricePerKwh
  // Decimal(12,4) no schema do Cronos.
  pricePerKwh: z.coerce.number().min(0).optional(),
  pricePerMinute: z.coerce.number().min(0).optional(),
  sessionFeeCents: z.number().int().min(0).optional(),
  minChargeCents: z.number().int().min(0).optional(),
  idleFeePerMinute: z.number().int().min(0).default(0),
  idleGracePeriodSeconds: z.number().int().min(0).default(0),
  currency: z.string().trim().length(3).default('BRL'),
})

export const updateTariffSchema = createTariffSchema.omit({ operatorId: true }).partial().extend({
  active: z.boolean().optional(),
})

export type CreateTariffInput = z.infer<typeof createTariffSchema>
export type UpdateTariffInput = z.infer<typeof updateTariffSchema>
