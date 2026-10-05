import { Router } from 'express'
import { env } from '../../lib/env'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { requireOperatorOrAdmin } from '../middleware/tenantScope'
import { validateQuery } from '../middleware/validate'
import { resolveReportingScope, resolveReportingTimezone } from '../lib/reportingScope'
import { resolveEffectivePeriod, resolvePeriodWindow } from '../lib/reportingWindow'
import { CSV_MAX_ROWS, csvDecimal, csvEnergyKwh, csvMoney, csvPct, streamCsvReport, streamCsvSingleRow } from '../lib/csvExport'
import { paginationMeta } from '../schemas/pagination.schema'
import {
  dailyMovementQuerySchema,
  paymentsReportQuerySchema,
  revenueReportQuerySchema,
  sessionsReportQuerySchema,
  type DailyMovementQuery,
  type PaymentsReportQuery,
  type RevenueReportQuery,
  type SessionsReportQuery,
} from '../schemas/reporting.schema'
import { fetchSessionsReportBatch, getDailyMovementReport, getRevenueReport, getSessionDetail, getSessionsReportPage, type DailyMovementRow } from '../services/reportsService'
import { getPaymentsReconciliation, getPaymentsReportPage } from '../services/paymentsService'

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

/** Fábrica de "buscar em lotes" a partir de um array já resolvido em memória — resultados desta rota são bounded (≤366 dias × sites do escopo), diferente de /reports/sessions (ver nota no handoff). Reaproveita o mesmo escritor CSV (BOM/`;`/corte 50k) das rotas de verdade paginadas no banco. */
function batchFromArray<T>(items: T[]): (offset: number, limit: number) => Promise<T[]> {
  return async (offset: number, limit: number) => items.slice(offset, offset + limit)
}

// ------------------------------------------------------------
// GET /api/admin/reports/daily-movement
// ------------------------------------------------------------

router.get(
  '/daily-movement',
  validateQuery(dailyMovementQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as DailyMovementQuery
    const scope = await resolveReportingScope(req, query)
    const tz = await resolveReportingTimezone(query.tz, scope, env.REPORTING_TIMEZONE)
    const window = resolvePeriodWindow({ period: resolveEffectivePeriod(query.period, query.from, query.to), from: query.from, to: query.to, tz })
    const rows = await getDailyMovementReport(scope, window, query.groupBy)

    if (query.format === 'csv') {
      await streamCsvReport<DailyMovementRow>(
        res,
        {
          filename: 'movimento-diario.csv',
          headers: ['Data', 'Site', 'Sessoes', 'Sessoes com falha', 'Energia (kWh)', 'Faturamento (R$)', 'Ticket medio (R$)', 'Taxa de ociosidade (R$)', 'Utilizacao (%)'],
        },
        batchFromArray(rows),
        (r) => [r.date ?? '', r.siteName ?? '', r.sessions, r.failedSessions, csvEnergyKwh(r.energyWh), csvMoney(r.revenueCents), csvMoney(r.avgTicketCents), csvMoney(r.idleFeeCents), csvPct(r.utilizationPct)],
      )
      return
    }

    // Os `rows` já vêm todos calculados em memória (bounded pela janela) —
    // pagina a LISTA (não a query) antes de responder; `totals` soma TODOS
    // os items, não só a página atual.
    const totals = rows.reduce(
      (acc, r) => ({ sessions: acc.sessions + r.sessions, energyWh: acc.energyWh + r.energyWh, revenueCents: acc.revenueCents + r.revenueCents }),
      { sessions: 0, energyWh: 0, revenueCents: 0 },
    )
    const start = (query.page - 1) * query.pageSize
    const items = rows.slice(start, start + query.pageSize)

    res.json({ items, meta: paginationMeta(query.page, query.pageSize, rows.length), totals })
  }),
)

// ------------------------------------------------------------
// GET /api/admin/reports/revenue
// ------------------------------------------------------------

router.get(
  '/revenue',
  validateQuery(revenueReportQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as RevenueReportQuery
    const scope = await resolveReportingScope(req, query)
    const tz = await resolveReportingTimezone(query.tz, scope, env.REPORTING_TIMEZONE)
    const window = resolvePeriodWindow({ period: resolveEffectivePeriod(query.period, query.from, query.to), from: query.from, to: query.to, tz })
    const report = await getRevenueReport(scope, window, { granularity: query.granularity, breakdown: query.breakdown })

    if (query.format === 'csv') {
      res.status(200)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="receita.csv"')
      res.write('﻿')
      res.write(`Serie temporal (${query.granularity})\r\n`)
      res.write('Periodo;Faturamento (R$);Sessoes;Energia (kWh)\r\n')
      for (const point of report.series.slice(0, CSV_MAX_ROWS)) {
        res.write(`${point.bucket};${csvMoney(point.revenueCents)};${point.sessions};${csvEnergyKwh(point.energyWh)}\r\n`)
      }
      res.write('\r\n')
      res.write(`Composicao por ${query.breakdown}\r\n`)
      res.write('Chave;Faturamento (R$);Energia (kWh);Sessoes\r\n')
      for (const row of report.breakdownRows.slice(0, CSV_MAX_ROWS)) {
        res.write(`${row.label};${csvMoney(row.revenueCents)};${csvEnergyKwh(row.energyWh)};${row.sessions}\r\n`)
      }
      res.end()
      return
    }

    res.json({ granularity: query.granularity, breakdown: query.breakdown, series: report.series, breakdownRows: report.breakdownRows, totals: report.totals })
  }),
)

