/**
 * Gerador de sessões sintéticas para os handlers de retaguarda (dashboard/
 * financeiro/relatórios). Mesma ideia do `seed-demo.ts` que o Cronos está
 * escrevendo para o Postgres real (ids/valores determinísticos, PRNG com
 * semente fixa) — aqui em memória, só para provar o CONTRATO no navegador
 * enquanto a rota real do Vega não existe (ver `[[projeto_innoelektron_validacao-sem-backend-vivo]]`).
 *
 * Duas narrativas de propósito (pedidas no escopo da retaguarda):
 * - OPERATOR_A: histórico rico (45 dias, 4 sites) — exercita gráfico, top 5,
 *   paginação, breakdown por dimensão.
 *   `site_1` é o site "mais fraco" dos 4 de propósito — junto com `site_2`
 *   dá para provar que o ranking não é só "mostra tudo".
 * - OPERATOR_B: só ~10 dias de histórico e dias sem sessão nenhuma — é o
 *   caso que testa estado vazio de verdade (regra explícita do escopo: "isso
 *   vai aparecer de verdade na demo").
 */
import {
  mockChargePoints,
  mockConnectors,
  mockDrivers,
  mockOperators,
  mockSites,
  mockTariffs,
  OPERATOR_A_ID,
  OPERATOR_B_ID,
} from "./data"
import type {
  ChargingSessionStatus,
  PaymentIntentStatus,
  PaymentProvider,
  SessionPaymentMethod,
  SessionPaymentStatus,
  SessionClosureInfo,
  SessionStopRequester,
  StopReason,
} from "@/types/api"

