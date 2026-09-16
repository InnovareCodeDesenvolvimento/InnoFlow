import { z } from 'zod'

export const authTokenTypeEnum = z.enum(['RFID', 'VIRTUAL', 'APP'])
export const authTokenStatusEnum = z.enum(['ACCEPTED', 'BLOCKED', 'EXPIRED', 'INVALID'])

export const createAuthTokenSchema = z.object({
  // OCPP 1.6 limita idTag a 20 caracteres (mesma regra do schema do Cronos).
  idTag: z.string().trim().min(1).max(20),
  type: authTokenTypeEnum,
  userId: z.string().cuid().optional(),
  expiresAt: z.coerce.date().optional(),
})

export const updateAuthTokenSchema = z.object({
  status: authTokenStatusEnum.optional(),
  expiresAt: z.coerce.date().nullable().optional(),
})

export type CreateAuthTokenInput = z.infer<typeof createAuthTokenSchema>
export type UpdateAuthTokenInput = z.infer<typeof updateAuthTokenSchema>
