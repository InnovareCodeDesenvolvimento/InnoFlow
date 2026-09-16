import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import type { ReportingScope } from '../lib/reportingScope'
import { zonedStartOfDayToUtc, type PeriodWindow } from '../lib/reportingWindow'
import { periodConditions, tenantConditions, toNumber, whereSql } from '../lib/reportingSql'
import type { DailyMovementQuery, RevenueReportQuery, SessionsReportQuery } from '../schemas/reporting.schema'

// ------------------------------------------------------------
// /api/admin/reports/daily-movement
// ------------------------------------------------------------

export interface DailyMovementRow {
  date: string | null
  siteId: string | null
  siteName: string | null
  sessions: number
  failedSessions: number
  energyWh: number
  revenueCents: number
  avgTicketCents: number
  idleFeeCents: number
  utilizationPct: number
}

function dayBoundsUtc(dateStr: string, tz: string): { start: Date; end: Date } {
  const [y, m, d] = dateStr.split('-').map(Number)
  const start = zonedStartOfDayToUtc(y, m, d, tz)
  // JS `Date` normaliza overflow de dia (ex.: dia 31+1 em mês de 30 dias vira dia 1 do mês seguinte) —
  // forma simples de andar "um dia de parede" sem lib de datas externa.
  const rolled = new Date(Date.UTC(y, m - 1, d + 1))
  const end = zonedStartOfDayToUtc(rolled.getUTCFullYear(), rolled.getUTCMonth() + 1, rolled.getUTCDate(), tz)
  return { start, end }
}

/**
 * Segundos "efetivamente decorridos" de um bucket de dia — capado em `now`
 * e no fim da janela do relatório. Sem isto, o dia de HOJE (ainda não
 * terminado) apareceria com utilização artificialmente baixa (denominador
 * de 24h inteiras quando só decorreram algumas horas).
 */
function effectiveBucketSeconds(bucketStart: Date, bucketEnd: Date, windowTo: Date, now: Date): number {
  const cappedEnd = Math.min(bucketEnd.getTime(), windowTo.getTime(), now.getTime())
  return Math.max(0, (cappedEnd - bucketStart.getTime()) / 1000)
}

async function fetchConnectorCapacityBySite(scope: ReportingScope): Promise<Map<string, number>> {
  const rows = await prisma.connector.groupBy({
    by: ['chargePointId'],
    where: {
      ...(scope.operatorId ? { operatorId: scope.operatorId } : {}),
      chargePoint: {
        active: true,
        ...(scope.chargePointId ? { id: scope.chargePointId } : {}),
        ...(scope.siteId ? { siteId: scope.siteId } : {}),
      },
    },
    _count: { _all: true },
  })
  if (rows.length === 0) return new Map()

  const chargePoints = await prisma.chargePoint.findMany({
    where: { id: { in: rows.map((r) => r.chargePointId) } },
    select: { id: true, siteId: true },
  })
  const siteByChargePoint = new Map(chargePoints.map((cp) => [cp.id, cp.siteId]))

  const bySite = new Map<string, number>()
  for (const row of rows) {
    const siteId = siteByChargePoint.get(row.chargePointId)
    if (!siteId) continue
    bySite.set(siteId, (bySite.get(siteId) ?? 0) + row._count._all)
  }
  return bySite
}

