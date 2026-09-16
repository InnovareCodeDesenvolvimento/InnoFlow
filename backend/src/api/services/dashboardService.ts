import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import type { ReportingScope } from '../lib/reportingScope'
import type { PeriodWindow } from '../lib/reportingWindow'
import { deltaPct } from '../lib/reportingWindow'
import { chargePointTenantConditions, periodConditions, tenantConditions, toNumber, whereSql } from '../lib/reportingSql'

/** "Online" = reportou (`lastSeenAt`) há menos que isto. Constante nomeada — nunca número mágico espalhado pelo código. */
export const CHARGE_POINT_ONLINE_THRESHOLD_MS = 5 * 60 * 1000

interface SessionAggregateRow {
  totalSessions: number
  completedSessions: number
  faultedSessions: number
  revenueCents: number
  energyWh: number
  idleFeeCents: number
  idleSeconds: number
  chargingSeconds: number
}

async function fetchSessionAggregate(scope: ReportingScope, from: Date, to: Date): Promise<SessionAggregateRow> {
  const where = whereSql([...tenantConditions(scope, 'cs'), ...periodConditions('cs', from, to)])
  const rows = await prisma.$queryRaw<SessionAggregateRow[]>(Prisma.sql`
    SELECT
      COUNT(*)::int AS "totalSessions",
      COUNT(*) FILTER (WHERE cs.status = 'STOPPED')::int AS "completedSessions",
      COUNT(*) FILTER (WHERE cs.status = 'FAULTED')::int AS "faultedSessions",
      COALESCE(SUM(cs."totalCostCents") FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "revenueCents",
      COALESCE(SUM(cs."energyDeliveredWh") FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "energyWh",
      COALESCE(SUM(cs."idleFeeCents") FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "idleFeeCents",
      COALESCE(SUM(cs."idleSeconds") FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "idleSeconds",
      COALESCE(SUM(EXTRACT(EPOCH FROM (cs."stoppedAt" - cs."startedAt"))) FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "chargingSeconds"
    FROM "ChargingSession" cs
    WHERE ${where}
  `)
  const row = rows[0]
  return {
    totalSessions: toNumber(row?.totalSessions),
    completedSessions: toNumber(row?.completedSessions),
    faultedSessions: toNumber(row?.faultedSessions),
    revenueCents: Math.round(toNumber(row?.revenueCents)),
    energyWh: Math.round(toNumber(row?.energyWh)),
    idleFeeCents: Math.round(toNumber(row?.idleFeeCents)),
    idleSeconds: Math.round(toNumber(row?.idleSeconds)),
    chargingSeconds: toNumber(row?.chargingSeconds),
  }
}

/**
 * Capacidade (nº de conectores ativos no escopo) usada para `utilizationPct`.
 * Assume que a topologia de conectores não muda significativamente dentro da
 * janela do relatório — simplificação aceitável no MVP (documentada no
 * handoff); reabrir se o dono adicionar/desativar conectores com frequência
 * e os números de utilização de períodos passados ficarem enganosos.
 */
async function fetchConnectorCapacity(scope: ReportingScope): Promise<number> {
  const chargePointWhere: Prisma.ChargePointWhereInput = { active: true }
  if (scope.chargePointId) chargePointWhere.id = scope.chargePointId
  else if (scope.siteId) chargePointWhere.siteId = scope.siteId

  return prisma.connector.count({
    where: {
      ...(scope.operatorId ? { operatorId: scope.operatorId } : {}),
      chargePoint: chargePointWhere,
    },
  })
}

interface PaymentSplitRow {
  cardCents: number
  walletCents: number
}

async function fetchPaymentSplit(scope: ReportingScope, from: Date, to: Date): Promise<PaymentSplitRow> {
  const sessionWhere = whereSql([...tenantConditions(scope, 'cs'), ...periodConditions('cs', from, to)])

  const [cardRows, walletRows] = await Promise.all([
    prisma.$queryRaw<{ cardCents: number }[]>(Prisma.sql`
      SELECT COALESCE(SUM(pi."amountCapturedCents"), 0)::float8 AS "cardCents"
      FROM "PaymentIntent" pi
      JOIN "ChargingSession" cs ON cs.id = pi."chargingSessionId"
      WHERE pi.purpose = 'SESSION_CARD_CAPTURE' AND pi.status = 'CAPTURED' AND ${sessionWhere}
    `),
    prisma.$queryRaw<{ walletCents: number }[]>(Prisma.sql`
      SELECT COALESCE(SUM(-we."amountCents"), 0)::float8 AS "walletCents"
      FROM "WalletEntry" we
      JOIN "ChargingSession" cs ON cs.id = we."referenceId"
      WHERE we.type = 'CHARGE_DEBIT' AND we."referenceType" = 'CHARGING_SESSION' AND ${sessionWhere}
    `),
  ])

  return {
    cardCents: Math.round(toNumber(cardRows[0]?.cardCents)),
    walletCents: Math.round(toNumber(walletRows[0]?.walletCents)),
  }
}

