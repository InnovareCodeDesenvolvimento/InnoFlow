import { z } from 'zod'

export const createSiteSchema = z.object({
  // Só usado quando quem cria é ADMIN — OPERATOR sempre usa o próprio
  // operatorId, mesmo que mande outro aqui (ver resolveOperatorIdForWrite).
  operatorId: z.string().cuid().optional(),
  name: z.string().trim().min(1).max(150),
  addressLine: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().length(2),
  postalCode: z.string().trim().min(5).max(12),
  country: z.string().trim().length(2).default('BR'),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  timezone: z.string().trim().min(1).max(60).default('America/Sao_Paulo'),
  openingHours: z.record(z.string()).optional(),
})

export const updateSiteSchema = createSiteSchema.omit({ operatorId: true }).partial().extend({
  active: z.boolean().optional(),
})

export type CreateSiteInput = z.infer<typeof createSiteSchema>
export type UpdateSiteInput = z.infer<typeof updateSiteSchema>
