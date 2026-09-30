import { z } from 'zod'

/**
 * PWA do motorista (`/api/me/*`, F6 — ver decisoes-pwa-motorista.md).
 *
 * `ocppIdentity` NÃO é `.cuid()` — é a identidade pública do equipamento
 * (curta, escrita na etiqueta), não um id do Prisma. Ver bug já registrado
 * em memória: `.cuid()` num campo que não é cuid rejeita entrada legítima
 * (mesmo erro que bateu em `seed-site-matriz` e em
 * `remoteStartCommandSchema.userId`).
 */
export const meStartSessionSchema = z.object({
  ocppIdentity: z.string().trim().min(1),
  connectorId: z.number().int().min(1),
})
export type MeStartSessionInput = z.infer<typeof meStartSessionSchema>

export const meListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type MeListQuery = z.infer<typeof meListQuerySchema>

// ------------------------------------------------------------
// POST /wallet/topups (F5.2 — recarga de carteira via Pix real)
// ------------------------------------------------------------

/**
 * Limites e formato só de TIPO aqui (`amountCents` inteiro positivo, `cpf`
 * só dígitos se vier) — a faixa de valor (R$ 10,00 a R$ 500,00) e a validade
 * do CPF (dígito verificador) são checadas na ROTA, não aqui, porque
 * precisam responder com `code` específico (`TOPUP_AMOUNT_OUT_OF_RANGE`/
 * `INVALID_CPF`, contrato de `frontend/src/lib/topupAmount.ts`) — um erro de
 * schema Zod cairia em `VALIDATION_ERROR` genérico, que o frontend não
 * mapeia para a mensagem certa.
 */
export const meCreateTopupSchema = z.object({
  amountCents: z.number().int().positive(),
  cpf: z.string().trim().optional(),
})
export type MeCreateTopupInput = z.infer<typeof meCreateTopupSchema>