export async function getDailyMovementReport(scope: ReportingScope, window: PeriodWindow, groupBy: DailyMovementQuery['groupBy']): Promise<DailyMovementRow[]> {
  const where = whereSql([...tenantConditions(scope, 'cs'), ...periodConditions('cs', window.from, window.to)])
  const includeDay = groupBy === 'day' || groupBy === 'day_site'
  const includeSite = groupBy === 'site' || groupBy === 'day_site'

  const dayExpr = includeDay ? Prisma.sql`(date_trunc('day', cs."startedAt" AT TIME ZONE ${window.tz}))::date::text` : Prisma.sql`NULL`
  const siteSelect = includeSite ? Prisma.sql`cs."siteId" AS "siteId", s.name AS "siteName",` : Prisma.sql`NULL AS "siteId", NULL AS "siteName",`
  const joinSite = includeSite ? Prisma.sql`JOIN "Site" s ON s.id = cs."siteId"` : Prisma.empty

  // Posições fixas na lista de SELECT (independem de includeDay/includeSite,
  // já que as colunas "não incluídas" ainda são selecionadas como NULL
  // literal — constante, não precisa entrar no GROUP BY): 1=date, 2=siteId,
  // 3=siteName.
  const groupParts: Prisma.Sql[] = []
  if (includeDay) groupParts.push(Prisma.sql`1`)
  if (includeSite) groupParts.push(Prisma.sql`2`, Prisma.sql`3`)
  const groupBySql = groupParts.length ? Prisma.join(groupParts, ', ') : Prisma.sql`1`
  const orderBySql = includeDay ? Prisma.sql`1` : Prisma.sql`"revenueCents" DESC`

  const rows = await prisma.$queryRaw<
    { date: string | null; siteId: string | null; siteName: string | null; sessions: number; completedSessions: number; failedSessions: number; energyWh: number; revenueCents: number; idleFeeCents: number; chargingSeconds: number }[]
  >(Prisma.sql`
    SELECT
      ${dayExpr} AS "date",
      ${siteSelect}
      COUNT(*)::int AS "sessions",
      COUNT(*) FILTER (WHERE cs.status = 'STOPPED')::int AS "completedSessions",
      COUNT(*) FILTER (WHERE cs.status = 'FAULTED')::int AS "failedSessions",
      COALESCE(SUM(cs."energyDeliveredWh") FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "energyWh",
      COALESCE(SUM(cs."totalCostCents") FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "revenueCents",
      COALESCE(SUM(cs."idleFeeCents") FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "idleFeeCents",
      COALESCE(SUM(EXTRACT(EPOCH FROM (cs."stoppedAt" - cs."startedAt"))) FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "chargingSeconds"
    FROM "ChargingSession" cs
    ${joinSite}
    WHERE ${where}
    GROUP BY ${groupBySql}
    ORDER BY ${orderBySql}
  `)

  const capacityBySite = includeSite ? await fetchConnectorCapacityBySite(scope) : new Map<string, number>()
  const overallCapacity = includeSite ? [...capacityBySite.values()].reduce((a, b) => a + b, 0) : await prisma.connector.count({
    where: {
      ...(scope.operatorId ? { operatorId: scope.operatorId } : {}),
      chargePoint: { active: true, ...(scope.chargePointId ? { id: scope.chargePointId } : {}), ...(scope.siteId ? { siteId: scope.siteId } : {}) },
    },
  })

  const now = new Date()

  return rows.map((row) => {
    const capacity = includeSite && row.siteId ? (capacityBySite.get(row.siteId) ?? 0) : overallCapacity
    const bucketSeconds = includeDay && row.date ? effectiveBucketSeconds(dayBoundsUtc(row.date, window.tz).start, dayBoundsUtc(row.date, window.tz).end, window.to, now) : (window.to.getTime() - window.from.getTime()) / 1000
    const capacitySeconds = capacity * bucketSeconds
    const utilizationPct = capacitySeconds > 0 ? round2(Math.min(100, (toNumber(row.chargingSeconds) / capacitySeconds) * 100)) : 0
    const revenueCents = Math.round(toNumber(row.revenueCents))
    const completedSessions = toNumber(row.completedSessions)

    return {
      date: row.date,
      siteId: row.siteId,
      siteName: row.siteName,
      sessions: toNumber(row.sessions),
      failedSessions: toNumber(row.failedSessions),
      energyWh: Math.round(toNumber(row.energyWh)),
      revenueCents,
      avgTicketCents: completedSessions > 0 ? Math.round(revenueCents / completedSessions) : 0,
      idleFeeCents: Math.round(toNumber(row.idleFeeCents)),
      utilizationPct,
    }
  })
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// ------------------------------------------------------------
// /api/admin/reports/revenue
// ------------------------------------------------------------

export interface RevenueSeriesPoint {
  bucket: string
  revenueCents: number
  sessions: number
  energyWh: number
}

export interface RevenueBreakdownRow {
  key: string
  label: string
  revenueCents: number
  sessions: number
  sharePct: number
}

const GRANULARITY_TO_TRUNC: Record<RevenueReportQuery['granularity'], Prisma.Sql> = {
  day: Prisma.sql`'day'`,
  week: Prisma.sql`'week'`,
  month: Prisma.sql`'month'`,
}

async function fetchRevenueSeries(scope: ReportingScope, window: PeriodWindow, granularity: RevenueReportQuery['granularity']): Promise<RevenueSeriesPoint[]> {
  const where = whereSql([Prisma.sql`cs.status = 'STOPPED'`, ...tenantConditions(scope, 'cs'), ...periodConditions('cs', window.from, window.to)])
  const trunc = GRANULARITY_TO_TRUNC[granularity]

  const rows = await prisma.$queryRaw<{ bucket: string; revenueCents: number; sessions: number; energyWh: number }[]>(Prisma.sql`
    SELECT
      (date_trunc(${trunc}, cs."startedAt" AT TIME ZONE ${window.tz}))::date::text AS "bucket",
      COALESCE(SUM(cs."totalCostCents"), 0)::float8 AS "revenueCents",
      COUNT(*)::int AS "sessions",
      COALESCE(SUM(cs."energyDeliveredWh"), 0)::float8 AS "energyWh"
    FROM "ChargingSession" cs
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
  `)

  return rows.map((r) => ({ bucket: r.bucket, revenueCents: Math.round(toNumber(r.revenueCents)), sessions: toNumber(r.sessions), energyWh: Math.round(toNumber(r.energyWh)) }))
}

async function fetchRevenueBreakdown(scope: ReportingScope, window: PeriodWindow, breakdown: RevenueReportQuery['breakdown']): Promise<RevenueBreakdownRow[]> {
  const baseWhere = whereSql([Prisma.sql`cs.status = 'STOPPED'`, ...tenantConditions(scope, 'cs'), ...periodConditions('cs', window.from, window.to)])

  let rows: { key: string; label: string; revenueCents: number; sessions: number }[]

  if (breakdown === 'site') {
    rows = await prisma.$queryRaw(Prisma.sql`
      SELECT cs."siteId" AS "key", s.name AS "label", COALESCE(SUM(cs."totalCostCents"), 0)::float8 AS "revenueCents", COUNT(*)::int AS "sessions"
      FROM "ChargingSession" cs JOIN "Site" s ON s.id = cs."siteId"
      WHERE ${baseWhere}
      GROUP BY cs."siteId", s.name
      ORDER BY "revenueCents" DESC
    `)
  } else if (breakdown === 'chargePoint') {
    rows = await prisma.$queryRaw(Prisma.sql`
      SELECT cs."chargePointId" AS "key", COALESCE(cp."vendor" || ' ' || cp."model", cp."ocppIdentity") AS "label",
        COALESCE(SUM(cs."totalCostCents"), 0)::float8 AS "revenueCents", COUNT(*)::int AS "sessions"
      FROM "ChargingSession" cs JOIN "ChargePoint" cp ON cp.id = cs."chargePointId"
      WHERE ${baseWhere}
      GROUP BY cs."chargePointId", cp."vendor", cp."model", cp."ocppIdentity"
      ORDER BY "revenueCents" DESC
    `)
  } else if (breakdown === 'tariff') {
    rows = await prisma.$queryRaw(Prisma.sql`
      SELECT cs."tariffId" AS "key", t.name AS "label", COALESCE(SUM(cs."totalCostCents"), 0)::float8 AS "revenueCents", COUNT(*)::int AS "sessions"
      FROM "ChargingSession" cs JOIN "Tariff" t ON t.id = cs."tariffId"
      WHERE ${baseWhere}
      GROUP BY cs."tariffId", t.name
      ORDER BY "revenueCents" DESC
    `)
  } else {
    // paymentMethod — não é uma coluna, é derivado da existência de captura de
    // cartão (PaymentIntent) ou débito de carteira (WalletEntry) ligados à sessão.
    rows = await prisma.$queryRaw(Prisma.sql`
      WITH scoped_sessions AS (
        SELECT cs.id, cs."totalCostCents",
          CASE
            WHEN EXISTS (SELECT 1 FROM "PaymentIntent" pi WHERE pi."chargingSessionId" = cs.id AND pi.purpose = 'SESSION_CARD_CAPTURE' AND pi.status = 'CAPTURED') THEN 'CARD'
            WHEN EXISTS (SELECT 1 FROM "WalletEntry" we WHERE we."referenceType" = 'CHARGING_SESSION' AND we."referenceId" = cs.id AND we.type = 'CHARGE_DEBIT') THEN 'WALLET'
            ELSE 'UNPAID'
          END AS payment_method
        FROM "ChargingSession" cs
        WHERE ${baseWhere}
      )
      SELECT payment_method AS "key", payment_method AS "label", COALESCE(SUM("totalCostCents"), 0)::float8 AS "revenueCents", COUNT(*)::int AS "sessions"
      FROM scoped_sessions
      GROUP BY payment_method
      ORDER BY "revenueCents" DESC
    `)
  }

  const total = rows.reduce((sum, r) => sum + toNumber(r.revenueCents), 0)
  return rows.map((r) => {
    const revenueCents = Math.round(toNumber(r.revenueCents))
    return { key: r.key, label: r.label, revenueCents, sessions: toNumber(r.sessions), sharePct: total > 0 ? round2((revenueCents / total) * 100) : 0 }
  })
}

export async function getRevenueReport(scope: ReportingScope, window: PeriodWindow, query: Pick<RevenueReportQuery, 'granularity' | 'breakdown'>) {
  const [series, breakdown] = await Promise.all([
    fetchRevenueSeries(scope, window, query.granularity),
    fetchRevenueBreakdown(scope, window, query.breakdown),
  ])
  return { series, breakdown }
}

// ------------------------------------------------------------
// /api/admin/reports/sessions — analítico, drill-down, paginado.
// ------------------------------------------------------------

export interface SessionReportRow {
  id: string
  siteId: string
  siteName: string
  chargePointId: string
  chargePointIdentity: string
  connectorId: string
  connectorNumber: number
  status: string
  startedAt: Date
  stoppedAt: Date | null
  energyDeliveredWh: number | null
  totalCostCents: number | null
  idleFeeCents: number | null
  tariffId: string
  tariffName: string
  paymentMethod: 'CARD' | 'WALLET' | 'UNPAID'
}

function sessionsFilterConditions(filters: Pick<SessionsReportQuery, 'status' | 'paymentMethod' | 'minCostCents'>): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = []
  if (filters.status) conditions.push(Prisma.sql`cs.status = ${filters.status}`)
  if (filters.minCostCents !== undefined) conditions.push(Prisma.sql`cs."totalCostCents" >= ${filters.minCostCents}`)
  if (filters.paymentMethod === 'CARD') {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "PaymentIntent" pi WHERE pi."chargingSessionId" = cs.id AND pi.purpose = 'SESSION_CARD_CAPTURE' AND pi.status = 'CAPTURED')`)
  } else if (filters.paymentMethod === 'WALLET') {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "WalletEntry" we WHERE we."referenceType" = 'CHARGING_SESSION' AND we."referenceId" = cs.id AND we.type = 'CHARGE_DEBIT')`)
  } else if (filters.paymentMethod === 'UNPAID') {
    conditions.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "PaymentIntent" pi WHERE pi."chargingSessionId" = cs.id AND pi.purpose = 'SESSION_CARD_CAPTURE' AND pi.status = 'CAPTURED')`)
    conditions.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "WalletEntry" we WHERE we."referenceType" = 'CHARGING_SESSION' AND we."referenceId" = cs.id AND we.type = 'CHARGE_DEBIT')`)
  }
  return conditions
}

