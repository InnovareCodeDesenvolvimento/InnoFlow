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
import QRCode from "qrcode"
import { mockChargePoints, mockConnectors, mockSites, mockTariffs } from "./data"
import { extraStations } from "./stationsData"
import type {
  CardBrand,
  ChargingSessionStatus,
  ConnectorType,
  MeActiveSession,
  MeCardTokenizationSessionResponse,
  MePaymentMethodDTO,
  MeSessionDetail,
  MeSessionListItem,
  MeSessionPaymentInfo,
  MeStartSessionRequest,
  MeTopupDTO,
  MeTopupStatus,
  MeWalletEntryDTO,
  PaymentIntentStatus,
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

/** Carregadores das estações EXTRAS do mapa (`stationsData.ts`) — o detalhe da estação busca preço por aqui. DC com a tarifa DC, AC com a do posto. */
function getExtraStationCard(ocppIdentity: string): PublicChargePointCard | null {
  for (const station of extraStations) {
    const cp = station.chargePoints.find((c) => c.ocppIdentity === ocppIdentity)
    if (!cp) continue
    return {
      ocppIdentity: cp.ocppIdentity,
      vendor: cp.vendor,
      model: cp.model,
      online: cp.online,
      site: { id: station.id, name: station.name, addressLine: station.addressLine, city: station.city, state: station.state },
      connectors: cp.connectors.map((c) => ({
        connectorId: c.connectorId,
        type: c.type,
        maxPowerKw: String(c.maxPowerKw),
        status: c.status,
        tariff: toPublicTariff(c.type === "AC_TYPE2" ? "tariff_3" : "tariff_1"),
      })),
      generatedAt: new Date().toISOString(),
    }
  }
  return null
}

export function getPublicChargePointCard(ocppIdentity: string): PublicChargePointCard | null {
  const cp = mockChargePoints.find((c) => c.ocppIdentity === ocppIdentity && c.active)
  if (!cp) return getExtraStationCard(ocppIdentity)
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

/**
 * Forma de pagamento da sessão (F5.4) — `card` só existe em `paymentMode ===
 * "CARD"`, espelhando o `payment` opcional do `MeStartSessionRequest`.
 * `authorizedCents` é fixado no START (pré-auth síncrona, ver
 * decisoes-f5-pagamento-cielo.md §2) e nunca muda depois.
 */
interface MockSessionPayment {
  mode: "WALLET" | "CARD"
  card: { paymentMethodId: string; brand: string; last4: string | null; authorizedCents: number } | null
}

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
  payment: MockSessionPayment
}

let pendingSession: (MockSession & { promoteAt: number }) | null = null
let activeSession: MockSession | null = null
let sessionCounter = 1
const sessionsHistory: MeSessionDetail[] = []

/**
 * Captura de cartão (F5.4) — lazy-resolve (mesmo padrão de
 * `resolveTopupStatus`): `CAPTURE_PENDING` até `resolveAt`, depois vira
 * `CAPTURED` (ou parcial, ver `CARD_PARTIAL_CAPTURE_MARKER`) na PRÓXIMA
 * leitura, nunca por um timer — assim nenhuma aba esquecida aberta continua
 * rodando setTimeout de fundo. Indexado por `MeSessionDetail.id`.
 */
interface MockCardCapture {
  brand: string
  last4: string | null
  authorizedCents: number
  totalCostCents: number
  /** Quanto a captura VAI resolver quando `resolveAt` passar — pode ser menor que `totalCostCents` (cenário de dívida residual). */
  targetCapturedCents: number
  resolveAt: number
  status: PaymentIntentStatus
  capturedCents: number | null
}
const cardCapturesBySession = new Map<string, MockCardCapture>()
const CARD_CAPTURE_DELAY_MS = 4000

/**
 * Gatilhos determinísticos por `holderName` do cartão (mesmo espírito do
 * "e-mail especial" de `[[padrao-auth-429-e-segredo-carregador]]`/
 * `[[padrao-recarga-pix-f5]]`): como `paymentMethodId` é gerado dinamicamente
 * no cadastro (F5.3), não dá pra fixar um ID — o holderName é o único campo
 * de texto livre que o motorista digita e controla na aba isolada. Case
 * insensitive, substring.
 */
const CARD_DENIED_MARKER = "RECUSA"
const CARD_GATEWAY_DOWN_MARKER = "GATEWAY"
const CARD_PARTIAL_CAPTURE_MARKER = "PARCIAL"

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
      payment: promoted.payment,
    }
    pendingSession = null
  }
}