// ------------------------------------------------------------
// GET /api/admin/reports/sessions — paginado, mesmo envelope {items, meta} dos CRUDs.
// GET /api/admin/reports/sessions/:id — drill-down de uma sessão.
// ------------------------------------------------------------

router.get(
  '/sessions',
  validateQuery(sessionsReportQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as SessionsReportQuery
    const scope = await resolveReportingScope(req, query)
    const tz = await resolveReportingTimezone(query.tz, scope, env.REPORTING_TIMEZONE)
    const window = resolvePeriodWindow({ period: resolveEffectivePeriod(query.period, query.from, query.to), from: query.from, to: query.to, tz })
    const filters = { status: query.status, paymentMethod: query.paymentMethod, minAmountCents: query.minAmountCents }

    if (query.format === 'csv') {
      await streamCsvReport(
        res,
        {
          filename: 'sessoes.csv',
          headers: ['Site', 'Charge Point', 'Conector', 'Motorista', 'Status', 'Inicio', 'Fim', 'Energia (kWh)', 'Valor total (R$)', 'Taxa de ociosidade (R$)', 'Tarifa', 'Forma de pagamento', 'Status do pagamento'],
        },
        fetchSessionsReportBatch(scope, window, filters),
        (r) => [
          r.siteName,
          r.ocppIdentity,
          r.connectorId,
          r.driverName,
          r.status,
          r.startedAt.toISOString(),
          r.stoppedAt?.toISOString() ?? '',
          csvEnergyKwh(r.energyDeliveredWh),
          csvMoney(r.totalCostCents),
          csvMoney(r.idleFeeCents),
          r.tariffName,
          r.paymentMethod ?? '',
          r.paymentStatus ?? '',
        ],
      )
      return
    }

    const { items, total } = await getSessionsReportPage(scope, window, filters, query.page, query.pageSize)
    res.json({ items, meta: paginationMeta(query.page, query.pageSize, total) })
  }),
)

router.get(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const scope = await resolveReportingScope(req, req.query as { siteId?: string; chargePointId?: string; operatorId?: string })
    const detail = await getSessionDetail(scope, req.params.id, req.user!.role === 'ADMIN')
    if (!detail) throw new AppError('Sessão não encontrada.', 404, 'NOT_FOUND')
    res.json(detail)
  }),
)

// ------------------------------------------------------------
// GET /api/admin/reports/payments — reconciliation + items paginados.
// ------------------------------------------------------------

router.get(
  '/payments',
  validateQuery(paymentsReportQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as PaymentsReportQuery
    const scope = await resolveReportingScope(req, query)
    const tz = await resolveReportingTimezone(query.tz, scope, env.REPORTING_TIMEZONE)
    const window = resolvePeriodWindow({ period: resolveEffectivePeriod(query.period, query.from, query.to), from: query.from, to: query.to, tz })
    const isAdmin = req.user!.role === 'ADMIN'
    const filters = { provider: query.provider, status: query.status, tid: query.tid, authorizationCode: query.authorizationCode, proofOfSale: query.proofOfSale }

    const [reconciliation, page] = await Promise.all([
      getPaymentsReconciliation(scope, window, isAdmin),
      getPaymentsReportPage(scope, window, filters, query.page, query.pageSize),
    ])

    if (query.format === 'csv') {
      streamCsvSingleRow(
        res,
        {
          filename: 'pagamentos.csv',
          headers: [
            'Faturamento (R$)',
            'Capturado no cartao (R$)',
            'Captura de cartao pendente (R$)',
            'Debitado da carteira (R$)',
            'Divida quitada (R$)',
            'Divida aberta (R$)',
            'Tentativas falhas (R$)',
            'Estornado no cartao (R$)',
            'Esperado (R$)',
            'Contabilizado (R$)',
            'Diferenca (R$)',
          ],
        },
        [
          csvMoney(reconciliation.revenueCents),
          csvMoney(reconciliation.cardCapturedCents),
          csvMoney(reconciliation.cardCapturePendingCents),
          csvMoney(reconciliation.walletDebitCents),
          csvMoney(reconciliation.debtSettledCents),
          csvMoney(reconciliation.openDebtCents),
          csvMoney(reconciliation.failedAttemptsCents),
          csvMoney(reconciliation.cardRefundedCents),
          csvMoney(reconciliation.expectedCents),
          csvMoney(reconciliation.accountedCents),
          csvDecimal(reconciliation.differenceCents / 100),
        ],
      )
      return
    }

    res.json({ reconciliation, items: page.items, meta: paginationMeta(query.page, query.pageSize, page.total) })
  }),
)

export default router
