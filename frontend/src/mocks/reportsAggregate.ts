/**
 * Agregações usadas pelos handlers MSW de retaguarda — é o equivalente, em
 * memória, das queries `$queryRaw` que o Vega vai escrever de verdade contra
 * `ChargingSession`/`PaymentIntent` (ver contrato da Nova). Não reimplementa
 * regra de negócio nova nenhuma: só agrupa o que `reportsData.ts` já gerou,
 * respeitando as mesmas regras (revenue nunca soma topup Pix, bucket de dia
 * por `startedAt`, escopo por operador).
 */
import { mockConnectors, mockOperators, mockSites } from "./data"
import {
  chargePointStatusCounts,
  estimateLiveEnergyWh,
  generatedSessions,
  liveSessions,
  walletTopups,
  type GeneratedSession,
} from "./reportsData"
import type {
  DailyMovementResponse,
  DailyMovementRow,
  DashboardLiveResponse,
  DashboardOperatorRanking,
  DashboardSiteRanking,
  DashboardSummaryResponse,
  MetricWithDelta,
  PaginationMeta,
  PaymentListRow,
  PaymentsReportResponse,
  RevenueBreakdownDimension,
  RevenueBreakdownRow,
  RevenueGranularity,
  RevenueReportResponse,
  Role,
  SessionDetail,
  SessionListRow,
  SessionsReportResponse,
} from "@/types/api"

export interface Scope {
  role: Role
  operatorId: string | null
}

/** ADMIN pode filtrar por qualquer operador (ou nenhum = todos); OPERATOR sempre escopado ao próprio, mesmo que mande outro no query. */
export function resolveOperatorScope(scope: Scope, requestedOperatorId?: string): string | null {
  if (scope.role === "ADMIN") return requestedOperatorId ?? null
  return scope.operatorId
}

