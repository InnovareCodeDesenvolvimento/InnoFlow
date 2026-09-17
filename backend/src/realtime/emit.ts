import { env } from '../lib/env'
import {
  adminEntityChangedEvent,
  chargePointStatusEvent,
  dashboardDirtyEvent,
  sessionMetricsEvent,
  sessionStatusEvent,
  walletUpdatedEvent,
} from './events'
import { publishToAdmin, publishToOperator, publishToUser } from './bus'

/**
 * Camada "o que publicar" (em cima de `bus.ts`, que só sabe "publicar em um
 * canal") — cada função aqui corresponde a um dos pontos de emissão do
 * handoff da Nova. Mantém a decisão de AUDIÊNCIA (quem assina o quê) num só
 * lugar, para nenhum ponto de emissão inventar um canal novo por conta
 * própria.
 */

// ------------------------------------------------------------
// session.metrics — coalescido: no máximo 1 evento a cada ~5s por sessão
// (senão vira polling disfarçado de "tempo real", ver decisão da Nova).
// In-memory (não Redis): o `MeterValues` de uma sessão sempre chega no MESMO
// processo do gateway que segura a conexão daquele charge point (lock de
// `registry.ts`) — perder o estado num restart só reseta o coalescer, nunca
// causa duplicidade nem corrompe dado (mesmo raciocínio de risco aceito do
// rate limit de auth, mas aqui nem é segurança, é só limitar frequência).
// ------------------------------------------------------------

const METRICS_COALESCE_MS = 5_000
const lastMetricsSentAt = new Map<string, number>()

export interface EmitSessionMetricsInput {
  operatorId: string
  userId: string
  sessionId: string
  energyWh: number
  powerW: number | null
  soc: number | null
  partialCostCents: number
}

export async function emitSessionMetrics(input: EmitSessionMetricsInput): Promise<void> {
  const last = lastMetricsSentAt.get(input.sessionId) ?? 0
  const now = Date.now()
  if (now - last < METRICS_COALESCE_MS) return
  lastMetricsSentAt.set(input.sessionId, now)

  const event = sessionMetricsEvent({
    sessionId: input.sessionId,
    energyWh: input.energyWh,
    powerW: input.powerW,
    soc: input.soc,
    partialCostCents: input.partialCostCents,
  })

  // `ui:ev:admin` recebe TUDO (Nova: "ui:ev:admin — tudo, só ADMIN assina")
  // — o ADMIN da plataforma atravessa todos os operadores, mesma filosofia
  // de `operatorScopeWhere` (ADMIN sem filtro) já usada no resto da API.
  await Promise.all([publishToOperator(input.operatorId, event), publishToUser(input.userId, event), publishToAdmin(event)])
}

/** Limpa o estado de coalescência — chamar quando a sessão termina, para não vazar entradas do Map indefinidamente (sessão nunca mais reaproveita o mesmo id). */
export function clearSessionMetricsCoalesce(sessionId: string): void {
  lastMetricsSentAt.delete(sessionId)
}

// ------------------------------------------------------------
// session.started / session.stopped
// ------------------------------------------------------------

export interface EmitSessionStatusInput {
  operatorId: string
  userId: string
  sessionId: string
  chargePointId: string
}

export async function emitSessionStarted(input: EmitSessionStatusInput): Promise<void> {
  const event = sessionStatusEvent('session.started', { sessionId: input.sessionId, chargePointId: input.chargePointId })
  await Promise.all([publishToOperator(input.operatorId, event), publishToUser(input.userId, event), publishToAdmin(event)])
}

export async function emitSessionStopped(input: EmitSessionStatusInput): Promise<void> {
  clearSessionMetricsCoalesce(input.sessionId)
  const event = sessionStatusEvent('session.stopped', { sessionId: input.sessionId, chargePointId: input.chargePointId })
  await Promise.all([publishToOperator(input.operatorId, event), publishToUser(input.userId, event), publishToAdmin(event)])
}

// ------------------------------------------------------------
// wallet.updated — SEMPRE chamado depois do commit da transação que gerou o
// `WalletEntry` (nunca de dentro dela — ver decisão 5 da Nova). Os chamadores
// (`services/carteira/liquidarSessao.ts`, `services/carteira/walletLedger.ts`)
// já respeitam isso por construção.
// ------------------------------------------------------------

export async function emitWalletUpdated(userId: string, balanceCents: number): Promise<void> {
  await publishToUser(userId, walletUpdatedEvent({ userId, balanceCents }))
}

// ------------------------------------------------------------
// chargepoint.status
// ------------------------------------------------------------

export async function emitChargePointStatus(operatorId: string, chargePointId: string, connectorId: number, status: string): Promise<void> {
  const event = chargePointStatusEvent({ chargePointId, connectorId, status })
  await Promise.all([publishToOperator(operatorId, event), publishToAdmin(event)])
}

// ------------------------------------------------------------
// admin.entity.changed — sai do middleware de auditoria (`res.on('finish')`),
// reaproveitando o MESMO cálculo de entityType/entityId/action que já grava
// o AuditLog (dois consumidores, nenhuma instrumentação nova).
// ------------------------------------------------------------

export async function emitAdminEntityChanged(
  targetOperatorId: string | null,
  entityType: string,
  entityId: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
): Promise<void> {
  const event = adminEntityChangedEvent({ entityType, entityId, action })
  const targets: Promise<void>[] = [publishToAdmin(event)]
  if (targetOperatorId) targets.push(publishToOperator(targetOperatorId, event))
  await Promise.all(targets)
}

// ------------------------------------------------------------
// dashboard.dirty — throttle mínimo (env `DASHBOARD_DIRTY_THROTTLE_MS`,
// default 5s): NUNCA recalcula o agregado por evento, só avisa o frontend
// para invalidar a query existente (decisão 8 da Nova — `getDashboardLive`
// continua sendo quem busca de verdade).
// ------------------------------------------------------------

const lastDashboardDirtySentAt = new Map<string, number>()

export async function emitDashboardDirty(targetOperatorId: string | null): Promise<void> {
  const key = targetOperatorId ?? '__admin_only__'
  const last = lastDashboardDirtySentAt.get(key) ?? 0
  const now = Date.now()
  if (now - last < env.DASHBOARD_DIRTY_THROTTLE_MS) return
  lastDashboardDirtySentAt.set(key, now)

  const event = dashboardDirtyEvent()
  const targets: Promise<void>[] = [publishToAdmin(event)]
  if (targetOperatorId) targets.push(publishToOperator(targetOperatorId, event))
  await Promise.all(targets)
}
