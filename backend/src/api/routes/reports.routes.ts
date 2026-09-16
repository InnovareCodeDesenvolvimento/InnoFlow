import { Router } from 'express'
import { env } from '../../lib/env'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { requireOperatorOrAdmin } from '../middleware/tenantScope'
import { validateQuery } from '../middleware/validate'
import { resolveReportingScope, resolveReportingTimezone } from '../lib/reportingScope'
import { resolvePeriodWindow } from '../lib/reportingWindow'
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
import { fetchSessionsReportBatch, getDailyMovementReport, getRevenueReport, getSessionsReportPage, type DailyMovementRow, type RevenueBreakdownRow, type RevenueSeriesPoint } from '../services/reportsService'
import { getPaymentsSummary } from '../services/paymentsService'

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

/** Fábrica de "buscar em lotes" a partir de um array já resolvido em memória — resultados destas 2 rotas são bounded (≤366 dias × sites do escopo), diferente de /reports/sessions (ver nota no handoff). Reaproveita o mesmo escritor CSV (BOM/`;`/corte 50k) das rotas de verdade paginadas no banco. */
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
    const window = resolvePeriodWindow({ period: query.period, from: query.from, to: query.to, tz })
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

    res.json({ items: rows, meta: { window: { from: window.from, to: window.to, tz: window.tz }, groupBy: query.groupBy } })
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
    const window = resolvePeriodWindow({ period: query.period, from: query.from, to: query.to, tz })
    const report = await getRevenueReport(scope, window, { granularity: query.granularity, breakdown: query.breakdown })

    if (query.format === 'csv') {
      res.status(200)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="receita.csv"')
      res.write('﻿')
      res.write(`Serie temporal (${query.granularity})\r\n`)
      res.write('Periodo;Faturamento (R$);Sessoes;Energia (kWh)\r\n')
      for (const point of report.series.slice(0, CSV_MAX_ROWS) as RevenueSeriesPoint[]) {
        res.write(`${point.bucket};${csvMoney(point.revenueCents)};${point.sessions};${csvEnergyKwh(point.energyWh)}\r\n`)
      }
      res.write('\r\n')
      res.write(`Composicao por ${query.breakdown}\r\n`)
      res.write('Chave;Faturamento (R$);Sessoes;Participacao (%)\r\n')
      for (const row of report.breakdown.slice(0, CSV_MAX_ROWS) as RevenueBreakdownRow[]) {
        res.write(`${row.label};${csvMoney(row.revenueCents)};${row.sessions};${csvPct(row.sharePct)}\r\n`)
      }
      res.end()
      return
    }

    res.json({ ...report, meta: { window: { from: window.from, to: window.to, tz: window.tz }, granularity: query.granularity, breakdown: query.breakdown } })
  }),
)

// ------------------------------------------------------------
// GET /api/admin/reports/sessions — paginado, mesmo envelope {items, meta} dos CRUDs.
// ------------------------------------------------------------

router.get(
  '/sessions',
  validateQuery(sessionsReportQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as SessionsReportQuery
    const scope = await resolveReportingScope(req, query)
    const tz = await resolveReportingTimezone(query.tz, scope, env.REPORTING_TIMEZONE)
    const window = resolvePeriodWindow({ period: query.period, from: query.from, to: query.to, tz })
    const filters = { status: query.status, paymentMethod: query.paymentMethod, minCostCents: query.minCostCents }

    if (query.format === 'csv') {
      await streamCsvReport(
        res,
        {
          filename: 'sessoes.csv',
          headers: ['Site', 'Charge Point', 'Conector', 'Status', 'Inicio', 'Fim', 'Energia (kWh)', 'Valor total (R$)', 'Taxa de ociosidade (R$)', 'Tarifa', 'Forma de pagamento'],
        },
        fetchSessionsReportBatch(scope, window, filters),
        (r) => [
          r.siteName,
          r.chargePointIdentity,
          r.connectorNumber,
          r.status,
          r.startedAt.toISOString(),
          r.stoppedAt?.toISOString() ?? '',
          csvEnergyKwh(r.energyDeliveredWh),
          csvMoney(r.totalCostCents),
          csvMoney(r.idleFeeCents),
          r.tariffName,
          r.paymentMethod,
        ],
      )
      return
    }

    const { items, total } = await getSessionsReportPage(scope, window, filters, query.page, query.pageSize)
    res.json({ items, meta: { ...paginationMeta(query.page, query.pageSize, total), window: { from: window.from, to: window.to, tz: window.tz } } })
  }),
)

// ------------------------------------------------------------
// GET /api/admin/reports/payments — summary + reconciliation.
// ------------------------------------------------------------

router.get(
  '/payments',
  validateQuery(paymentsReportQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as PaymentsReportQuery
    const scope = await resolveReportingScope(req, query)
    const tz = await resolveReportingTimezone(query.tz, scope, env.REPORTING_TIMEZONE)
    const window = resolvePeriodWindow({ period: query.period, from: query.from, to: query.to, tz })
    const summary = await getPaymentsSummary(scope, window, req.user!.role === 'ADMIN')

    if (query.format === 'csv') {
      streamCsvSingleRow(
        res,
        {
          filename: 'pagamentos.csv',
          headers: [
            'Faturamento (R$)',
            'Capturado no cartao (R$)',
            'Debitado da carteira (R$)',
            'Divida aberta (R$)',
            'Estornado (R$)',
            'Capturas falhas',
            'Autorizacoes negadas',
            'Esperado (R$)',
            'Contabilizado (R$)',
            'Diferenca (R$)',
          ],
        },
        [
          csvMoney(summary.revenueCents),
          csvMoney(summary.cardCapturedCents),
          csvMoney(summary.walletDebitedCents),
          csvMoney(summary.openDebtCents),
          csvMoney(summary.refundedCents),
          summary.failedCaptureCount,
          summary.deniedAuthCount,
          csvMoney(summary.reconciliation.expectedCents),
          csvMoney(summary.reconciliation.accountedCents),
          csvDecimal(summary.reconciliation.differenceCents / 100),
        ],
      )
      return
    }

    res.json({ ...summary, meta: { window: { from: window.from, to: window.to, tz: window.tz } } })
  }),
)

export default router