// ---------------------------------------------------------------------------
// PRNG determinístico (mulberry32) — mesma semente sempre, mesmos dados.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let state = seed
  return function next(): number {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(20260916)
const randInt = (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min
const pick = <T,>(arr: readonly T[]): T => arr[randInt(0, arr.length - 1)]
const chance = (p: number) => rng() < p

// ---------------------------------------------------------------------------
// Tarifação (mesma conta que `core/tarifacao/calcularCustoSessao()` vai usar
// de verdade — aqui reimplementada em TS puro só para o mock, não é o
// código de produção do Cronos).
// ---------------------------------------------------------------------------

interface TariffConfig {
  id: string
  name: string
  pricePerKwh: number
  sessionFeeCents: number
  minChargeCents: number
  idleFeePerMinute: number
  idleGracePeriodSeconds: number
}

const TARIFFS: Record<string, TariffConfig> = {
  tariff_1: { id: "tariff_1", name: "Padrão DC", pricePerKwh: 1.99, sessionFeeCents: 200, minChargeCents: 500, idleFeePerMinute: 50, idleGracePeriodSeconds: 300 },
  tariff_2: { id: "tariff_2", name: "Expressa Rodovia", pricePerKwh: 2.49, sessionFeeCents: 0, minChargeCents: 1000, idleFeePerMinute: 80, idleGracePeriodSeconds: 180 },
  tariff_3: { id: "tariff_3", name: "Padrão Posto", pricePerKwh: 1.79, sessionFeeCents: 0, minChargeCents: 500, idleFeePerMinute: 40, idleGracePeriodSeconds: 300 },
}

function computeCost(energyWh: number, idleSeconds: number, tariff: TariffConfig) {
  const energyCostCents = Math.round((energyWh / 1000) * tariff.pricePerKwh * 100)
  const timeCostCents = 0
  const billableIdleSeconds = Math.max(0, idleSeconds - tariff.idleGracePeriodSeconds)
  const idleFeeCents = Math.round((billableIdleSeconds / 60) * tariff.idleFeePerMinute)
  const sessionFeeCents = tariff.sessionFeeCents
  const subtotal = energyCostCents + timeCostCents + idleFeeCents + sessionFeeCents
  const minChargeAdjustmentCents = subtotal < tariff.minChargeCents ? tariff.minChargeCents - subtotal : 0
  const totalCostCents = subtotal + minChargeAdjustmentCents
  return { energyCostCents, timeCostCents, idleFeeCents, sessionFeeCents, minChargeAdjustmentCents, totalCostCents }
}

// ---------------------------------------------------------------------------
// Geração de sessões
// ---------------------------------------------------------------------------

export interface GeneratedSession {
  id: string
  ocppTransactionId: number
  operatorId: string
  siteId: string
  siteName: string
  chargePointId: string
  ocppIdentity: string
  connectorId: number
  driverName: string
  driverEmail: string
  status: ChargingSessionStatus
  startedAt: Date
  chargingEndedAt: Date | null
  stoppedAt: Date | null
  stopReason: StopReason | null
  meterStartWh: number
  meterStopWh: number | null
  energyDeliveredWh: number | null
  idleSeconds: number | null
  tariffId: string
  tariffName: string
  costs: ReturnType<typeof computeCost> | null
  paymentMethod: SessionPaymentMethod | null
  paymentStatus: SessionPaymentStatus | null
  /** F5.9 — ausente = fechamento normal pelo carregador (`closureOf` preenche o default). */
  closure?: SessionClosureInfo
  stopRequestedAt?: Date | null
  stopRequestedBy?: SessionStopRequester | null
  stopAttempts?: number
  lateStop?: { meterStopWh: number; stoppedAt: Date; receivedAt: Date; unbilledCostCents: number } | null
  paymentIntents: Array<{
    id: string
    provider: PaymentProvider
    status: PaymentIntentStatus
    amountRequestedCents: number
    amountCapturedCents: number | null
    createdAt: Date
  }>
}

interface SiteGenConfig {
  siteId: string
  siteName: string
  operatorId: string
  chargePointId: string
  ocppIdentity: string
  connectorIds: number[]
  tariffId: string
  days: number
  sessionsPerDay: [number, number]
  /** Fração de dias sem sessão nenhuma (0-1) — o caso de "estado vazio" do escopo. */
  sparseFraction: number
}

const SITE_CONFIGS: SiteGenConfig[] = [
  { siteId: "site_1", siteName: "Shopping Vila Norte", operatorId: OPERATOR_A_ID, chargePointId: "cp_1", ocppIdentity: "CP-VILA-NORTE-01", connectorIds: [1, 2], tariffId: "tariff_1", days: 45, sessionsPerDay: [2, 8], sparseFraction: 0.05 },
  { siteId: "site_3", siteName: "Terminal Rodoviário Barra Funda", operatorId: OPERATOR_A_ID, chargePointId: "cp_3", ocppIdentity: "CP-BARRA-FUNDA-01", connectorIds: [1, 2], tariffId: "tariff_1", days: 45, sessionsPerDay: [5, 15], sparseFraction: 0.02 },
  { siteId: "site_4", siteName: "Outlet Premium Campinas", operatorId: OPERATOR_A_ID, chargePointId: "cp_4", ocppIdentity: "CP-OUTLET-CAMPINAS-01", connectorIds: [1], tariffId: "tariff_2", days: 45, sessionsPerDay: [1, 6], sparseFraction: 0.1 },
  { siteId: "site_5", siteName: "Estação Rodovia Anhanguera", operatorId: OPERATOR_A_ID, chargePointId: "cp_5", ocppIdentity: "CP-ANHANGUERA-01", connectorIds: [1], tariffId: "tariff_2", days: 45, sessionsPerDay: [0, 4], sparseFraction: 0.2 },
  // Operador B: propositalmente curto (~10 dias) e cheio de buracos — é o
  // caso de "estado vazio real" pedido no escopo, não maquiado.
  { siteId: "site_2", siteName: "Posto Estrada Real", operatorId: OPERATOR_B_ID, chargePointId: "cp_2", ocppIdentity: "CP-ESTRADA-REAL-01", connectorIds: [1], tariffId: "tariff_3", days: 10, sessionsPerDay: [0, 3], sparseFraction: 0.45 },
]

let txCounter = 100000
let sessionCounter = 0
let paymentCounter = 0

function generateSessionsForSite(config: SiteGenConfig, now: Date): GeneratedSession[] {
  const sessions: GeneratedSession[] = []
  const tariff = TARIFFS[config.tariffId]

  for (let dayOffset = config.days - 1; dayOffset >= 0; dayOffset--) {
    const day = new Date(now)
    day.setDate(day.getDate() - dayOffset)
    day.setHours(0, 0, 0, 0)
    const isToday = dayOffset === 0

    if (chance(config.sparseFraction)) continue // dia sem sessão nenhuma, de propósito

    const count = randInt(config.sessionsPerDay[0], config.sessionsPerDay[1])
    const maxHour = isToday ? Math.max(6, now.getHours() - 1) : 22

    for (let i = 0; i < count; i++) {
      const hour = randInt(6, maxHour)
      const minute = randInt(0, 59)
      const startedAt = new Date(day)
      startedAt.setHours(hour, minute, 0, 0)
      if (startedAt.getTime() >= now.getTime()) continue

      const driver = pick(mockDrivers)
      const connectorId = pick(config.connectorIds)
      const isFaulted = chance(0.03)
      sessionCounter += 1
      const id = `demo_session_${sessionCounter}`
      txCounter += 1

      if (isFaulted) {
        sessions.push({
          id,
          ocppTransactionId: txCounter,
          operatorId: config.operatorId,
          siteId: config.siteId,
          siteName: config.siteName,
          chargePointId: config.chargePointId,
          ocppIdentity: config.ocppIdentity,
          connectorId,
          driverName: driver.name,
          driverEmail: driver.email,
          status: "FAULTED",
          startedAt,
          chargingEndedAt: null,
          stoppedAt: null,
          stopReason: "POWER_LOSS",
          meterStartWh: randInt(0, 50000),
          meterStopWh: null,
          energyDeliveredWh: null,
          idleSeconds: null,
          tariffId: tariff.id,
          tariffName: tariff.name,
          costs: null,
          paymentMethod: null,
          paymentStatus: null,
          paymentIntents: [],
        })
        continue
      }

      const energyWh = randInt(3000, 45000)
      const durationMinutes = randInt(15, 90)
      const idleSeconds = chance(0.35) ? randInt(0, 900) : 0
      const stoppedAt = new Date(startedAt.getTime() + (durationMinutes + idleSeconds / 60) * 60_000)
      const chargingEndedAt = new Date(startedAt.getTime() + durationMinutes * 60_000)
      const costs = computeCost(energyWh, idleSeconds, tariff)

      const outcomeRoll = rng()
      const paymentMethod: SessionPaymentMethod = chance(0.6) ? "CARD" : "WALLET"
      let paymentStatus: SessionPaymentStatus
      const paymentIntents: GeneratedSession["paymentIntents"] = []
      const provider: PaymentProvider = paymentMethod === "CARD" ? "CIELO_CARD" : "WALLET"

      if (outcomeRoll < 0.9) {
        // Sucesso de primeira.
        paymentStatus = "CAPTURED"
        paymentCounter += 1
        paymentIntents.push({
          id: `demo_pi_${paymentCounter}`,
          provider,
          status: "CAPTURED",
          amountRequestedCents: costs.totalCostCents,
          amountCapturedCents: costs.totalCostCents,
          createdAt: stoppedAt,
        })
      } else if (outcomeRoll < 0.97) {
        // Falhou uma vez (cartão recusado) e foi cobrado de novo com sucesso — linha "falhas/estornos".
        paymentStatus = "CAPTURED"
        paymentCounter += 1
        paymentIntents.push({
          id: `demo_pi_${paymentCounter}`,
          provider,
          status: "DENIED",
          amountRequestedCents: costs.totalCostCents,
          amountCapturedCents: null,
          createdAt: stoppedAt,
        })
        paymentCounter += 1
        paymentIntents.push({
          id: `demo_pi_${paymentCounter}`,
          provider,
          status: "CAPTURED",
          amountRequestedCents: costs.totalCostCents,
          amountCapturedCents: costs.totalCostCents,
          createdAt: new Date(stoppedAt.getTime() + 3_600_000),
        })
      } else {
        // Nunca conseguiu cobrar — vira dívida em aberto.
        paymentStatus = "OPEN_DEBT"
        paymentCounter += 1
        paymentIntents.push({
          id: `demo_pi_${paymentCounter}`,
          provider,
          status: "FAILED",
          amountRequestedCents: costs.totalCostCents,
          amountCapturedCents: null,
          createdAt: stoppedAt,
        })
      }

      sessions.push({
        id,
        ocppTransactionId: txCounter,
        operatorId: config.operatorId,
        siteId: config.siteId,
        siteName: config.siteName,
        chargePointId: config.chargePointId,
        ocppIdentity: config.ocppIdentity,
        connectorId,
        driverName: driver.name,
        driverEmail: driver.email,
        status: "STOPPED",
        startedAt,
        chargingEndedAt,
        stoppedAt,
        stopReason: "EV_DISCONNECTED",
        meterStartWh: randInt(0, 50000),
        meterStopWh: null,
        energyDeliveredWh: energyWh,
        idleSeconds,
        tariffId: tariff.id,
        tariffName: tariff.name,
        costs,
        paymentMethod: paymentStatus === "OPEN_DEBT" ? null : paymentMethod,
        paymentStatus,
        paymentIntents,
      })
    }
  }

  return sessions
}

const NOW = new Date()

export const generatedSessions: GeneratedSession[] = SITE_CONFIGS.flatMap((config) => generateSessionsForSite(config, NOW))

// ---------------------------------------------------------------------------
// F5.9 (sessão travada) — duas sessões FIXAS, anexadas DEPOIS da geração aleatória (a sequência do `rng` não muda, então
// o resto dos dados fica idêntico). IDs estáveis para o E2E: `demo_stuck_unconfirmed` e `demo_stuck_late_stop`.
// ---------------------------------------------------------------------------

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000)
}