const SESSIONS_SELECT = Prisma.sql`
  cs.id AS "id", cs."siteId" AS "siteId", s.name AS "siteName",
  cs."chargePointId" AS "chargePointId", cp."ocppIdentity" AS "chargePointIdentity",
  cs."connectorId" AS "connectorId", co."connectorId" AS "connectorNumber",
  cs.status AS "status", cs."startedAt" AS "startedAt", cs."stoppedAt" AS "stoppedAt",
  cs."energyDeliveredWh" AS "energyDeliveredWh", cs."totalCostCents" AS "totalCostCents", cs."idleFeeCents" AS "idleFeeCents",
  cs."tariffId" AS "tariffId", t.name AS "tariffName",
  CASE
    WHEN EXISTS (SELECT 1 FROM "PaymentIntent" pi WHERE pi."chargingSessionId" = cs.id AND pi.purpose = 'SESSION_CARD_CAPTURE' AND pi.status = 'CAPTURED') THEN 'CARD'
    WHEN EXISTS (SELECT 1 FROM "WalletEntry" we WHERE we."referenceType" = 'CHARGING_SESSION' AND we."referenceId" = cs.id AND we.type = 'CHARGE_DEBIT') THEN 'WALLET'
    ELSE 'UNPAID'
  END AS "paymentMethod"
`

