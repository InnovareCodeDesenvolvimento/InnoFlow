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
  // 16 a 40 caracteres (Órion A1, 2026-09-19): é a ÚNICA credencial do carregador na internet (a
  // identidade é pública) — 8 era adivinhável. 40 = teto confortável abaixo do limite de 72 bytes
  // do bcrypt (que trunca em silêncio), mesmo com caracteres multibyte.
  basicAuthSecret: z
    .string()
    .min(16)
    .max(40)
    .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, { message: 'no máximo 72 bytes' }),
})

export const updateChargePointSchema = createChargePointSchema
  .omit({ siteId: true, ocppIdentity: true })
  .partial()
  .extend({ active: z.boolean().optional() })

export type CreateChargePointInput = z.infer<typeof createChargePointSchema>
export type UpdateChargePointInput = z.infer<typeof updateChargePointSchema>
