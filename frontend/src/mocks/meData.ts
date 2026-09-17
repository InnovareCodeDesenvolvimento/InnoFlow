/**
 * Simulação em memória do PWA do motorista (`/api/public/charge-points/:id`,
 * `/api/me/*`) — mesmo espírito do resto de `mocks/`: fiel ao contrato
 * (`frontend/src/types/api.ts`), NÃO reimplementa a regra de negócio real
 * (`avaliarInicioSessao`/`calcularCustoSessao` do backend), só o suficiente
 * pra provar no navegador que a máquina de estados da UI (conectando →
 * carregando → parando → recibo) funciona com atraso realista entre os
 * passos — sem isso, o fluxo "conectando"/"parando" nunca apareceria em tela
 * (tudo resolveria no mesmo tick).
 */
import { mockChargePoints, mockConnectors, mockSites, mockTariffs } from "./data"
import type {
  ChargingSessionStatus,
  ConnectorType,
  MeActiveSession,
  MeSessionDetail,
  MeSessionListItem,
  MeWalletEntryDTO,
  PublicChargePointCard,
  PublicChargePointConnector,
  PublicTariffSummary,
} from "@/types/api"

/** Simula `TariffAssignment`: só alguns conectores têm tarifa vinculada — prova em tela o caso "conector sem tarifa" (cp_5/conn_7, fora desta lista). */
const TARIFF_BY_CONNECTOR: Record<string, string> = {
  conn_1: "tariff_1",
  conn_2: "tariff_1",
  conn_4: "tariff_2",
  conn_5: "tariff_2",
}

const CHARGE_RATE_W = 7000 // potência simulada constante — suficiente pra provar a UI, não é física real

function toPublicTariff(tariffId: string): PublicTariffSummary | null {
  const t = mockTariffs.find((x) => x.id === tariffId)
  if (!t) return null
  return {
    name: t.name,
    model: t.model,
    pricePerKwh: t.pricePerKwh !== null ? String(t.pricePerKwh) : null,
    pricePerMinute: t.pricePerMinute !== null ? String(t.pricePerMinute) : null,
    sessionFeeCents: t.sessionFeeCents,
    minChargeCents: t.minChargeCents,
    idleFeePerMinute: t.idleFeePerMinute,
    currency: t.currency,
  }
}