function dateKey(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function inRange(d: Date, from: string, to: string): boolean {
  const key = dateKey(d)
  return key >= from && key <= to
}

function daysBetweenInclusive(from: string, to: string): string[] {
  const out: string[] = []
  const cursor = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  while (cursor.getTime() <= end.getTime()) {
    out.push(dateKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

function previousRange(from: string, to: string): { from: string; to: string } {
  const fromDate = new Date(`${from}T00:00:00`)
  const toDate = new Date(`${to}T00:00:00`)
  const spanDays = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1)
  const prevTo = new Date(fromDate)
  prevTo.setDate(prevTo.getDate() - 1)
  const prevFrom = new Date(prevTo)
  prevFrom.setDate(prevFrom.getDate() - (spanDays - 1))
  return { from: dateKey(prevFrom), to: dateKey(prevTo) }
}

function deltaPct(curr: number, prev: number): number | null {
  if (prev === 0) return null
  return ((curr - prev) / prev) * 100
}

function metric(curr: number, prev: number): MetricWithDelta {
  return { value: curr, deltaPct: deltaPct(curr, prev) }
}

export function filterSessions(opts: { from: string; to: string; siteId?: string; operatorScope: string | null }): GeneratedSession[] {
  return generatedSessions.filter((s) => {
    if (opts.operatorScope && s.operatorId !== opts.operatorScope) return false
    if (opts.siteId && s.siteId !== opts.siteId) return false
    return inRange(s.startedAt, opts.from, opts.to)
  })
}

function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; meta: PaginationMeta } {
  const start = (page - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    meta: { page, pageSize, total: items.length, totalPages: Math.max(1, Math.ceil(items.length / pageSize)) },
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function buildDashboardSummary(
  scope: Scope,
  query: { from: string; to: string; siteId?: string; operatorId?: string },
): DashboardSummaryResponse {
  const operatorScope = resolveOperatorScope(scope, query.operatorId)
  const current = filterSessions({ from: query.from, to: query.to, siteId: query.siteId, operatorScope })
  const prevRange = previousRange(query.from, query.to)
  const previous = filterSessions({ from: prevRange.from, to: prevRange.to, siteId: query.siteId, operatorScope })

  const stopped = current.filter((s) => s.status === "STOPPED")
  const prevStopped = previous.filter((s) => s.status === "STOPPED")

  const revenueCents = stopped.reduce((acc, s) => acc + (s.costs?.totalCostCents ?? 0), 0)
  const prevRevenueCents = prevStopped.reduce((acc, s) => acc + (s.costs?.totalCostCents ?? 0), 0)

  const energyWh = stopped.reduce((acc, s) => acc + (s.energyDeliveredWh ?? 0), 0)
  const prevEnergyWh = prevStopped.reduce((acc, s) => acc + (s.energyDeliveredWh ?? 0), 0)

  const sessionsCount = current.length
  const prevSessionsCount = previous.length

  const avgTicketCents = stopped.length > 0 ? Math.round(revenueCents / stopped.length) : 0
  const prevAvgTicketCents = prevStopped.length > 0 ? Math.round(prevRevenueCents / prevStopped.length) : 0

  const successRatePct = stopped.length > 0 ? (stopped.filter((s) => s.paymentStatus === "CAPTURED").length / stopped.length) * 100 : 0
  const prevSuccessRatePct = prevStopped.length > 0 ? (prevStopped.filter((s) => s.paymentStatus === "CAPTURED").length / prevStopped.length) * 100 : 0

  const connectorsInScope = mockConnectors.filter((c) => !operatorScope || c.operatorId === operatorScope).length
  const periodDays = daysBetweenInclusive(query.from, query.to).length
  const periodHours = periodDays * 24
  const chargingHours = stopped.reduce((acc, s) => acc + (s.stoppedAt && s.startedAt ? (s.stoppedAt.getTime() - s.startedAt.getTime()) / 3_600_000 : 0), 0)
  const utilizationPct = connectorsInScope > 0 ? Math.min(100, (chargingHours / (connectorsInScope * periodHours)) * 100) : 0
  const prevChargingHours = prevStopped.reduce((acc, s) => acc + (s.stoppedAt && s.startedAt ? (s.stoppedAt.getTime() - s.startedAt.getTime()) / 3_600_000 : 0), 0)
  const prevUtilizationPct = connectorsInScope > 0 ? Math.min(100, (prevChargingHours / (connectorsInScope * periodHours)) * 100) : 0

  const revenueByDayMap = new Map<string, number>()
  for (const s of stopped) {
    const key = dateKey(s.startedAt)
    revenueByDayMap.set(key, (revenueByDayMap.get(key) ?? 0) + (s.costs?.totalCostCents ?? 0))
  }
  const revenueByDay = daysBetweenInclusive(query.from, query.to).map((date) => ({ date, revenueCents: revenueByDayMap.get(date) ?? 0 }))

  const cardCents = stopped.filter((s) => s.paymentMethod === "CARD" && s.paymentStatus === "CAPTURED").reduce((acc, s) => acc + (s.costs?.totalCostCents ?? 0), 0)
  const walletCents = stopped.filter((s) => s.paymentMethod === "WALLET" && s.paymentStatus === "CAPTURED").reduce((acc, s) => acc + (s.costs?.totalCostCents ?? 0), 0)

  const siteAgg = new Map<string, { siteId: string; siteName: string; revenueCents: number; sessions: number }>()
  for (const s of stopped) {
    const entry = siteAgg.get(s.siteId) ?? { siteId: s.siteId, siteName: s.siteName, revenueCents: 0, sessions: 0 }
    entry.revenueCents += s.costs?.totalCostCents ?? 0
    entry.sessions += 1
    siteAgg.set(s.siteId, entry)
  }
  const topSites: DashboardSiteRanking[] = [...siteAgg.values()].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 5)

  let topOperators: DashboardOperatorRanking[] | undefined
  if (scope.role === "ADMIN") {
    const opAgg = new Map<string, { operatorId: string; operatorName: string; revenueCents: number; sessions: number }>()
    for (const s of stopped) {
      const entry = opAgg.get(s.operatorId) ?? { operatorId: s.operatorId, operatorName: mockOperators.find((o) => o.id === s.operatorId)?.name ?? s.operatorId, revenueCents: 0, sessions: 0 }
      entry.revenueCents += s.costs?.totalCostCents ?? 0
      entry.sessions += 1
      opAgg.set(s.operatorId, entry)
    }
    topOperators = [...opAgg.values()].sort((a, b) => b.revenueCents - a.revenueCents)
  }

  const today = dateKey(new Date())
  const todaySessions = filterSessions({ from: today, to: today, siteId: query.siteId, operatorScope }).filter((s) => s.status === "STOPPED")
  const todayAgg = new Map<string, { siteId: string; siteName: string; sessions: number; energyWh: number; revenueCents: number }>()
  for (const s of todaySessions) {
    const entry = todayAgg.get(s.siteId) ?? { siteId: s.siteId, siteName: s.siteName, sessions: 0, energyWh: 0, revenueCents: 0 }
    entry.sessions += 1
    entry.energyWh += s.energyDeliveredWh ?? 0
    entry.revenueCents += s.costs?.totalCostCents ?? 0
    todayAgg.set(s.siteId, entry)
  }

  return {
    period: { from: query.from, to: query.to, previousFrom: prevRange.from, previousTo: prevRange.to },
    metrics: {
      revenueCents: metric(revenueCents, prevRevenueCents),
      sessions: metric(sessionsCount, prevSessionsCount),
      energyWh: metric(energyWh, prevEnergyWh),
      avgTicketCents: metric(avgTicketCents, prevAvgTicketCents),
      successRatePct: metric(successRatePct, prevSuccessRatePct),
      utilizationPct: metric(utilizationPct, prevUtilizationPct),
    },
    revenueByDay,
    paymentSplit: { cardCents, walletCents },
    topSites,
    topOperators,
    todayMovement: [...todayAgg.values()].sort((a, b) => b.revenueCents - a.revenueCents),
  }
}

export function buildDashboardLive(scope: Scope, requestedOperatorId?: string): DashboardLiveResponse {
  const operatorScope = resolveOperatorScope(scope, requestedOperatorId)
  const now = new Date()
  const activeSessions = liveSessions
    .filter((s) => !operatorScope || s.operatorId === operatorScope)
    .map((s) => ({
      id: s.id,
      siteId: s.siteId,
      siteName: s.siteName,
      chargePointId: s.chargePointId,
      ocppIdentity: s.ocppIdentity,
      connectorId: s.connectorId,
      driverName: s.driverName,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      energyDeliveredWh: estimateLiveEnergyWh(s, now),
    }))

  return {
    activeSessions,
    chargePoints: chargePointStatusCounts(operatorScope),
    generatedAt: now.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Movimento diário
// ---------------------------------------------------------------------------

export function buildDailyMovement(
  scope: Scope,
  query: { from: string; to: string; siteId?: string; operatorId?: string; page: number; pageSize: number },
): DailyMovementResponse {
  const operatorScope = resolveOperatorScope(scope, query.operatorId)
  const sessions = filterSessions({ from: query.from, to: query.to, siteId: query.siteId, operatorScope }).filter((s) => s.status === "STOPPED")

  const agg = new Map<string, DailyMovementRow>()
  for (const s of sessions) {
    const key = `${dateKey(s.startedAt)}__${s.siteId}`
    const entry = agg.get(key) ?? { date: dateKey(s.startedAt), siteId: s.siteId, siteName: s.siteName, sessions: 0, energyWh: 0, revenueCents: 0, avgTicketCents: 0 }
    entry.sessions += 1
    entry.energyWh += s.energyDeliveredWh ?? 0
    entry.revenueCents += s.costs?.totalCostCents ?? 0
    agg.set(key, entry)
  }
  const rows = [...agg.values()].map((r) => ({ ...r, avgTicketCents: r.sessions > 0 ? Math.round(r.revenueCents / r.sessions) : 0 }))
  rows.sort((a, b) => (a.date === b.date ? a.siteName.localeCompare(b.siteName) : b.date.localeCompare(a.date)))

  const totals = rows.reduce(
    (acc, r) => ({ sessions: acc.sessions + r.sessions, energyWh: acc.energyWh + r.energyWh, revenueCents: acc.revenueCents + r.revenueCents }),
    { sessions: 0, energyWh: 0, revenueCents: 0 },
  )

  const { items, meta } = paginate(rows, query.page, query.pageSize)
  return { items, meta, totals }
}

// ---------------------------------------------------------------------------
// Faturamento
// ---------------------------------------------------------------------------

function bucketKey(d: Date, granularity: RevenueGranularity): string {
  if (granularity === "day") return dateKey(d)
  if (granularity === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
  // week: segunda-feira da semana, formato YYYY-MM-DD
  const monday = new Date(d)
  const dow = (monday.getDay() + 6) % 7
  monday.setDate(monday.getDate() - dow)
  return dateKey(monday)
}

function breakdownKeyLabel(s: GeneratedSession, dimension: RevenueBreakdownDimension): { key: string; label: string } {
  switch (dimension) {
    case "site":
      return { key: s.siteId, label: s.siteName }
    case "chargePoint":
      return { key: s.chargePointId, label: s.ocppIdentity }
    case "method":
      return { key: s.paymentMethod ?? "NONE", label: s.paymentMethod === "CARD" ? "Cartão" : s.paymentMethod === "WALLET" ? "Carteira" : "Sem cobrança" }
    case "tariff":
      return { key: s.tariffId, label: s.tariffName }
  }
}

export function buildRevenueReport(
  scope: Scope,
  query: { from: string; to: string; siteId?: string; operatorId?: string; granularity: RevenueGranularity; breakdown: RevenueBreakdownDimension },
): RevenueReportResponse {
  const operatorScope = resolveOperatorScope(scope, query.operatorId)
  const sessions = filterSessions({ from: query.from, to: query.to, siteId: query.siteId, operatorScope }).filter((s) => s.status === "STOPPED")

  const seriesAgg = new Map<string, RevenueBreakdownRow & { bucket: string }>()
  for (const s of sessions) {
    const bucket = bucketKey(s.startedAt, query.granularity)
    const entry = seriesAgg.get(bucket) ?? { bucket, key: bucket, label: bucket, revenueCents: 0, energyWh: 0, sessions: 0 }
    entry.revenueCents += s.costs?.totalCostCents ?? 0
    entry.energyWh += s.energyDeliveredWh ?? 0
    entry.sessions += 1
    seriesAgg.set(bucket, entry)
  }
  const series = [...seriesAgg.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)).map(({ bucket, revenueCents, energyWh, sessions: n }) => ({ bucket, revenueCents, energyWh, sessions: n }))

  const breakdownAgg = new Map<string, RevenueBreakdownRow>()
  for (const s of sessions) {
    const { key, label } = breakdownKeyLabel(s, query.breakdown)
    const entry = breakdownAgg.get(key) ?? { key, label, revenueCents: 0, energyWh: 0, sessions: 0 }
    entry.revenueCents += s.costs?.totalCostCents ?? 0
    entry.energyWh += s.energyDeliveredWh ?? 0
    entry.sessions += 1
    breakdownAgg.set(key, entry)
  }
  const breakdownRows = [...breakdownAgg.values()].sort((a, b) => b.revenueCents - a.revenueCents)

  const totals = sessions.reduce(
    (acc, s) => ({ revenueCents: acc.revenueCents + (s.costs?.totalCostCents ?? 0), energyWh: acc.energyWh + (s.energyDeliveredWh ?? 0), sessions: acc.sessions + 1 }),
    { revenueCents: 0, energyWh: 0, sessions: 0 },
  )

  return { granularity: query.granularity, breakdown: query.breakdown, series, breakdownRows, totals }
}

// ---------------------------------------------------------------------------
// Sessões (analítico + drill-down)
// ---------------------------------------------------------------------------

function toSessionListRow(s: GeneratedSession): SessionListRow {
  return {
    id: s.id,
    ocppTransactionId: s.ocppTransactionId,
    siteId: s.siteId,
    siteName: s.siteName,
    chargePointId: s.chargePointId,
    ocppIdentity: s.ocppIdentity,
    connectorId: s.connectorId,
    driverName: s.driverName,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    stoppedAt: s.stoppedAt ? s.stoppedAt.toISOString() : null,
    energyDeliveredWh: s.energyDeliveredWh,
    totalCostCents: s.costs?.totalCostCents ?? null,
    paymentMethod: s.paymentMethod,
    paymentStatus: s.paymentStatus,
  }
}

export function buildSessionsReport(
  scope: Scope,
  query: {
    from: string
    to: string
    siteId?: string
    operatorId?: string
    status?: string
    paymentMethod?: string
    minAmountCents?: number
    page: number
    pageSize: number
  },
): SessionsReportResponse {
  const operatorScope = resolveOperatorScope(scope, query.operatorId)
  let sessions = filterSessions({ from: query.from, to: query.to, siteId: query.siteId, operatorScope })
  if (query.status) sessions = sessions.filter((s) => s.status === query.status)
  if (query.paymentMethod) sessions = sessions.filter((s) => s.paymentMethod === query.paymentMethod)
  if (query.minAmountCents !== undefined) sessions = sessions.filter((s) => (s.costs?.totalCostCents ?? 0) >= query.minAmountCents!)

  sessions = [...sessions].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  const rows = sessions.map(toSessionListRow)
  const { items, meta } = paginate(rows, query.page, query.pageSize)
  return { items, meta }
}

export function findSessionDetail(scope: Scope, id: string): SessionDetail | null {
  const s = generatedSessions.find((x) => x.id === id)
  if (!s) return null
  const operatorScope = resolveOperatorScope(scope)
  if (operatorScope && s.operatorId !== operatorScope) return null

  return {
    id: s.id,
    ocppTransactionId: s.ocppTransactionId,
    site: { id: s.siteId, name: s.siteName },
    chargePoint: { id: s.chargePointId, ocppIdentity: s.ocppIdentity },
    connectorId: s.connectorId,
    driver: scope.role === "ADMIN" ? { name: s.driverName, email: s.driverEmail } : { name: s.driverName },
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    chargingEndedAt: s.chargingEndedAt ? s.chargingEndedAt.toISOString() : null,
    stoppedAt: s.stoppedAt ? s.stoppedAt.toISOString() : null,
    stopReason: s.stopReason,
    meterStartWh: s.meterStartWh,
    meterStopWh: s.meterStopWh,
    energyDeliveredWh: s.energyDeliveredWh,
    idleSeconds: s.idleSeconds,
    tariffName: s.tariffName,
    costs: {
      energyCostCents: s.costs?.energyCostCents ?? null,
      timeCostCents: s.costs?.timeCostCents ?? null,
      idleFeeCents: s.costs?.idleFeeCents ?? null,
      sessionFeeCents: s.costs?.sessionFeeCents ?? null,
      minChargeAdjustmentCents: s.costs?.minChargeAdjustmentCents ?? null,
      totalCostCents: s.costs?.totalCostCents ?? null,
    },
    paymentIntents: s.paymentIntents.map((pi) => ({ ...pi, createdAt: pi.createdAt.toISOString() })),
  }
}

// ---------------------------------------------------------------------------
// Financeiro / Pagamentos
// ---------------------------------------------------------------------------

export function buildPaymentsReport(
  scope: Scope,
  query: { from: string; to: string; siteId?: string; operatorId?: string; provider?: string; status?: string; page: number; pageSize: number },
): PaymentsReportResponse {
  const operatorScope = resolveOperatorScope(scope, query.operatorId)
  const sessions = filterSessions({ from: query.from, to: query.to, siteId: query.siteId, operatorScope })
  const stopped = sessions.filter((s) => s.status === "STOPPED")

  const revenueCents = stopped.reduce((acc, s) => acc + (s.costs?.totalCostCents ?? 0), 0)
  const cardCapturedCents = stopped.filter((s) => s.paymentMethod === "CARD" && s.paymentStatus === "CAPTURED").reduce((acc, s) => acc + (s.costs?.totalCostCents ?? 0), 0)
  // F5.4 — sessão CARD parada mas a captura ainda não foi confirmada pelo worker
  // (`SessionPaymentStatus` deste mock usa "PENDING" para esse estado, mesmo
  // vocabulário que já existia; no backend real é `PaymentIntent.CAPTURE_PENDING`).
  // Sem somar aqui, `differenceCents` ficaria "vermelho" nos segundos entre o
  // Stop e a captura — mesma identidade estendida do backend (`paymentsService.ts`).
  const cardCapturePendingCents = stopped.filter((s) => s.paymentMethod === "CARD" && s.paymentStatus === "PENDING").reduce((acc, s) => acc + (s.costs?.totalCostCents ?? 0), 0)
  const walletDebitCents = stopped.filter((s) => s.paymentMethod === "WALLET" && s.paymentStatus === "CAPTURED").reduce((acc, s) => acc + (s.costs?.totalCostCents ?? 0), 0)
  // F5.2 — dívida quitada automaticamente por crédito de Pix. Este mock ainda
  // não modela a ligação Debt↔WalletEntry(DEBT_SETTLEMENT) nas fixtures de
  // sessão, então fica honestamente em 0 em vez de inventar dado de demo —
  // ver `PaymentsReconciliation.debtSettledCents` em `types/api.ts`.
  const debtSettledCents = 0
  const openDebtCents = stopped.filter((s) => s.paymentStatus === "OPEN_DEBT").reduce((acc, s) => acc + (s.costs?.totalCostCents ?? 0), 0)
  const failedAttemptsCents = sessions.reduce(
    (acc, s) => acc + s.paymentIntents.filter((pi) => (pi.status === "DENIED" || pi.status === "FAILED") && inRange(pi.createdAt, query.from, query.to)).reduce((a, pi) => a + pi.amountRequestedCents, 0),
    0,
  )
  // Informativo (estorno/chargeback de cartão) — não modelado neste mock ainda, ver comentário do tipo.
  const cardRefundedCents = 0

  // Recarga de saldo (Pix) não pertence a nenhum operador (é float da rede) —
  // só ADMIN enxerga, e só quando não há filtro de site (site é conceito de operador).
  const walletTopupPixCents = scope.role === "ADMIN" && !operatorScope ? walletTopups.filter((t) => inRange(t.createdAt, query.from, query.to)).reduce((acc, t) => acc + t.amountCents, 0) : scope.role === "ADMIN" ? 0 : null

  const expectedCents = revenueCents
  const accountedCents = cardCapturedCents + cardCapturePendingCents + walletDebitCents + debtSettledCents + openDebtCents
  const differenceCents = expectedCents - accountedCents

  const rows: PaymentListRow[] = []
  for (const s of sessions) {
    for (const pi of s.paymentIntents) {
      if (!inRange(pi.createdAt, query.from, query.to)) continue
      rows.push({
        id: pi.id,
        purpose: "SESSION_CARD_CAPTURE",
        provider: pi.provider,
        status: pi.status,
        amountRequestedCents: pi.amountRequestedCents,
        amountCapturedCents: pi.amountCapturedCents,
        userName: s.driverName,
        chargingSessionId: s.id,
        siteId: s.siteId,
        siteName: s.siteName,
        createdAt: pi.createdAt.toISOString(),
      })
    }
  }
  if (scope.role === "ADMIN" && !operatorScope) {
    for (const t of walletTopups) {
      if (!inRange(t.createdAt, query.from, query.to)) continue
      rows.push({
        id: t.id,
        purpose: "WALLET_TOPUP_PIX",
        provider: "CIELO_PIX",
        status: "CAPTURED",
        amountRequestedCents: t.amountCents,
        amountCapturedCents: t.amountCents,
        userName: t.userName,
        chargingSessionId: null,
        siteId: null,
        siteName: null,
        createdAt: t.createdAt.toISOString(),
      })
    }
  }

  let filteredRows = rows
  if (query.provider) filteredRows = filteredRows.filter((r) => r.provider === query.provider)
  if (query.status) filteredRows = filteredRows.filter((r) => r.status === query.status)
  filteredRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const { items, meta } = paginate(filteredRows, query.page, query.pageSize)

  return {
    reconciliation: {
      revenueCents,
      cardCapturedCents,
      cardCapturePendingCents,
      walletDebitCents,
      debtSettledCents,
      walletTopupPixCents,
      openDebtCents,
      failedAttemptsCents,
      cardRefundedCents,
      expectedCents,
      accountedCents,
      differenceCents,
    },
    items,
    meta,
  }
}

export function listOperators(): Array<{ id: string; name: string; active: boolean }> {
  return mockOperators
}

export function siteBelongsToScope(scope: Scope, siteId: string): boolean {
  const site = mockSites.find((s) => s.id === siteId)
  if (!site) return false
  const operatorScope = resolveOperatorScope(scope)
  return !operatorScope || site.operatorId === operatorScope
}