export interface RevenueByDayPoint {
  date: string
  revenueCents: number
  sessions: number
}

async function fetchRevenueByDay(scope: ReportingScope, from: Date, to: Date, tz: string): Promise<RevenueByDayPoint[]> {
  const where = whereSql([Prisma.sql`cs.status = 'STOPPED'`, ...tenantConditions(scope, 'cs'), ...periodConditions('cs', from, to)])
  const rows = await prisma.$queryRaw<RevenueByDayPoint[]>(Prisma.sql`
    SELECT
      (date_trunc('day', cs."startedAt" AT TIME ZONE ${tz}))::date::text AS "date",
      COALESCE(SUM(cs."totalCostCents"), 0)::float8 AS "revenueCents",
      COUNT(*)::int AS "sessions"
    FROM "ChargingSession" cs
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
  `)
  return rows.map((r) => ({ date: r.date, revenueCents: Math.round(toNumber(r.revenueCents)), sessions: toNumber(r.sessions) }))
}

export interface TopSiteRow {
  siteId: string
  siteName: string
  revenueCents: number
  sessions: number
}

async function fetchTopSites(scope: ReportingScope, from: Date, to: Date): Promise<TopSiteRow[]> {
  const where = whereSql([Prisma.sql`cs.status = 'STOPPED'`, ...tenantConditions(scope, 'cs'), ...periodConditions('cs', from, to)])
  const rows = await prisma.$queryRaw<TopSiteRow[]>(Prisma.sql`
    SELECT cs."siteId" AS "siteId", s.name AS "siteName",
      COALESCE(SUM(cs."totalCostCents"), 0)::float8 AS "revenueCents",
      COUNT(*)::int AS "sessions"
    FROM "ChargingSession" cs
    JOIN "Site" s ON s.id = cs."siteId"
    WHERE ${where}
    GROUP BY cs."siteId", s.name
    ORDER BY "revenueCents" DESC
    LIMIT 5
  `)
  return rows.map((r) => ({ ...r, revenueCents: Math.round(toNumber(r.revenueCents)), sessions: toNumber(r.sessions) }))
}

interface PeriodMetrics {
  revenueCents: number
  sessions: number
  energyWh: number
  avgTicketCents: number
  successRatePct: number
  utilizationPct: number
  revenuePerKwhCents: number
  idleFeeCents: number
  idleMinutes: number
}

