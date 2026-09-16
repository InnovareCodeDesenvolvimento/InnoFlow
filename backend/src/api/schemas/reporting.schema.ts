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
  ...formatQueryFragment,
})
export type DailyMovementQuery = z.infer<typeof dailyMovementQuerySchema>

export const revenueReportQuerySchema = baseReportQuerySchema.extend({
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  breakdown: z.enum(['site', 'chargePoint', 'paymentMethod', 'tariff']).default('site'),
  ...formatQueryFragment,
})
export type RevenueReportQuery = z.infer<typeof revenueReportQuerySchema>

export const sessionsReportQuerySchema = baseReportQuerySchema.extend({
  status: z.enum(['STARTED', 'CHARGING', 'FINISHING', 'STOPPED', 'FAULTED']).optional(),
  paymentMethod: z.enum(['CARD', 'WALLET', 'UNPAID']).optional(),
  minCostCents: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  ...formatQueryFragment,
})
export type SessionsReportQuery = z.infer<typeof sessionsReportQuerySchema>

export const paymentsReportQuerySchema = baseReportQuerySchema.extend({
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