function appendStuckSessions() {
  const tariff = TARIFFS.tariff_1
  const base = {
    operatorId: OPERATOR_A_ID,
    siteId: "site_1",
    siteName: "Shopping Vila Norte",
    chargePointId: "cp_1",
    ocppIdentity: "CP-VILA-NORTE-01",
    connectorId: 1,
    driverName: "Tiago Travado",
    driverEmail: "travado@innoelektron.com",
    tariffId: tariff.id,
    tariffName: tariff.name,
    chargingEndedAt: null,
  } as const

  // (1) Em confirmação: carregador sumiu; nada cobrado, sem custos.
  generatedSessions.push({
    ...base,
    id: "demo_stuck_unconfirmed",
    ocppTransactionId: 990001,
    status: "STOP_UNCONFIRMED",
    startedAt: minutesAgo(150),
    stoppedAt: null,
    stopReason: null,
    meterStartWh: 1200,
    meterStopWh: null,
    energyDeliveredWh: 14200,
    idleSeconds: null,
    costs: null,
    paymentMethod: "WALLET",
    paymentStatus: null,
    paymentIntents: [],
    stopRequestedAt: minutesAgo(40),
    stopRequestedBy: "DRIVER",
    stopAttempts: 2,
    closure: {
      source: null,
      meterStopSource: null,
      unconfirmedSince: minutesAgo(38).toISOString(),
      unconfirmedReason: "STOP_NOT_CONFIRMED",
      confirmDeadline: new Date(NOW.getTime() + 22 * 60_000).toISOString(),
      billedUntil: null,
    },
    lateStop: null,
  })

  // (2) Encerrada pelo servidor e, depois, chegou um StopTransaction tardio com MAIS energia (informativo; total não muda).
  const energyWh = 18000
  const costs = computeCost(energyWh, 0, tariff)
  const stoppedAt = minutesAgo(200)
  generatedSessions.push({
    ...base,
    id: "demo_stuck_late_stop",
    ocppTransactionId: 990002,
    status: "STOPPED",
    startedAt: minutesAgo(300),
    stoppedAt,
    stopReason: "OTHER",
    meterStartWh: 5000,
    meterStopWh: 5000 + energyWh,
    energyDeliveredWh: energyWh,
    idleSeconds: 0,
    costs,
    paymentMethod: "CARD",
    paymentStatus: "CAPTURED",
    paymentIntents: [
      { id: "demo_pi_stuck_1", provider: "CIELO_CARD", status: "CAPTURED", amountRequestedCents: costs.totalCostCents, amountCapturedCents: costs.totalCostCents, createdAt: stoppedAt },
    ],
    stopRequestedAt: minutesAgo(215),
    stopRequestedBy: "WATCHDOG",
    stopAttempts: 3,
    closure: {
      source: "SERVER",
      meterStopSource: "LAST_METER_SAMPLE",
      unconfirmedSince: minutesAgo(215).toISOString(),
      unconfirmedReason: "CHARGER_UNREACHABLE",
      confirmDeadline: null,
      billedUntil: stoppedAt.toISOString(),
    },
    lateStop: {
      meterStopWh: 5000 + energyWh + 3500,
      stoppedAt: minutesAgo(204),
      receivedAt: minutesAgo(120),
      unbilledCostCents: Math.round(3.5 * tariff.pricePerKwh * 100),
    },
  })
}
appendStuckSessions()

