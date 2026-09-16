import { Router } from 'express'
import { env } from '../../lib/env'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { requireOperatorOrAdmin } from '../middleware/tenantScope'
import { validateQuery } from '../middleware/validate'
import { resolveReportingScope, resolveReportingTimezone } from '../lib/reportingScope'
import { resolveEffectivePeriod, resolvePeriodWindow } from '../lib/reportingWindow'
import { dashboardLiveQuerySchema, dashboardSummaryQuerySchema, type DashboardLiveQuery, type DashboardSummaryQuery } from '../schemas/reporting.schema'
import { getDashboardLive, getDashboardSummary } from '../services/dashboardService'

/**
 * Módulo de retaguarda — dashboard administrativo (Nova,
 * decisoes-retaguarda-relatorios.md). Isolamento multi-tenant real:
 * `resolveReportingScope` (não `operatorScopeWhere`, que só protege o query
 * builder do Prisma) valida OPERATOR x operatorId da query e ownership de
 * siteId/chargePointId ANTES de qualquer `$queryRaw`.
 */
const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

router.get(
  '/summary',
  validateQuery(dashboardSummaryQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as DashboardSummaryQuery
    const scope = await resolveReportingScope(req, query)
    const tz = await resolveReportingTimezone(query.tz, scope, env.REPORTING_TIMEZONE)
    const window = resolvePeriodWindow({ period: resolveEffectivePeriod(query.period, query.from, query.to), from: query.from, to: query.to, tz })
    const summary = await getDashboardSummary(scope, window, req.user!.role === 'ADMIN')
    res.json(summary)
  }),
)

router.get(
  '/live',
  validateQuery(dashboardLiveQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as DashboardLiveQuery
    const scope = await resolveReportingScope(req, query)
    const live = await getDashboardLive(scope)
    res.json(live)
  }),
)

export default router
