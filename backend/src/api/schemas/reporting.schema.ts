import { z } from 'zod'
import { REPORT_PERIODS } from '../lib/reportingWindow'

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato esperado YYYY-MM-DD')

/**
 * Query params comuns às 7 rotas do módulo de retaguarda. A obrigatoriedade
 * de `from`/`to` quando `period=custom` é checada em `resolvePeriodWindow`
 * (não aqui via `.refine`) — mantém o schema componível com `.extend()` nas
 * rotas específicas (ZodEffects de `.refine()` não é extensível).
 */
export const baseReportQuerySchema = z.object({
  period: z.enum(REPORT_PERIODS).default('30d'),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  siteId: z.string().cuid().optional(),
  chargePointId: z.string().cuid().optional(),
  operatorId: z.string().cuid().optional(),
  tz: z.string().trim().min(1).max(60).optional(),
})

export const formatQueryFragment = {
  format: z.enum(['json', 'csv']).default('json'),
}

export type BaseReportQuery = z.infer<typeof baseReportQuerySchema>

export const dailyMovementQuerySchema = baseReportQuerySchema.extend({
  groupBy: z.enum(['day', 'site', 'day_site']).default('day_site'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  ...formatQueryFragment,
})
export type DailyMovementQuery = z.infer<typeof dailyMovementQuerySchema>

// `breakdown=method` (não `paymentMethod`) — nome que o frontend já usa em
// `RevenueBreakdownDimension` (Faturamento/index.tsx, BREAKDOWN_OPTIONS).
export const revenueReportQuerySchema = baseReportQuerySchema.extend({
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  breakdown: z.enum(['site', 'chargePoint', 'method', 'tariff']).default('site'),
  ...formatQueryFragment,
})
export type RevenueReportQuery = z.infer<typeof revenueReportQuerySchema>

export const sessionsReportQuerySchema = baseReportQuerySchema.extend({
  status: z.enum(['STARTED', 'CHARGING', 'FINISHING', 'STOPPED', 'FAULTED']).optional(),
  // UNPAID continua aceito como filtro (sessão sem CARD nem WALLET) mesmo o
  // frontend só expondo CARD/WALLET na UI — não é um valor que a resposta
  // devolve mais (paymentMethod vira `null`), só um filtro de entrada.
  paymentMethod: z.enum(['CARD', 'WALLET', 'UNPAID']).optional(),
  // Nome exato que o frontend manda (`SessionsReportQuery.minAmountCents` em
  // types/api.ts) — divergia de `minCostCents` na 1ª entrega, filtro nunca
  // aplicava porque o Zod ignora chave desconhecida.
  minAmountCents: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  ...formatQueryFragment,
})
export type SessionsReportQuery = z.infer<typeof sessionsReportQuerySchema>

export const paymentsReportQuerySchema = baseReportQuerySchema.extend({
  provider: z.enum(['CIELO_CARD', 'CIELO_PIX', 'WALLET']).optional(),
  status: z.enum(['CREATED', 'AUTHORIZED', 'CAPTURE_PENDING', 'CAPTURED', 'CANCELLED', 'DENIED', 'VOIDED', 'FAILED', 'EXPIRED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  ...formatQueryFragment,
})
export type PaymentsReportQuery = z.infer<typeof paymentsReportQuerySchema>

export const dashboardSummaryQuerySchema = baseReportQuerySchema
export type DashboardSummaryQuery = z.infer<typeof dashboardSummaryQuerySchema>

export const dashboardLiveQuerySchema = z.object({
  siteId: z.string().cuid().optional(),
  chargePointId: z.string().cuid().optional(),
  operatorId: z.string().cuid().optional(),
})
export type DashboardLiveQuery = z.infer<typeof dashboardLiveQuerySchema>