/** Recarga de saldo (Pix) — passivo da rede, NUNCA entra em faturamento (regra 3 da Nova). Só visível para ADMIN. */
export const walletTopups: Array<{ id: string; amountCents: number; createdAt: Date; userName: string }> = Array.from(
  { length: 40 },
  (_, i) => {
    const daysAgo = randInt(0, 44)
    const d = new Date(NOW)
    d.setDate(d.getDate() - daysAgo)
    d.setHours(randInt(7, 21), randInt(0, 59), 0, 0)
    return {
      id: `demo_topup_${i + 1}`,
      amountCents: randInt(2000, 20000),
      createdAt: d,
      userName: pick(mockDrivers).name,
    }
  },
).filter((t) => t.createdAt.getTime() < NOW.getTime())

// ---------------------------------------------------------------------------
// "Ao vivo": sessões em andamento agora — não fazem parte do histórico
// fechado acima (são STARTED/CHARGING, sem stoppedAt).
// ---------------------------------------------------------------------------

export interface LiveSession {
  id: string
  siteId: string
  siteName: string
  chargePointId: string
  ocppIdentity: string
  connectorId: number
  driverName: string
  status: ChargingSessionStatus
  startedAt: Date
  operatorId: string
}

export const liveSessions: LiveSession[] = [
  { id: "demo_live_1", siteId: "site_1", siteName: "Shopping Vila Norte", chargePointId: "cp_1", ocppIdentity: "CP-VILA-NORTE-01", connectorId: 2, driverName: pick(mockDrivers).name, status: "CHARGING", startedAt: new Date(NOW.getTime() - 22 * 60_000), operatorId: OPERATOR_A_ID },
  { id: "demo_live_2", siteId: "site_3", siteName: "Terminal Rodoviário Barra Funda", chargePointId: "cp_3", ocppIdentity: "CP-BARRA-FUNDA-01", connectorId: 1, driverName: pick(mockDrivers).name, status: "CHARGING", startedAt: new Date(NOW.getTime() - 7 * 60_000), operatorId: OPERATOR_A_ID },
  { id: "demo_live_3", siteId: "site_4", siteName: "Outlet Premium Campinas", chargePointId: "cp_4", ocppIdentity: "CP-OUTLET-CAMPINAS-01", connectorId: 1, driverName: pick(mockDrivers).name, status: "FINISHING", startedAt: new Date(NOW.getTime() - 58 * 60_000), operatorId: OPERATOR_A_ID },
  // Operador B fica sem sessão ativa nenhuma agora — exercita o painel "ao vivo" vazio.
]

