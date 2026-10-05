import { z } from 'zod'

/** `POST /api/me/consents` (L1.9). Contrato: `MeAcceptConsentsRequest`. `.strict()`: campo desconhecido é 400. */
export const consentsAcceptSchema = z
  .object({
    termsVersion: z.string().trim().min(1).max(32),
    privacyVersion: z.string().trim().min(1).max(32),
  })
  .strict()
export type ConsentsAcceptInput = z.infer<typeof consentsAcceptSchema>
