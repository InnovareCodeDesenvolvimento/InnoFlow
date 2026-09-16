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

export interface TopOperatorRow {
  operatorId: string
  operatorName: string
  revenueCents: number
  sessions: number
}

/**
 * Mesmo padrão de `fetchTopSites`, agrupado por operador em vez de site —
 * só faz sentido para ADMIN (`getDashboardSummary` só chama quando
 * `isAdmin`). Usa `cs."operatorId"` (coluna desnormalizada por trigger, já
 * existe na sessão — não precisa de join extra além de `Operator` para o
 * nome).
 */
async function fetchTopOperators(scope: ReportingScope, from: Date, to: Date): Promise<TopOperatorRow[]> {
  const where = whereSql([Prisma.sql`cs.status = 'STOPPED'`, ...tenantConditions(scope, 'cs'), ...periodConditions('cs', from, to)])
  const rows = await prisma.$queryRaw<TopOperatorRow[]>(Prisma.sql`
    SELECT cs."operatorId" AS "operatorId", o.name AS "operatorName",
      COALESCE(SUM(cs."totalCostCents"), 0)::float8 AS "revenueCents",
      COUNT(*)::int AS "sessions"
    FROM "ChargingSession" cs
    JOIN "Operator" o ON o.id = cs."operatorId"
    WHERE ${where}
    GROUP BY cs."operatorId", o.name
    ORDER BY "revenueCents" DESC
    LIMIT 5
  `)
  return rows.map((r) => ({ ...r, revenueCents: Math.round(toNumber(r.revenueCents)), sessions: toNumber(r.sessions) }))
}

export interface TodayMovementRow {
  siteId: string
  siteName: string
  sessions: number
  energyWh: number
  revenueCents: number
}

/**
 * "Movimento de hoje" (item explícito da Nova, nunca implementado na 1ª
 * entrega) — SEMPRE o dia de hoje NO FUSO DE CADA SITE, independente do
 * período (`period`/`from`/`to`) escolhido no resto do dashboard. Um único
 * `operatorId`/escopo pode ter sites em fusos diferentes; em vez de resolver
 * um fuso só para a página inteira (como o resto das rotas fazem), aqui
 * comparamos `cs."startedAt" AT TIME ZONE s.timezone` (por linha) contra
 * `now() AT TIME ZONE s.timezone` (mesma expressão, mesmo fuso da própria
 * linha) — cada site "vê" seu próprio dia corrente corretamente, num único
 * GROUP BY, sem N+1 de query por site.
 */
async function fetchTodayMovement(scope: ReportingScope): Promise<TodayMovementRow[]> {
  const where = whereSql(tenantConditions(scope, 'cs'))
  const rows = await prisma.$queryRaw<TodayMovementRow[]>(Prisma.sql`
    SELECT cs."siteId" AS "siteId", s.name AS "siteName",
      COUNT(*)::int AS "sessions",
      COALESCE(SUM(cs."energyDeliveredWh") FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "energyWh",
      COALESCE(SUM(cs."totalCostCents") FILTER (WHERE cs.status = 'STOPPED'), 0)::float8 AS "revenueCents"
    FROM "ChargingSession" cs
    JOIN "Site" s ON s.id = cs."siteId"
    WHERE ${where}
      AND (cs."startedAt" AT TIME ZONE s.timezone)::date = (now() AT TIME ZONE s.timezone)::date
    GROUP BY cs."siteId", s.name
    ORDER BY "revenueCents" DESC
  `)
  return rows.map((r) => ({ ...r, sessions: toNumber(r.sessions), energyWh: Math.round(toNumber(r.energyWh)), revenueCents: Math.round(toNumber(r.revenueCents)) }))
}

interface PeriodMetrics {
  revenueCents: number
  sessions: number
  energyWh: number
  avgTicketCents: number
  successRatePct: number
  utilizationPct: number
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

