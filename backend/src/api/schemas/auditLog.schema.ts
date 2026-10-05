import { z } from 'zod'
import { REPORT_PERIODS } from '../lib/reportingWindow'

/**
 * Query de `GET /api/admin/audit-logs` — mesmos presets de período do
 * módulo de retaguarda (`reportingWindow.ts`, reuso LITERAL por decisão de
 * Atlas/Nova), mas SEM `reportingScope.ts`: esta tela é ADMIN-only,
 * `operatorId` é um filtro opcional de conveniência, não uma fronteira de
 * tenant (não existe OPERATOR nesta rota — `requireRole('ADMIN')`).
 */
const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato esperado YYYY-MM-DD')

const roleEnum = z.enum(['ADMIN', 'OPERATOR', 'DRIVER'])
// Espelha o enum `AuditAction` do Prisma (um teste confere os dois). Faltavam `PAYMENT_CREDIT`/`PAYMENT_CONFIG_CHANGE` (F5) e os 4 do lote 1 (L1.3/L1.4/L1.8): filtrar a tela de Auditoria por
// eles dava 400.
export const auditActionEnum = z.enum([
  'CREATE',
  'UPDATE',
  'DELETE',
  'REMOTE_COMMAND',
  'WALLET_ADJUSTMENT',
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'EXPORT',
  'PAYMENT_CREDIT',
  'PAYMENT_CONFIG_CHANGE',
  'PASSWORD_RESET',
  'ACCOUNT_DELETION',
  'REFUND',
  'CHARGEBACK',
  'OTHER',
])
const auditOutcomeEnum = z.enum(['SUCCESS', 'DENIED', 'FAILED'])

export const auditLogQuerySchema = z.object({
  period: z.enum(REPORT_PERIODS).default('30d'),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  tz: z.string().trim().min(1).max(60).optional(),
  actorUserId: z.string().cuid().optional(),
  actorRole: roleEnum.optional(),
  action: auditActionEnum.optional(),
  outcome: auditOutcomeEnum.optional(),
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: z.string().trim().min(1).max(60).optional(),
  operatorId: z.string().cuid().optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  format: z.enum(['json', 'csv']).default('json'),
})
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>

export const auditLogActorsQuerySchema = z.object({
  period: z.enum(REPORT_PERIODS).default('30d'),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  tz: z.string().trim().min(1).max(60).optional(),
})
export type AuditLogActorsQuery = z.infer<typeof auditLogActorsQuerySchema>