const SESSIONS_FROM = Prisma.sql`
  FROM "ChargingSession" cs
  JOIN "Site" s ON s.id = cs."siteId"
  JOIN "ChargePoint" cp ON cp.id = cs."chargePointId"
  JOIN "Connector" co ON co.id = cs."connectorId"
  JOIN "Tariff" t ON t.id = cs."tariffId"
`

export async function getSessionsReportPage(
  scope: ReportingScope,
  window: PeriodWindow,
  filters: Pick<SessionsReportQuery, 'status' | 'paymentMethod' | 'minCostCents'>,
  page: number,
  pageSize: number,
): Promise<{ items: SessionReportRow[]; total: number }> {
  const where = whereSql([...tenantConditions(scope, 'cs'), ...periodConditions('cs', window.from, window.to), ...sessionsFilterConditions(filters)])

  const [items, countRows] = await Promise.all([
    prisma.$queryRaw<SessionReportRow[]>(Prisma.sql`
      SELECT ${SESSIONS_SELECT} ${SESSIONS_FROM} WHERE ${where} ORDER BY cs."startedAt" DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `),
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS "total" ${SESSIONS_FROM} WHERE ${where}`),
  ])

  return { items, total: toNumber(countRows[0]?.total) }
}

/** Para exportação CSV — mesma query, busca em LOTES (LIMIT/OFFSET) para nunca carregar tudo em memória. */
export function fetchSessionsReportBatch(
  scope: ReportingScope,
  window: PeriodWindow,
  filters: Pick<SessionsReportQuery, 'status' | 'paymentMethod' | 'minCostCents'>,
): (offset: number, limit: number) => Promise<SessionReportRow[]> {
  const where = whereSql([...tenantConditions(scope, 'cs'), ...periodConditions('cs', window.from, window.to), ...sessionsFilterConditions(filters)])
  return (offset: number, limit: number) =>
    prisma.$queryRaw<SessionReportRow[]>(Prisma.sql`
      SELECT ${SESSIONS_SELECT} ${SESSIONS_FROM} WHERE ${where} ORDER BY cs."startedAt" DESC LIMIT ${limit} OFFSET ${offset}
    `)
}
