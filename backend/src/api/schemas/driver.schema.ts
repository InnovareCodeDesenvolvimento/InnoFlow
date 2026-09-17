import { z } from 'zod'

export const driversListQuerySchema = z.object({
  // Obrigatoriedade condicional a role (OPERATOR precisa de >= 3 chars) é
  // checada na ROTA, não aqui — o schema não sabe quem está autenticado
  // (mesmo padrão de `baseReportQuerySchema`/`resolvePeriodWindow`).
  search: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type DriversListQuery = z.infer<typeof driversListQuerySchema>

export const driverWalletQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type DriverWalletQuery = z.infer<typeof driverWalletQuerySchema>

/** R$ 5.000 — teto de crédito/débito manual do ADMIN por lançamento (decisão do dono, 2026-09-17). */
export const WALLET_ADJUSTMENT_MAX_CENTS = 500_000

export const walletAdjustmentSchema = z.object({
  amountCents: z
    .number()
    .int()
    .refine((v) => v !== 0, { message: 'amountCents não pode ser zero.' })
    .refine((v) => Math.abs(v) <= WALLET_ADJUSTMENT_MAX_CENTS, { message: `|amountCents| não pode passar de ${WALLET_ADJUSTMENT_MAX_CENTS}.` }),
  description: z.string().trim().min(5, 'description precisa ter pelo menos 5 caracteres — é a trilha de auditoria do lançamento.').max(500),
})
export type WalletAdjustmentInput = z.infer<typeof walletAdjustmentSchema>