function computeMetrics(agg: SessionAggregateRow, connectorCapacity: number, windowMs: number): PeriodMetrics {
  const avgTicketCents = agg.completedSessions > 0 ? Math.round(agg.revenueCents / agg.completedSessions) : 0
  // Taxa de sucesso só considera sessões que já chegaram a um estado
  // TERMINAL (STOPPED ou FAULTED) — uma sessão ainda em andamento
  // (STARTED/CHARGING/FINISHING) não teve chance de "falhar" ainda, incluí-la
  // no denominador subestimaria a taxa de sucesso de períodos recentes.
  const terminalSessions = agg.completedSessions + agg.faultedSessions
  const successRatePct = terminalSessions > 0 ? round2((agg.completedSessions / terminalSessions) * 100) : 0
  const capacitySeconds = connectorCapacity * (windowMs / 1000)
  const utilizationPct = capacitySeconds > 0 ? round2(Math.min(100, (agg.chargingSeconds / capacitySeconds) * 100)) : 0
  const kwh = agg.energyWh / 1000
  const revenuePerKwhCents = kwh > 0 ? round2(agg.revenueCents / kwh) : 0
  const idleMinutes = Math.round(agg.idleSeconds / 60)

  return {
    revenueCents: agg.revenueCents,
    sessions: agg.totalSessions,
    energyWh: agg.energyWh,
    avgTicketCents,
    successRatePct,
    utilizationPct,
    revenuePerKwhCents,
    idleFeeCents: agg.idleFeeCents,
    idleMinutes,
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export interface DashboardSummary {
  period: PeriodMetrics & { deltaPct: Record<keyof PeriodMetrics, number | null> }
  previousPeriod: PeriodMetrics
  paymentSplit: { cardCents: number; walletCents: number }
  revenueByDay: RevenueByDayPoint[]
  topSites: TopSiteRow[]
}

export async function getDashboardSummary(scope: ReportingScope, window: PeriodWindow): Promise<DashboardSummary> {
  const [currentAgg, previousAgg, connectorCapacity, paymentSplit, revenueByDay, topSites] = await Promise.all([
    fetchSessionAggregate(scope, window.from, window.to),
    fetchSessionAggregate(scope, window.previousFrom, window.previousTo),
    fetchConnectorCapacity(scope),
    fetchPaymentSplit(scope, window.from, window.to),
    fetchRevenueByDay(scope, window.from, window.to, window.tz),
    fetchTopSites(scope, window.from, window.to),
  ])

  const windowMs = window.to.getTime() - window.from.getTime()
  const previousWindowMs = window.previousTo.getTime() - window.previousFrom.getTime()

  const current = computeMetrics(currentAgg, connectorCapacity, windowMs)
  const previous = computeMetrics(previousAgg, connectorCapacity, previousWindowMs)

  const deltas = Object.fromEntries(
    (Object.keys(current) as (keyof PeriodMetrics)[]).map((key) => [key, deltaPct(current[key], previous[key])]),
  ) as Record<keyof PeriodMetrics, number | null>

  return {
    period: { ...current, deltaPct: deltas },
    previousPeriod: previous,
    paymentSplit,
    revenueByDay,
    topSites,
  }
}

// ------------------------------------------------------------
// /api/admin/dashboard/live — sem filtro de período, polling de 15s.
// ------------------------------------------------------------

export interface LiveSession {
  id: string
  chargePointId: string
  chargePointIdentity: string
  siteId: string
  siteName: string
  status: string
  startedAt: Date
  meterStartWh: number
  lastPowerW: number | null
  lastSoc: number | null
}

export interface DashboardLive {
  activeSessions: LiveSession[]
  chargePoints: { online: number; offline: number; faulted: number }
}

const LIVE_SESSIONS_LIMIT = 200

/**
 * `lastPowerW`/`lastSoc` são colunas que o Cronos está adicionando em
 * `ChargingSession` em paralelo (painel ao vivo) — NÃO existem ainda no
 * `schema.prisma` nem no client gerado nesta sessão. Por isso esta query usa
 * `$queryRaw` (não `prisma.chargingSession.findMany`): não depende de
 * regeneração do client para tipar, só precisa que a coluna exista no
 * Postgres em runtime. Ver PARA O PRÓXIMO no handoff — nomes exatos que o
 * Cronos precisa criar.
 */
export async function getDashboardLive(scope: ReportingScope): Promise<DashboardLive> {
  const sessionWhere = whereSql([Prisma.sql`cs.status IN ('STARTED', 'CHARGING', 'FINISHING')`, ...tenantConditions(scope, 'cs')])
  const chargePointWhere = whereSql(chargePointTenantConditions(scope, 'cp'))
  const onlineThreshold = new Date(Date.now() - CHARGE_POINT_ONLINE_THRESHOLD_MS)

  const [activeSessions, chargePointCounts] = await Promise.all([
    prisma.$queryRaw<LiveSession[]>(Prisma.sql`
      SELECT cs.id AS "id", cs."chargePointId" AS "chargePointId", cp."ocppIdentity" AS "chargePointIdentity",
        cs."siteId" AS "siteId", s.name AS "siteName", cs.status AS "status", cs."startedAt" AS "startedAt",
        cs."meterStartWh" AS "meterStartWh", cs."lastPowerW" AS "lastPowerW", cs."lastSoc" AS "lastSoc"
      FROM "ChargingSession" cs
      JOIN "ChargePoint" cp ON cp.id = cs."chargePointId"
      JOIN "Site" s ON s.id = cs."siteId"
      WHERE ${sessionWhere}
      ORDER BY cs."startedAt" DESC
      LIMIT ${LIVE_SESSIONS_LIMIT}
    `),
    prisma.$queryRaw<{ online: number; offline: number; faulted: number }[]>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Connector" c WHERE c."chargePointId" = cp.id AND c.status = 'FAULTED'))::int AS "faulted",
        COUNT(*) FILTER (
          WHERE NOT EXISTS (SELECT 1 FROM "Connector" c WHERE c."chargePointId" = cp.id AND c.status = 'FAULTED')
            AND cp."lastSeenAt" > ${onlineThreshold}
        )::int AS "online",
        COUNT(*) FILTER (
          WHERE NOT EXISTS (SELECT 1 FROM "Connector" c WHERE c."chargePointId" = cp.id AND c.status = 'FAULTED')
            AND (cp."lastSeenAt" IS NULL OR cp."lastSeenAt" <= ${onlineThreshold})
        )::int AS "offline"
      FROM "ChargePoint" cp
      WHERE ${chargePointWhere}
    `),
  ])

  const counts = chargePointCounts[0] ?? { online: 0, offline: 0, faulted: 0 }
  return {
    activeSessions,
    chargePoints: { online: toNumber(counts.online), offline: toNumber(counts.offline), faulted: toNumber(counts.faulted) },
  }
}
