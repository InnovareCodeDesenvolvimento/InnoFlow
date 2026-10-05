import { z } from 'zod'
import { paginationQuerySchema } from './pagination.schema'

/**
 * Entradas das rotas de exclusão de conta (L1.4). Contrato: `frontend/src/types/api.ts` (`MeAccountDeletionRequest`, `AdminAccountDeletionRefundRequest`).
 * `.strict()`: campo desconhecido (inclusive um `userId` tentando apontar para outra conta) é 400, nunca ignorado em silêncio.
 */

// Corpo da exclusão. `confirmation` é o literal "EXCLUIR" (a tela só habilita o botão quando o titular o digita). Teto de 200 na senha como o login (bcrypt só lê 72 bytes; acima é carga
// sem ganho). `credential` do Google: ID tokens reais têm ~1-1,5 KB; 4096 barra lixo (mesmo teto do login). `refundPixKey` vazia ("") conta como AUSENTE (o formulário manda string vazia
// quando o campo não aparece/não é preenchido); só é lida se houver saldo, e então validada/normalizada em `core/lgpd/chavePix.ts`.
export const accountDeletionSchema = z
  .object({
    confirmation: z.literal('EXCLUIR'),
    currentPassword: z.string().max(200).optional(),
    googleCredential: z.string().min(1).max(4096).optional(),
    refundPixKey: z
      .string()
      .max(200)
      .optional()
      .transform((v) => (v === undefined || v.trim() === '' ? undefined : v)),
  })
  .strict()
export type AccountDeletionInput = z.infer<typeof accountDeletionSchema>

export const adminAccountDeletionsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['NOT_REQUIRED', 'PENDING_REFUND', 'REFUNDED']).optional(),
})
export type AdminAccountDeletionsQuery = z.infer<typeof adminAccountDeletionsQuerySchema>

// Teto do valor: R$ 100.000,00 em centavos — bem acima de qualquer saldo realista (o ajuste manual de saldo tem teto de R$ 5.000 e Pix tem limite por recarga); barra só número absurdo.
export const adminAccountDeletionRefundSchema = z
  .object({
    amountCents: z.number().int().min(1).max(10_000_000),
    proofReference: z.string().trim().min(1).max(120),
    currentPassword: z.string().min(1).max(200),
  })
  .strict()
export type AdminAccountDeletionRefundInput = z.infer<typeof adminAccountDeletionRefundSchema>

export const adminAccountDeletionParamsSchema = z.object({ id: z.string().trim().min(1).max(60) })