  return {
    revenueCents: agg.revenueCents,
    sessions: agg.totalSessions,
    energyWh: agg.energyWh,
    avgTicketCents,
    successRatePct,
    utilizationPct,
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export interface MetricWithDelta {
  value: number
  deltaPct: number | null
}

export interface DashboardSummary {
  period: { from: string; to: string; previousFrom: string; previousTo: string }
  metrics: Record<keyof PeriodMetrics, MetricWithDelta>
  revenueByDay: RevenueByDayPoint[]
  paymentSplit: { cardCents: number; walletCents: number }
  topSites: TopSiteRow[]
  topOperators?: TopOperatorRow[]
  todayMovement: TodayMovementRow[]
}

export async function getDashboardSummary(scope: ReportingScope, window: PeriodWindow, isAdmin: boolean): Promise<DashboardSummary> {
  const [currentAgg, previousAgg, connectorCapacity, paymentSplit, revenueByDay, topSites, todayMovement, topOperators] = await Promise.all([
    fetchSessionAggregate(scope, window.from, window.to),
    fetchSessionAggregate(scope, window.previousFrom, window.previousTo),
    fetchConnectorCapacity(scope),
    fetchPaymentSplit(scope, window.from, window.to),
    fetchRevenueByDay(scope, window.from, window.to, window.tz),
    fetchTopSites(scope, window.from, window.to),
    fetchTodayMovement(scope),
    isAdmin ? fetchTopOperators(scope, window.from, window.to) : Promise.resolve(undefined),
  ])

  const windowMs = window.to.getTime() - window.from.getTime()
  const previousWindowMs = window.previousTo.getTime() - window.previousFrom.getTime()

  const current = computeMetrics(currentAgg, connectorCapacity, windowMs)
  const previous = computeMetrics(previousAgg, connectorCapacity, previousWindowMs)

  const metrics = Object.fromEntries(
    (Object.keys(current) as (keyof PeriodMetrics)[]).map((key) => [key, { value: current[key], deltaPct: deltaPct(current[key], previous[key]) }]),
  ) as Record<keyof PeriodMetrics, MetricWithDelta>

  return {
    period: { from: window.from.toISOString(), to: window.to.toISOString(), previousFrom: window.previousFrom.toISOString(), previousTo: window.previousTo.toISOString() },
    metrics,
    revenueByDay,
    paymentSplit,
    topSites,
    ...(isAdmin ? { topOperators } : {}),
    todayMovement,
  }
}

// ------------------------------------------------------------
// /api/admin/dashboard/live — sem filtro de período, polling de 15s.
// ------------------------------------------------------------

export interface LiveSession {
  id: string
  siteId: string
  siteName: string
  chargePointId: string
  ocppIdentity: string
  connectorId: number
  driverName: string
  status: string
  startedAt: Date
  energyDeliveredWh: number
}

export interface DashboardLive {
  activeSessions: LiveSession[]
  chargePoints: { online: number; offline: number; faulted: number; total: number }
  generatedAt: string
}

const LIVE_SESSIONS_LIMIT = 200

/**
 * `energyDeliveredWh` de uma sessão ainda ativa vem da amostra MAIS RECENTE
 * de `MeterSample` (measurand `Energy.Active.Import.Register`, valor
 * absoluto do medidor em Wh — mesma escala de `meterStartWh`, confirmado no
 * `seed-demo.ts`) menos `meterStartWh`; 0 se a sessão ainda não tem nenhuma
 * amostra (acabou de iniciar). É a ÚNICA rota do módulo de retaguarda que lê
 * `MeterSample` — aceitável porque é limitada a `LIVE_SESSIONS_LIMIT` sessões
 * ATIVAS (não uma agregação sobre um período arbitrário) e o
 * `LATERAL ... ORDER BY ts DESC LIMIT 1` usa o índice `(sessionId, ts)` já
 * existente.
 *
 * `driverName` vem direto de `ChargingSession.userId -> User.name` — não
 * precisa passar por `AuthToken` (que tem `userId` opcional): `userId` em
 * `ChargingSession` é NOT NULL por regra de negócio (Authorize sempre
 * resolve um pagador antes de a sessão existir), então todo User é real e
 * tem nome. Mais simples do que o caminho original sugerido e correto para
 * o schema atual.
 */
export async function getDashboardLive(scope: ReportingScope): Promise<DashboardLive> {
  const sessionWhere = whereSql([Prisma.sql`cs.status IN ('STARTED', 'CHARGING', 'FINISHING')`, ...tenantConditions(scope, 'cs')])
  const chargePointWhere = whereSql(chargePointTenantConditions(scope, 'cp'))
  const onlineThreshold = new Date(Date.now() - CHARGE_POINT_ONLINE_THRESHOLD_MS)

  const [activeSessions, chargePointCounts] = await Promise.all([
    prisma.$queryRaw<LiveSession[]>(Prisma.sql`
      SELECT cs.id AS "id", cs."siteId" AS "siteId", s.name AS "siteName",
        cs."chargePointId" AS "chargePointId", cp."ocppIdentity" AS "ocppIdentity",
        co."connectorId" AS "connectorId", u.name AS "driverName",
        cs.status AS "status", cs."startedAt" AS "startedAt",
        GREATEST(0, ROUND(COALESCE(latest_meter.value, cs."meterStartWh") - cs."meterStartWh"))::int AS "energyDeliveredWh"
      FROM "ChargingSession" cs
      JOIN "ChargePoint" cp ON cp.id = cs."chargePointId"
      JOIN "Site" s ON s.id = cs."siteId"
      JOIN "Connector" co ON co.id = cs."connectorId"
      JOIN "User" u ON u.id = cs."userId"
      LEFT JOIN LATERAL (
        SELECT ms.value
        FROM "MeterSample" ms
        WHERE ms."sessionId" = cs.id AND ms.measurand = 'Energy.Active.Import.Register'
        ORDER BY ms.ts DESC
        LIMIT 1
      ) latest_meter ON true
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
  const online = toNumber(counts.online)
  const offline = toNumber(counts.offline)
  const faulted = toNumber(counts.faulted)
  return {
    activeSessions: activeSessions.map((s) => ({ ...s, connectorId: toNumber(s.connectorId), energyDeliveredWh: toNumber(s.energyDeliveredWh) })),
    chargePoints: { online, offline, faulted, total: online + offline + faulted },
    generatedAt: new Date().toISOString(),
  }
}