/** Energia entregue "até agora" numa sessão viva — função do tempo decorrido, não estado mutável (mock sem timer). */
export function estimateLiveEnergyWh(session: LiveSession, at: Date): number {
  const elapsedMinutes = Math.max(0, (at.getTime() - session.startedAt.getTime()) / 60_000)
  const avgKwAssumed = 30 // potência média assumida para a curva sintética
  return Math.round(Math.min(elapsedMinutes, 90) * (avgKwAssumed / 60) * 1000)
}

/** Contadores online/offline/faulted por operador, a partir do estado dos conectores de cada charge point (mesma fonte que o CRUD já usa). */
export function chargePointStatusCounts(operatorId: string | null): { online: number; offline: number; faulted: number; total: number } {
  const points = operatorId ? mockChargePoints.filter((cp) => cp.operatorId === operatorId && cp.active) : mockChargePoints.filter((cp) => cp.active)
  let online = 0
  let offline = 0
  let faulted = 0
  for (const cp of points) {
    const connectors = mockConnectors.filter((c) => c.chargePointId === cp.id)
    if (connectors.some((c) => c.status === "FAULTED")) faulted += 1
    else if (connectors.length > 0 && connectors.every((c) => c.status === "UNAVAILABLE")) offline += 1
    else online += 1
  }
  return { online, offline, faulted, total: points.length }
}

export function siteName(siteId: string): string {
  return mockSites.find((s) => s.id === siteId)?.name ?? siteId
}

export function operatorName(operatorId: string): string {
  return mockOperators.find((o) => o.id === operatorId)?.name ?? operatorId
}

export function tariffLookup(): Record<string, TariffConfig> {
  return TARIFFS
}

export const ALL_TARIFFS = mockTariffs
