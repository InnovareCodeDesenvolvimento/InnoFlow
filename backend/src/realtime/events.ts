/**
 * Espelho (backend) do contrato SSE definido em `frontend/src/types/api.ts`
 * (`RealtimeEvent`). Ver decisões completas em
 * `.claude/agent-memory/nova/decisoes-tempo-real-sse.md`. Os dois lados são
 * mantidos manualmente em sincronia (mesma convenção já usada para enums
 * espelhados no projeto, ex. `ConnectorStatus`) — mudar um lado sem o outro
 * é o tipo de bug que só aparece em produção, então qualquer PR que toque
 * aqui precisa tocar o arquivo irmão também.
 */

export interface RealtimeEventBase {
  occurredAt: string
}

export interface SessionMetricsEvent extends RealtimeEventBase {
  type: 'session.metrics'
  sessionId: string
  energyWh: number
  powerW: number | null
  soc: number | null
  partialCostCents: number
}

export interface SessionStatusEvent extends RealtimeEventBase {
  /** F5.9: `session.updated` = a sessão virou `STOP_UNCONFIRMED` ou foi reanimada (espelha `frontend/src/types/api.ts`); mesmo payload dos outros dois. */
  type: 'session.started' | 'session.stopped' | 'session.updated'
  sessionId: string
  chargePointId: string
}

export interface WalletUpdatedEvent extends RealtimeEventBase {
  type: 'wallet.updated'
  userId: string
  balanceCents: number
}

/** F5.2 — crédito de Pix confirmado (worker, ver `services/pagamentos/creditarTopupPix.ts`) ou expirado (varredor). Roteado pelo canal PRIVADO do motorista (`publishToUser`) — `userId` não entra no payload por desenho, mesmo formato de `frontend/src/types/api.ts` (`TopupUpdatedEvent`). */
export interface TopupUpdatedEvent extends RealtimeEventBase {
  type: 'topup.updated'
  topupId: string
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED'
}

export interface ChargePointStatusEvent extends RealtimeEventBase {
  type: 'chargepoint.status'
  chargePointId: string
  connectorId: number
  status: string
}

export interface AdminEntityChangedEvent extends RealtimeEventBase {
  type: 'admin.entity.changed'
  entityType: string
  entityId: string
  action: 'CREATE' | 'UPDATE' | 'DELETE'
}

export interface DashboardDirtyEvent extends RealtimeEventBase {
  type: 'dashboard.dirty'
}

export type RealtimeEvent =
  | SessionMetricsEvent
  | SessionStatusEvent
  | WalletUpdatedEvent
  | TopupUpdatedEvent
  | ChargePointStatusEvent
  | AdminEntityChangedEvent
  | DashboardDirtyEvent

function nowIso(): string {
  return new Date().toISOString()
}

export function sessionMetricsEvent(input: Omit<SessionMetricsEvent, 'type' | 'occurredAt'>): SessionMetricsEvent {
  return { type: 'session.metrics', occurredAt: nowIso(), ...input }
}

export function sessionStatusEvent(type: 'session.started' | 'session.stopped' | 'session.updated', input: Omit<SessionStatusEvent, 'type' | 'occurredAt'>): SessionStatusEvent {
  return { type, occurredAt: nowIso(), ...input }
}

export function walletUpdatedEvent(input: Omit<WalletUpdatedEvent, 'type' | 'occurredAt'>): WalletUpdatedEvent {
  return { type: 'wallet.updated', occurredAt: nowIso(), ...input }
}

export function topupUpdatedEvent(input: Omit<TopupUpdatedEvent, 'type' | 'occurredAt'>): TopupUpdatedEvent {
  return { type: 'topup.updated', occurredAt: nowIso(), ...input }
}

export function chargePointStatusEvent(input: Omit<ChargePointStatusEvent, 'type' | 'occurredAt'>): ChargePointStatusEvent {
  return { type: 'chargepoint.status', occurredAt: nowIso(), ...input }
}

export function adminEntityChangedEvent(input: Omit<AdminEntityChangedEvent, 'type' | 'occurredAt'>): AdminEntityChangedEvent {
  return { type: 'admin.entity.changed', occurredAt: nowIso(), ...input }
}

export function dashboardDirtyEvent(): DashboardDirtyEvent {
  return { type: 'dashboard.dirty', occurredAt: nowIso() }
}
