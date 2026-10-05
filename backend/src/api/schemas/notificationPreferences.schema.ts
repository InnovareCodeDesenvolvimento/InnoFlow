import { z } from 'zod'
import { LIMIAR_SALDO_BAIXO_MAX_CENTS, LIMIAR_SALDO_BAIXO_MIN_CENTS } from '../../core/notificacoes/politica'

/**
 * `PATCH /api/me/notification-preferences` (L1.6, DL5). Contrato: `UpdateMeNotificationPreferencesRequest` em `frontend/src/types/api.ts`.
 * `.strict()`: campo desconhecido é 400 — em particular QUALQUER tentativa de desligar segurança/cobrança (`passwordChanged`, `sessionPaymentFailed`, `accountDeleted`...), `userId`
 * ou `type`: o dono das preferências é sempre `req.user`, e esses avisos não têm chave. Ausente = "não mexer". Limiar: inteiro de 500 a 50000 centavos.
 */
export const updateNotificationPreferencesSchema = z
  .object({
    sessionReceiptEmail: z.boolean().optional(),
    lowBalanceEnabled: z.boolean().optional(),
    lowBalanceThresholdCents: z.number().int().min(LIMIAR_SALDO_BAIXO_MIN_CENTS).max(LIMIAR_SALDO_BAIXO_MAX_CENTS).optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((v) => v !== undefined), { message: 'Informe ao menos um campo para alterar.' })

export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>