export function startMockSession(
  driverId: string,
  ocppIdentity: string,
  connectorId: number,
  payment: MeStartSessionRequest["payment"] = { mode: "WALLET" },
):
  | {
      ok: true
      correlationId: string
      walletBalanceCents: number
      estimatedMaxCostCents: number
      minChargeCents: number | null
      paymentMode: "WALLET" | "CARD"
      authorizedCents: number | null
    }
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
  // Dívida em aberto bloqueia SEMPRE — independente da forma de pagamento
  // escolhida agora (é um "você deve à casa", não um problema desta cobrança).
  if (wallet.openDebtCents > 0) return { ok: false, code: "DRIVER_HAS_OPEN_DEBT", message: "Você tem uma dívida em aberto — quite-a na carteira antes de carregar de novo." }

  const paymentMode = payment?.mode ?? "WALLET"
  const estimatedMaxCostCents = Math.max(2000, Math.round(Number(tariff.pricePerKwh ?? 0) * 60 * 100))

  let sessionPayment: MockSessionPayment
  let authorizedCents: number | null = null

  if (paymentMode === "WALLET") {
    // Saldo insuficiente só bloqueia quando de fato vai debitar a carteira.
    if (wallet.balanceCents < 2000) return { ok: false, code: "INSUFFICIENT_BALANCE", message: "Saldo insuficiente para iniciar uma recarga." }
    sessionPayment = { mode: "WALLET", card: null }
  } else {
    const paymentMethodId = payment && "paymentMethodId" in payment ? payment.paymentMethodId : undefined
    const method = paymentMethodId ? getPaymentMethods(driverId).find((m) => m.id === paymentMethodId) : undefined
    if (!method) return { ok: false, code: "PAYMENT_METHOD_NOT_FOUND", message: "Cartão não encontrado — pode ter sido removido." }

    const holder = (method.holderName ?? "").toUpperCase()
    if (holder.includes(CARD_DENIED_MARKER)) {
      return { ok: false, code: "CARD_AUTHORIZATION_DENIED", message: "Seu cartão foi recusado." }
    }
    if (holder.includes(CARD_GATEWAY_DOWN_MARKER)) {
      return { ok: false, code: "PAYMENT_GATEWAY_UNAVAILABLE", message: "Não foi possível processar o pagamento agora." }
    }

    authorizedCents = estimatedMaxCostCents
    sessionPayment = {
      mode: "CARD",
      card: { paymentMethodId: method.id, brand: method.brand, last4: method.last4, authorizedCents },
    }
  }

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
    payment: sessionPayment,
    promoteAt: Date.now() + 4000, // simula o intervalo até o StartTransaction real chegar
  }

  return { ok: true, correlationId, walletBalanceCents: wallet.balanceCents, estimatedMaxCostCents, minChargeCents: tariff.minChargeCents, paymentMode, authorizedCents }
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
    paymentMode: activeSession.payment.mode,
    // Durante a sessão ATIVA o cartão só pode estar `AUTHORIZED` (a captura
    // real só roda depois do Stop, ver `finalizeSession`) — nunca
    // `CAPTURE_PENDING`/`CAPTURED` aqui, mesmo que pareça redundante com o
    // capture record: são fases diferentes da MESMA sessão.
    payment:
      activeSession.payment.mode === "CARD" && activeSession.payment.card
        ? {
            mode: "CARD",
            card: {
              brand: activeSession.payment.card.brand,
              last4: activeSession.payment.card.last4,
              authorizedCents: activeSession.payment.card.authorizedCents,
              capturedCents: null,
              status: "AUTHORIZED",
            },
          }
        : { mode: "WALLET", card: null },
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

  const isCard = activeSession.payment.mode === "CARD" && !!activeSession.payment.card
  let walletEntry: MeSessionDetail["walletEntry"] = null

  if (!isCard) {
    // WALLET (comportamento de sempre, sem mudança) — débito síncrono no Stop.
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
    walletEntry = { id: walletEntryId, amountCents: -totalCostCents, balanceAfterCents: balanceAfter, createdAt: finishedAt }
  }

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
    walletEntry,
    debt: null,
    paymentMode: activeSession.payment.mode,
  }

  if (isCard && activeSession.payment.card) {
    // `CAPTURE_PENDING` nasce AQUI (fechamento síncrono do Stop) — a captura
    // de fato só resolve depois de `CARD_CAPTURE_DELAY_MS`, mesmo espírito do
    // worker assíncrono real (nunca captura inline, ver decisoes-f5-pagamento-
    // cielo.md §2). O marcador `PARCIAL` no holderName simula uma captura
    // menor que o total — o resto vira `Debt`, resolvido em `resolveCardCapture`.
    const method = getPaymentMethods(activeSession.driverId).find((m) => m.id === activeSession!.payment.card!.paymentMethodId)
    const isPartial = (method?.holderName ?? "").toUpperCase().includes(CARD_PARTIAL_CAPTURE_MARKER)
    const targetCapturedCents = isPartial ? Math.max(0, Math.round(totalCostCents * 0.6)) : Math.min(totalCostCents, activeSession.payment.card.authorizedCents)
    cardCapturesBySession.set(activeSession.id, {
      brand: activeSession.payment.card.brand,
      last4: activeSession.payment.card.last4,
      authorizedCents: activeSession.payment.card.authorizedCents,
      totalCostCents,
      targetCapturedCents,
      resolveAt: Date.now() + CARD_CAPTURE_DELAY_MS,
      status: "CAPTURE_PENDING",
      capturedCents: null,
    })
  }

  sessionsHistory.unshift(detail)
  activeSession = null
}