export function getPublicChargePointCard(ocppIdentity: string): PublicChargePointCard | null {
  const cp = mockChargePoints.find((c) => c.ocppIdentity === ocppIdentity && c.active)
  if (!cp) return null
  const site = mockSites.find((s) => s.id === cp.siteId)
  const connectors: PublicChargePointConnector[] = mockConnectors
    .filter((c) => c.chargePointId === cp.id)
    .map((c) => ({
      connectorId: c.connectorId,
      type: c.type,
      maxPowerKw: c.maxPowerKw !== null ? String(c.maxPowerKw) : null,
      status: c.status,
      tariff: TARIFF_BY_CONNECTOR[c.id] ? toPublicTariff(TARIFF_BY_CONNECTOR[c.id]) : null,
    }))
  return {
    ocppIdentity: cp.ocppIdentity,
    vendor: cp.vendor,
    model: cp.model,
    online: cp.active,
    site: {
      id: site?.id ?? "",
      name: site?.name ?? "",
      addressLine: site?.addressLine ?? null,
      city: site?.city ?? null,
      state: site?.state ?? null,
    },
    connectors,
    generatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Comandos assíncronos (fire-and-forget) — resolvem sozinhos depois de um
// atraso, simulando o tempo real de ida e volta até o carregador.
// ---------------------------------------------------------------------------

interface CommandRecord {
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "TIMEOUT"
  resolveAt: number
}
const commands = new Map<string, CommandRecord>()
let correlationCounter = 1

function createCommand(delayMs: number): string {
  const correlationId = `corr_${correlationCounter++}`
  commands.set(correlationId, { status: "PENDING", resolveAt: Date.now() + delayMs })
  return correlationId
}

export function getCommandStatus(correlationId: string): CommandRecord["status"] {
  const record = commands.get(correlationId)
  if (!record) return "PENDING"
  if (record.status === "PENDING" && Date.now() >= record.resolveAt) record.status = "ACCEPTED"
  return record.status
}

// ---------------------------------------------------------------------------
// Sessão ativa (uma por vez, driver único nesta simulação)
// ---------------------------------------------------------------------------

interface MockSession {
  id: string
  driverId: string
  ocppIdentity: string
  connectorId: number
  connectorType: ConnectorType
  siteId: string
  siteName: string
  siteAddressLine: string | null
  siteCity: string | null
  tariff: PublicTariffSummary
  startedAt: string
  stopRequestedAt: string | null
}

let pendingSession: (MockSession & { promoteAt: number }) | null = null
let activeSession: MockSession | null = null
let sessionCounter = 1
const sessionsHistory: MeSessionDetail[] = []

function computeEnergyWh(startedAt: string, atMs = Date.now()): number {
  const elapsedH = (atMs - new Date(startedAt).getTime()) / 3_600_000
  return Math.max(0, Math.round(elapsedH * CHARGE_RATE_W))
}

/**
 * Custo BRUTO (energia + taxa fixa), SEM aplicar o piso da cobrança mínima —
 * é o que `estimatedCostCents` da sessão ATIVA mostra (`MeActiveSession` não
 * tem `minChargeAdjustmentCents`, só `MeSessionDetail` no recibo tem). O piso
 * só vira ajuste real no fechamento (`finalizeSession`). Achado corrigindo
 * este mock: se o floor fosse aplicado aqui também, o card "mínimo da
 * sessão" do frontend nunca apareceria — `estimatedCostCents` já viria
 * sempre igual ou maior que `minChargeCents`, nunca menor.
 */
function computeRawCostCents(tariff: PublicTariffSummary, energyWh: number): number {
  let cents = 0
  if (tariff.pricePerKwh) cents += Math.round((energyWh / 1000) * Number(tariff.pricePerKwh) * 100)
  if (tariff.sessionFeeCents) cents += tariff.sessionFeeCents
  return cents
}

function maybePromotePendingSession() {
  if (pendingSession && Date.now() >= pendingSession.promoteAt) {
    const promoted = pendingSession
    activeSession = {
      id: promoted.id,
      driverId: promoted.driverId,
      ocppIdentity: promoted.ocppIdentity,
      connectorId: promoted.connectorId,
      connectorType: promoted.connectorType,
      siteId: promoted.siteId,
      siteName: promoted.siteName,
      siteAddressLine: promoted.siteAddressLine,
      siteCity: promoted.siteCity,
      tariff: promoted.tariff,
      startedAt: promoted.startedAt,
      stopRequestedAt: promoted.stopRequestedAt,
    }
    pendingSession = null
  }
}

export function startMockSession(
  driverId: string,
  ocppIdentity: string,
  connectorId: number,
):
  | { ok: true; correlationId: string; walletBalanceCents: number; estimatedMaxCostCents: number; minChargeCents: number | null }
  | { ok: false; code: string; message: string } {
  maybePromotePendingSession()
  if (activeSession || pendingSession) return { ok: false, code: "ALREADY_HAS_ACTIVE_SESSION", message: "Você já tem uma recarga em andamento." }

  const cp = mockChargePoints.find((c) => c.ocppIdentity === ocppIdentity)
  if (!cp) return { ok: false, code: "CHARGE_POINT_NOT_FOUND", message: "Carregador não encontrado." }
  const connector = mockConnectors.find((c) => c.chargePointId === cp.id && c.connectorId === connectorId)
  if (!connector) return { ok: false, code: "CONNECTOR_NOT_FOUND", message: "Conector não encontrado." }
  const tariff = TARIFF_BY_CONNECTOR[connector.id] ? toPublicTariff(TARIFF_BY_CONNECTOR[connector.id]) : null
  if (!tariff) return { ok: false, code: "CONNECTOR_NOT_FOUND", message: "Este conector ainda não tem tarifa cadastrada." }

  const wallet = getWalletState(driverId)
  if (wallet.openDebtCents > 0) return { ok: false, code: "DRIVER_HAS_OPEN_DEBT", message: "Você tem uma dívida em aberto — quite-a na carteira antes de carregar de novo." }
  if (wallet.balanceCents < 2000) return { ok: false, code: "INSUFFICIENT_BALANCE", message: "Saldo insuficiente para iniciar uma recarga." }

  const site = mockSites.find((s) => s.id === cp.siteId)
  const correlationId = createCommand(2500)

  pendingSession = {
    id: `me_session_${sessionCounter++}`,
    driverId,
    ocppIdentity,
    connectorId,
    connectorType: connector.type,
    siteId: cp.siteId,
    siteName: site?.name ?? "",
    siteAddressLine: site?.addressLine ?? null,
    siteCity: site?.city ?? null,
    tariff,
    startedAt: new Date().toISOString(),
    stopRequestedAt: null,
    promoteAt: Date.now() + 4000, // simula o intervalo até o StartTransaction real chegar
  }

  const estimatedMaxCostCents = Math.max(2000, Math.round(Number(tariff.pricePerKwh ?? 0) * 60 * 100))
  return { ok: true, correlationId, walletBalanceCents: wallet.balanceCents, estimatedMaxCostCents, minChargeCents: tariff.minChargeCents }
}

export function getMockActiveSession(driverId: string): MeActiveSession | null {
  maybePromotePendingSession()

  if (activeSession && activeSession.driverId === driverId && activeSession.stopRequestedAt) {
    const stopElapsedMs = Date.now() - new Date(activeSession.stopRequestedAt).getTime()
    if (stopElapsedMs > 4000) {
      finalizeSession()
      return null
    }
  }

  if (!activeSession || activeSession.driverId !== driverId) return null

  const elapsedMs = Date.now() - new Date(activeSession.startedAt).getTime()
  let status: ChargingSessionStatus = elapsedMs > 3000 ? "CHARGING" : "STARTED"
  if (activeSession.stopRequestedAt) status = "FINISHING"

  const atMs = activeSession.stopRequestedAt ? new Date(activeSession.stopRequestedAt).getTime() : Date.now()
  const energyWh = computeEnergyWh(activeSession.startedAt, atMs)
  const estimatedCostCents = computeRawCostCents(activeSession.tariff, energyWh)
  const estimatedMaxCostCents = Math.max(estimatedCostCents, Math.round(Number(activeSession.tariff.pricePerKwh ?? 0) * 60 * 100))

  return {
    id: activeSession.id,
    status,
    startedAt: activeSession.startedAt,
    chargePoint: { ocppIdentity: activeSession.ocppIdentity, vendor: null, model: null },
    site: { id: activeSession.siteId, name: activeSession.siteName, addressLine: activeSession.siteAddressLine, city: activeSession.siteCity },
    connector: { connectorId: activeSession.connectorId, type: activeSession.connectorType, maxPowerKw: null },
    energyDeliveredWh: energyWh,
    lastPowerW: status === "CHARGING" ? CHARGE_RATE_W : null,
    lastSoc: null,
    lastSampleAt: new Date().toISOString(),
    estimatedCostCents,
    estimatedMaxCostCents,
    minChargeCents: activeSession.tariff.minChargeCents,
    tariff: activeSession.tariff,
  }
}

export function stopMockSession(driverId: string, sessionId: string): { ok: true; correlationId: string } | { ok: false; code: string; message: string } {
  maybePromotePendingSession()
  if (!activeSession || activeSession.driverId !== driverId || activeSession.id !== sessionId) {
    return { ok: false, code: "SESSION_NOT_FOUND", message: "Sessão não encontrada." }
  }
  if (activeSession.stopRequestedAt) {
    return { ok: false, code: "SESSION_NOT_ACTIVE", message: "Esta sessão já está sendo encerrada." }
  }
  activeSession.stopRequestedAt = new Date().toISOString()
  const correlationId = createCommand(2000)
  return { ok: true, correlationId }
}

function finalizeSession() {
  if (!activeSession) return
  const finishedAt = new Date().toISOString()
  const atMs = activeSession.stopRequestedAt ? new Date(activeSession.stopRequestedAt).getTime() : Date.now()
  const energyWh = computeEnergyWh(activeSession.startedAt, atMs)
  const tariff = activeSession.tariff

  const energyCostCents = tariff.pricePerKwh ? Math.round((energyWh / 1000) * Number(tariff.pricePerKwh) * 100) : null
  const sessionFeeCents = tariff.sessionFeeCents ?? null
  let subtotal = (energyCostCents ?? 0) + (sessionFeeCents ?? 0)
  let minChargeAdjustmentCents: number | null = null
  if (tariff.minChargeCents && subtotal < tariff.minChargeCents) {
    minChargeAdjustmentCents = tariff.minChargeCents - subtotal
    subtotal = tariff.minChargeCents
  }
  const totalCostCents = subtotal

  const wallet = getWalletState(activeSession.driverId)
  const balanceAfter = wallet.balanceCents - totalCostCents
  wallet.balanceCents = balanceAfter
  const walletEntryId = `we_${sessionCounter}`
  const entry: MeWalletEntryDTO = {
    id: walletEntryId,
    type: "CHARGE_DEBIT",
    amountCents: -totalCostCents,
    balanceAfterCents: balanceAfter,
    referenceType: "CHARGING_SESSION",
    referenceId: activeSession.id,
    description: `Recarga em ${activeSession.siteName}`,
    createdAt: finishedAt,
  }
  wallet.entries.unshift(entry)

  const detail: MeSessionDetail = {
    id: activeSession.id,
    status: "STOPPED",
    startedAt: activeSession.startedAt,
    stoppedAt: finishedAt,
    stopReason: "LOCAL",
    site: { name: activeSession.siteName, addressLine: activeSession.siteAddressLine, city: activeSession.siteCity },
    chargePoint: { ocppIdentity: activeSession.ocppIdentity },
    connector: { connectorId: activeSession.connectorId, type: activeSession.connectorType },
    energyDeliveredWh: energyWh,
    idleSeconds: 0,
    energyCostCents,
    timeCostCents: null,
    idleFeeCents: null,
    sessionFeeCents,
    minChargeAdjustmentCents,
    totalCostCents,
    tariff,
    walletEntry: { id: walletEntryId, amountCents: -totalCostCents, balanceAfterCents: balanceAfter, createdAt: finishedAt },
    debt: null,
  }
  sessionsHistory.unshift(detail)
  activeSession = null
}

export function listMockSessions(page: number, pageSize: number): { items: MeSessionListItem[]; total: number; page: number; pageSize: number } {
  const items: MeSessionListItem[] = sessionsHistory.map((s) => ({
    id: s.id,
    status: s.status,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    siteName: s.site.name,
    ocppIdentity: s.chargePoint.ocppIdentity,
    connectorId: s.connector.connectorId,
    energyDeliveredWh: s.energyDeliveredWh,
    totalCostCents: s.totalCostCents,
  }))
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize }
}

export function getMockSessionDetail(id: string): MeSessionDetail | null {
  return sessionsHistory.find((s) => s.id === id) ?? null
}

// ---------------------------------------------------------------------------
// Carteira do motorista
// ---------------------------------------------------------------------------

interface WalletState {
  balanceCents: number
  openDebtCents: number
  entries: MeWalletEntryDTO[]
}
const walletByDriver = new Map<string, WalletState>()

function getWalletState(driverId: string): WalletState {
  if (!walletByDriver.has(driverId)) {
    const seedAt = new Date(Date.now() - 86_400_000).toISOString()
    walletByDriver.set(driverId, {
      balanceCents: 5000,
      openDebtCents: 0,
      entries: [
        {
          id: "we_seed",
          type: "TOPUP_PIX",
          amountCents: 5000,
          balanceAfterCents: 5000,
          referenceType: null,
          referenceId: null,
          description: "Saldo inicial de demonstração",
          createdAt: seedAt,
        },
      ],
    })
  }
  return walletByDriver.get(driverId) as WalletState
}

export function getMockWallet(driverId: string, page: number, pageSize: number) {
  const wallet = getWalletState(driverId)
  const start = (page - 1) * pageSize
  return {
    balanceCents: wallet.balanceCents,
    openDebtCents: wallet.openDebtCents,
    entries: pageSize > 0 ? wallet.entries.slice(start, start + pageSize) : [],
    total: wallet.entries.length,
    page,
    pageSize,
  }
}
