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