/**
 * Resolve a captura lazy (mesmo padrão de `resolveTopupStatus`) e já anexa
 * `debt` ao `MeSessionDetail` quando a captura resolvida for PARCIAL — só na
 * transição CAPTURE_PENDING→CAPTURED, nunca antes (dívida não existe até a
 * cobrança de fato terminar).
 */
function resolveCardPayment(detail: MeSessionDetail): MeSessionPaymentInfo | undefined {
  const capture = cardCapturesBySession.get(detail.id)
  if (!capture) return undefined

  if (capture.status === "CAPTURE_PENDING" && Date.now() >= capture.resolveAt) {
    capture.status = "CAPTURED"
    capture.capturedCents = capture.targetCapturedCents
    if (capture.capturedCents < capture.totalCostCents) {
      detail.debt = { id: `debt_${detail.id}`, amountCents: capture.totalCostCents - capture.capturedCents }
    }
  }

  return {
    mode: "CARD",
    card: { brand: capture.brand, last4: capture.last4, authorizedCents: capture.authorizedCents, capturedCents: capture.capturedCents, status: capture.status },
  }
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
  const detail = sessionsHistory.find((s) => s.id === id)
  if (!detail) return null
  // `resolveCardPayment` pode mutar `detail.debt` (captura parcial resolvida
  // agora) — por isso roda ANTES de montar o retorno, não depois.
  const payment = resolveCardPayment(detail)
  return payment ? { ...detail, payment } : detail
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

/** `user_driver_devedor` (ver `mocks/data.ts`) nasce com dívida em aberto — prova em tela o aviso "os primeiros R$X quitam a dívida" da tela de recarga Pix sem mexer no motorista usado pelo E2E de sessão. */
const DEBT_DEMO_DRIVER_ID = "user_driver_devedor"

function getWalletState(driverId: string): WalletState {
  if (!walletByDriver.has(driverId)) {
    const seedAt = new Date(Date.now() - 86_400_000).toISOString()
    const isDebtDemo = driverId === DEBT_DEMO_DRIVER_ID
    walletByDriver.set(driverId, {
      balanceCents: isDebtDemo ? 0 : 5000,
      openDebtCents: isDebtDemo ? 3850 : 0,
      entries: isDebtDemo
        ? [
            {
              id: "we_seed_devedor",
              type: "CHARGE_DEBIT",
              amountCents: 0,
              balanceAfterCents: 0,
              referenceType: "CHARGING_SESSION",
              referenceId: null,
              description: "Recarga com saldo insuficiente — R$ 38,50 ficaram em aberto",
              createdAt: seedAt,
            },
          ]
        : [
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

/**
 * Ajuste manual de saldo (Admin → Carteiras) sobre a MESMA carteira que o PWA
 * do motorista lê (`getMockWallet`) — assim, creditar o motorista de teste no
 * painel muda o saldo que ele vê (e o que libera "Iniciar recarga") no PWA.
 * Débito maior que o saldo é recusado (mesmo `INSUFFICIENT_BALANCE` do backend).
 */
export function adjustMockWallet(
  driverId: string,
  amountCents: number,
  description: string,
): { ok: true; entry: MeWalletEntryDTO } | { ok: false; code: "INSUFFICIENT_BALANCE" } {
  const wallet = getWalletState(driverId)
  if (wallet.balanceCents + amountCents < 0) return { ok: false, code: "INSUFFICIENT_BALANCE" }
  wallet.balanceCents += amountCents
  const entry: MeWalletEntryDTO = {
    id: `we_adj_${Date.now()}_${wallet.entries.length}`,
    type: amountCents > 0 ? "ADJUSTMENT_CREDIT" : "ADJUSTMENT_DEBIT",
    amountCents,
    balanceAfterCents: wallet.balanceCents,
    referenceType: null,
    referenceId: null,
    description,
    createdAt: new Date().toISOString(),
  }
  wallet.entries.unshift(entry)
  return { ok: true, entry }
}

// ---------------------------------------------------------------------------
// Recarga de saldo via Pix (F5.1) — a rota real (`POST/GET
// /api/me/wallet/topups`) ainda não existe no backend, ver
// `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md`. Mesmo espírito
// dos comandos OCPP acima: atraso realista (`AUTO_PAY_DELAY_MS`) para provar
// o estado "PENDING" na tela antes de resolver — sem isso o motorista nunca
// veria o QR code, o mock pagaria sozinho no mesmo tick.
// ---------------------------------------------------------------------------

/** Espelha `TOPUP_MIN_AMOUNT_CENTS`/`TOPUP_MAX_AMOUNT_CENTS` de `lib/topupAmount.ts` — mocks não importam de `lib/` de propósito (auto-contidos), então os dois lados precisam ser mantidos iguais manualmente se o limite mudar. */
const TOPUP_MIN_AMOUNT_CENTS = 1_000
const TOPUP_MAX_AMOUNT_CENTS = 50_000
const TOPUP_EXPIRES_MS = 30 * 60_000
/** "Paga sozinho" 8s depois de criado — tempo suficiente pra ver o QR/copia-e-cola na tela antes do estado virar `PAID`. */
const AUTO_PAY_DELAY_MS = 8_000

interface MockTopup {
  id: string
  driverId: string
  status: MeTopupStatus
  amountCents: number
  qrCodeString: string
  qrCodeImageBase64: string | null
  expiresAt: string
  paidAt: string | null
  createdAt: string
  debtSettledCents: number
  autoPayAt: number
}

const topupsById = new Map<string, MockTopup>()
let topupCounter = 1

function centsToBrl(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",")
}

/**
 * COSMÉTICO — não é um payload EMV Pix válido de verdade (a geração real é
 * da Cielo, via backend). Só precisa "parecer" um copia-e-cola pra provar o
 * botão de copiar e a exibição do QR no navegador.
 */
function buildPixCopiaECola(topupId: string, amountCents: number): string {
  const amount = (amountCents / 100).toFixed(2)
  return `00020126580014BR.GOV.BCB.PIX0136${topupId}5204000053039865406${amount}5802BR5913INNOELEKTRON LTDA6009SAO PAULO62070503***6304MOCK`
}

async function toQrCodeImageBase64(payload: string): Promise<string | null> {
  try {
    const dataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 320 })
    return dataUrl.replace(/^data:image\/png;base64,/, "")
  } catch {
    // Geração de QR nunca deveria derrubar a criação do Pix — o copia-e-cola sozinho já é usável.
    return null
  }
}

function toTopupDTO(t: MockTopup): MeTopupDTO {
  return {
    id: t.id,
    status: t.status,
    amountCents: t.amountCents,
    qrCodeString: t.qrCodeString,
    qrCodeImageBase64: t.qrCodeImageBase64,
    expiresAt: t.expiresAt,
    paidAt: t.paidAt,
    createdAt: t.createdAt,
    debtSettledCents: t.debtSettledCents,
  }
}

/** Quita a dívida em aberto primeiro, credita o restante como saldo LIVRE — mesma regra prometida na tela ("os primeiros R$X quitam a dívida"). */
function settleTopupPayment(t: MockTopup) {
  const wallet = getWalletState(t.driverId)
  const debtSettledCents = Math.min(t.amountCents, wallet.openDebtCents)
  const freeCents = t.amountCents - debtSettledCents
  wallet.openDebtCents -= debtSettledCents
  wallet.balanceCents += freeCents

  const paidAt = new Date().toISOString()
  const entry: MeWalletEntryDTO = {
    id: `we_topup_${t.id}`,
    type: "TOPUP_PIX",
    amountCents: freeCents,
    balanceAfterCents: wallet.balanceCents,
    referenceType: "TOPUP",
    referenceId: t.id,
    description: debtSettledCents > 0 ? `Recarga Pix de R$ ${centsToBrl(t.amountCents)} — R$ ${centsToBrl(debtSettledCents)} quitou dívida em aberto` : "Recarga Pix",
    createdAt: paidAt,
  }
  wallet.entries.unshift(entry)

  t.status = "PAID"
  t.paidAt = paidAt
  t.debtSettledCents = debtSettledCents
}

/** Resolve o estado "vivo" de um topup (chamado a cada leitura) — `PENDING` pode virar `EXPIRED` (prazo estourado) ou `PAID` (auto-pagamento simulado) na hora. Estados terminais nunca voltam. */
function resolveTopupStatus(t: MockTopup): void {
  if (t.status !== "PENDING") return
  const now = Date.now()
  if (now >= new Date(t.expiresAt).getTime()) {
    t.status = "EXPIRED"
    return
  }
  if (now >= t.autoPayAt) settleTopupPayment(t)
}

export async function createMockTopup(
  driverId: string,
  amountCents: unknown,
): Promise<{ ok: true; topup: MeTopupDTO } | { ok: false; code: string; message: string }> {
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents < TOPUP_MIN_AMOUNT_CENTS || amountCents > TOPUP_MAX_AMOUNT_CENTS) {
    return { ok: false, code: "TOPUP_AMOUNT_OUT_OF_RANGE", message: "Valor precisa estar entre R$ 10,00 e R$ 500,00." }
  }
  const hasPending = [...topupsById.values()].some((t) => {
    if (t.driverId !== driverId) return false
    resolveTopupStatus(t)
    return t.status === "PENDING"
  })
  if (hasPending) {
    return { ok: false, code: "TOO_MANY_PENDING_TOPUPS", message: "Você já tem uma recarga Pix aguardando pagamento." }
  }

  const id = `topup_${topupCounter++}`
  const now = Date.now()
  const qrCodeString = buildPixCopiaECola(id, amountCents)
  const qrCodeImageBase64 = await toQrCodeImageBase64(qrCodeString)

  const record: MockTopup = {
    id,
    driverId,
    status: "PENDING",
    amountCents,
    qrCodeString,
    qrCodeImageBase64,
    expiresAt: new Date(now + TOPUP_EXPIRES_MS).toISOString(),
    paidAt: null,
    createdAt: new Date(now).toISOString(),
    debtSettledCents: 0,
    autoPayAt: now + AUTO_PAY_DELAY_MS,
  }
  topupsById.set(id, record)
  return { ok: true, topup: toTopupDTO(record) }
}

export function getMockTopup(id: string): MeTopupDTO | null {
  const t = topupsById.get(id)
  if (!t) return null
  resolveTopupStatus(t)
  return toTopupDTO(t)
}

// ---------------------------------------------------------------------------
// Cartão salvo (F5.3) — a rota real já existe no backend (Vega,
// `backend/src/api/routes/mePaymentMethods.routes.ts`, contrato espelhado em
// `types/api.ts`), mas este mock deixa o fluxo testável sem ele (sem
// Postgres/Redis no ambiente da Lyra, mesma limitação recorrente do
// projeto). Mesmo teto (`MAX_PAYMENT_METHODS_PER_USER = 5`) e mesma regra de
// "promove o mais recente a padrão ao remover o padrão" do backend real —
// ver `mePaymentMethods.routes.ts` — para o comportamento observado aqui não
// enganar ninguém sobre o que a API real faz.
// ---------------------------------------------------------------------------

const MAX_PAYMENT_METHODS_PER_USER = 5

interface MockPaymentMethod {
  id: string
  driverId: string
  brand: string
  last4: string | null
  holderName: string | null
  expiryMonth: number | null
  expiryYear: number | null
  isDefault: boolean
  createdAt: string
}

const paymentMethodsByDriver = new Map<string, MockPaymentMethod[]>()
let paymentMethodCounter = 1

/**
 * `user_driver_cartoes` (ver `mocks/data.ts`) nasce com 4 cartões — um por
 * gatilho de `holderName` do fluxo de pagamento (F5.4). Mesmo espírito de
 * `DEBT_DEMO_DRIVER_ID`: como registrar um cartão pela UI e depois navegar de
 * verdade pra `/c/:id` perde o estado do mock (cada navegação reimporta o
 * módulo que roda os handlers do MSW — não existe SW "de servidor" aqui,
 * `setupWorker` delega pro JS da própria página), pré-semear é a única forma
 * determinística de testar o SELETOR ponta a ponta sem cadastrar na hora.
 */
const CARD_DEMO_DRIVER_ID = "user_driver_cartoes"

/**
 * `user_driver_gateway_off` (ver `mocks/data.ts`): o admin desligou o MEIO no gateway (F5.5).
 * As 4 rotas do motorista afetadas respondem 409 `PAYMENT_METHOD_DISABLED` com
 * `details: [{ method, reason: "GATEWAY_DISABLED" }]` (contrato: `PaymentMethodDisabledDetail`).
 * Pagamento por carteira segue normal.
 */
const GATEWAY_OFF_DRIVER_ID = "user_driver_gateway_off"

export function isGatewayDisabledFor(driverId: string): boolean {
  return driverId === GATEWAY_OFF_DRIVER_ID
}

export function gatewayDisabledBody(method: "CARD" | "PIX") {
  return {
    error: method === "CARD" ? "Pagamento com cartão desabilitado pelo administrador." : "Pix desabilitado pelo administrador.",
    code: "PAYMENT_METHOD_DISABLED",
    details: [{ method, reason: "GATEWAY_DISABLED" as const }],
  }
}

function seedCardDemoDriver(): MockPaymentMethod[] {
  const now = new Date().toISOString()
  return [
    { id: "pm_seed_aprovado", driverId: CARD_DEMO_DRIVER_ID, brand: "Visa", last4: "1234", holderName: "Motorista Aprovado", expiryMonth: 8, expiryYear: 2030, isDefault: true, createdAt: now },
    { id: "pm_seed_recusa", driverId: CARD_DEMO_DRIVER_ID, brand: "Master", last4: "4444", holderName: "Motorista Recusa", expiryMonth: 9, expiryYear: 2029, isDefault: false, createdAt: now },
    { id: "pm_seed_gateway", driverId: CARD_DEMO_DRIVER_ID, brand: "Elo", last4: "6516", holderName: "Motorista Gateway", expiryMonth: 5, expiryYear: 2031, isDefault: false, createdAt: now },
    { id: "pm_seed_parcial", driverId: CARD_DEMO_DRIVER_ID, brand: "Amex", last4: "0005", holderName: "Motorista Parcial", expiryMonth: 11, expiryYear: 2028, isDefault: false, createdAt: now },
  ]
}

function seedGatewayOffDriver(): MockPaymentMethod[] {
  return [
    { id: "pm_seed_gwoff", driverId: GATEWAY_OFF_DRIVER_ID, brand: "Visa", last4: "4242", holderName: "Motorista Gateway Off", expiryMonth: 8, expiryYear: 2030, isDefault: true, createdAt: new Date().toISOString() },
  ]
}

function getPaymentMethods(driverId: string): MockPaymentMethod[] {
  if (!paymentMethodsByDriver.has(driverId)) {
    paymentMethodsByDriver.set(driverId, driverId === CARD_DEMO_DRIVER_ID ? seedCardDemoDriver() : driverId === GATEWAY_OFF_DRIVER_ID ? seedGatewayOffDriver() : [])
  }
  return paymentMethodsByDriver.get(driverId) as MockPaymentMethod[]
}

/**
 * Decodifica o token que `pagamento-cartao/sopClient.ts` gera no caminho
 * mock (`mocktok.<last4>.<mmYYYY>.<holderB64>.<selo>`) — espelha, no
 * frontend, o que a Cielo faria de verdade via `GET /1/card/{token}` num
 * ambiente real (mesmo raciocínio do `FakeAdapter.consultarCartaoTokenizado`
 * no backend). Token que não bate no formato = `null` (vira
 * `INVALID_CARD_TOKEN`, exercitando esse código de erro também aqui).
 */
function decodeMockCardToken(cardToken: string): { last4: string; expiryMonth: number; expiryYear: number; holderName: string | null } | null {
  const match = /^mocktok\.(\d{4})\.(\d{2})(\d{4})\.([^.]*)\./.exec(cardToken)
  if (!match) return null
  const [, last4, month, year, holderB64] = match
  let holderName: string | null = null
  try {
    // TextDecoder em vez de escape/unescape (descontinuados) — espelha o encode de `sopClient.ts`.
    const bytes = Uint8Array.from(atob(holderB64), (c) => c.charCodeAt(0))
    holderName = new TextDecoder().decode(bytes) || null
  } catch {
    holderName = null
  }
  return { last4, expiryMonth: Number(month), expiryYear: Number(year), holderName }
}

export function createMockTokenizationSession(): MeCardTokenizationSessionResponse {
  return {
    accessToken: `mock_access_${Date.now()}`,
    merchantId: "mock_merchant",
    environment: "sandbox",
    // Contém "mock" de propósito — é o marcador que `pagamento-cartao/sopClient.ts` reconhece para nunca tentar uma chamada de rede real.
    scriptUrl: "https://mock.local/sop/script.js",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  }
}

function toPaymentMethodDTO(m: MockPaymentMethod): MePaymentMethodDTO {
  return {
    id: m.id,
    brand: m.brand,
    last4: m.last4,
    holderName: m.holderName,
    expiryMonth: m.expiryMonth,
    expiryYear: m.expiryYear,
    isDefault: m.isDefault,
    createdAt: m.createdAt,
  }
}

export function listMockPaymentMethods(driverId: string): MePaymentMethodDTO[] {
  return [...getPaymentMethods(driverId)]
    .sort((a, b) => (a.isDefault === b.isDefault ? b.createdAt.localeCompare(a.createdAt) : a.isDefault ? -1 : 1))
    .map(toPaymentMethodDTO)
}

export function createMockPaymentMethod(
  driverId: string,
  cardToken: unknown,
  brand: unknown,
  makeDefault: boolean,
): { ok: true; method: MePaymentMethodDTO } | { ok: false; code: "INVALID_CARD_TOKEN" | "TOO_MANY_PAYMENT_METHODS"; message: string } {
  const methods = getPaymentMethods(driverId)
  if (methods.length >= MAX_PAYMENT_METHODS_PER_USER) {
    return { ok: false, code: "TOO_MANY_PAYMENT_METHODS", message: "Você já tem o número máximo de cartões cadastrados." }
  }
  if (typeof cardToken !== "string" || typeof brand !== "string") {
    return { ok: false, code: "INVALID_CARD_TOKEN", message: "Cartão inválido ou não reconhecido." }
  }
  const decoded = decodeMockCardToken(cardToken)
  if (!decoded) {
    return { ok: false, code: "INVALID_CARD_TOKEN", message: "Cartão inválido ou não reconhecido." }
  }

  const shouldBeDefault = makeDefault || methods.length === 0
  if (shouldBeDefault) methods.forEach((m) => (m.isDefault = false))

  const method: MockPaymentMethod = {
    id: `pm_${paymentMethodCounter++}`,
    driverId,
    brand: brand as CardBrand,
    last4: decoded.last4,
    holderName: decoded.holderName,
    expiryMonth: decoded.expiryMonth,
    expiryYear: decoded.expiryYear,
    isDefault: shouldBeDefault,
    createdAt: new Date().toISOString(),
  }
  methods.push(method)
  return { ok: true, method: toPaymentMethodDTO(method) }
}

export function setDefaultMockPaymentMethod(driverId: string, id: string): { ok: true; method: MePaymentMethodDTO } | { ok: false } {
  const methods = getPaymentMethods(driverId)
  const target = methods.find((m) => m.id === id)
  if (!target) return { ok: false }
  methods.forEach((m) => (m.isDefault = m.id === id))
  return { ok: true, method: toPaymentMethodDTO(target) }
}

/** Soft-delete — se o removido era o padrão, promove o mais recente restante (mesma UX do backend real, ver comentário no topo desta seção). */
export function removeMockPaymentMethod(driverId: string, id: string): boolean {
  const methods = getPaymentMethods(driverId)
  const index = methods.findIndex((m) => m.id === id)
  if (index === -1) return false
  const [removed] = methods.splice(index, 1)
  if (removed.isDefault && methods.length > 0) {
    const mostRecent = [...methods].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    mostRecent.isDefault = true
  }
  return true
}
