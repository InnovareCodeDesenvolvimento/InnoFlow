import { z } from 'zod'

export const createChargePointSchema = z.object({
  siteId: z.string().cuid(),
  ocppIdentity: z.string().trim().min(1).max(50),
  vendor: z.string().trim().max(50).optional(),
  model: z.string().trim().max(50).optional(),
  serialNumber: z.string().trim().max(50).optional(),
  firmwareVersion: z.string().trim().max(50).optional(),
  // Segredo em texto puro só na ENTRADA desta rota — vira hash bcrypt antes
  // de tocar o banco, nunca é persistido nem devolvido em claro.
  basicAuthSecret: z.string().min(8).max(100),
})

export const updateChargePointSchema = createChargePointSchema
  .omit({ siteId: true, ocppIdentity: true })
  .partial()
  .extend({ active: z.boolean().optional() })

export type CreateChargePointInput = z.infer<typeof createChargePointSchema>
export type UpdateChargePointInput = z.infer<typeof updateChargePointSchema>
