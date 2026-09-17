/**
 * Log de auditoria sintético — mesma ideia dos outros geradores de
 * `mocks/reportsData.ts` (PRNG com semente fixa, mesmos dados sempre),
 * cobrindo o contrato que a Nova desenhou em `decisoes-audit-log.md` e o
 * Vega ainda vai espelhar no backend real. Mistura deliberada de ações
 * (CREATE/UPDATE/DELETE/REMOTE_COMMAND/WALLET_ADJUSTMENT/LOGIN_*), a maioria
 * `SUCCESS` mas com `DENIED`/`FAILED` de propósito (senão a tela nunca mostra
 * o sinal de segurança que ela existe para dar).
 *
 * `changes` sempre no formato `{ campo: { from, to } }` — mesmo para
 * REMOTE_COMMAND (que grava INTENÇÃO, não resultado): `from: null` porque não
 * havia comando antes, `to: "reset"` é o que foi pedido.
 */
import { mockChargePoints, mockDrivers, mockSites, mockTariffs, OPERATOR_A_ID, OPERATOR_B_ID } from "./data"
import type { AuditAction, AuditLogActor, AuditLogActorSummary, AuditLogDetail, AuditLogListItem, AuditOutcome, Role } from "@/types/api"

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

const rng = mulberry32(20260917)
const randInt = (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min
const pick = <T,>(arr: readonly T[]): T => arr[randInt(0, arr.length - 1)]
const chance = (p: number) => rng() < p

// ---------------------------------------------------------------------------
// Atores — staff que mexe no painel admin (motorista não entra aqui: o
// middleware de auditoria só cobre `/api/admin/*`, ver decisoes-audit-log.md).
// ---------------------------------------------------------------------------

const ACTOR_POOL: AuditLogActor[] = [
  { userId: "user_admin", name: "Ana Admin", email: "admin@innoelektron.com", role: "ADMIN", operatorId: null },
  { userId: "user_operator", name: "Beto Operador", email: "operador@innoelektron.com", role: "OPERATOR", operatorId: OPERATOR_A_ID },
  { userId: "user_operator_2", name: "Camila Torres", email: "camila.torres@innovarecharge.com", role: "OPERATOR", operatorId: OPERATOR_A_ID },
  { userId: "user_operator_3", name: "Diego Farias", email: "diego.farias@estradareal.com", role: "OPERATOR", operatorId: OPERATOR_B_ID },
  // Tentativa de login com credencial inexistente — ator "desconhecido"
  // (não tem `userId` real porque a autenticação falhou antes de resolver
  // o usuário; usamos um placeholder só para a UI ter o que mostrar).
  { userId: "unknown", name: "(login não identificado)", email: "desconhecido@tentativa.com", role: "OPERATOR", operatorId: null },
]

// Só os três tipos que de fato aparecem no gerador (`entityPool` abaixo) —
// `Connector`/`TariffAssignment`/`AuthToken` são `entityType` válidos no
// contrato real, mas não precisam de linha sintética própria aqui.
type EntityType = "Site" | "ChargePoint" | "Tariff"

const IP_POOL = ["189.45.12.201", "179.98.4.53", "201.17.88.14", "138.204.9.77", "45.230.1.19", "170.79.22.6"]
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/129.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1",
]

interface EntityRef {
  entityType: EntityType
  entityId: string
  operatorId: string | null
  label: string
}

function entityPool(): EntityRef[] {
  const refs: EntityRef[] = []
  mockSites.forEach((s) => refs.push({ entityType: "Site", entityId: s.id, operatorId: s.operatorId, label: s.name }))
  mockChargePoints.forEach((cp) => refs.push({ entityType: "ChargePoint", entityId: cp.id, operatorId: cp.operatorId, label: cp.ocppIdentity }))
  mockTariffs.forEach((t) => refs.push({ entityType: "Tariff", entityId: t.id, operatorId: t.operatorId, label: t.name }))
  return refs
}
const ENTITIES = entityPool()

function isoDaysAgo(days: number, hour: number, minute: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, minute, randInt(0, 59), 0)
  return d.toISOString()
}

interface Change {
  from: unknown
  to: unknown
}

function buildChanges(action: AuditAction, entity: EntityRef | null): Record<string, Change> | null {
  switch (action) {
    case "CREATE":
      if (!entity) return null
      if (entity.entityType === "Tariff") return { name: { from: null, to: entity.label }, active: { from: null, to: true } }
      if (entity.entityType === "ChargePoint") return { ocppIdentity: { from: null, to: entity.label }, active: { from: null, to: true } }
      return { name: { from: null, to: entity.label }, active: { from: null, to: true } }
    case "UPDATE":
      if (entity?.entityType === "Tariff") {
        const before = randInt(150, 250) / 100
        const after = randInt(150, 250) / 100
        return { pricePerKwh: { from: before.toFixed(2), to: after.toFixed(2) } }
      }
      if (entity?.entityType === "ChargePoint") return { firmwareVersion: { from: "1.4.2", to: "1.5.0" } }
      return { active: { from: true, to: true } }
    case "DELETE":
      return { active: { from: true, to: false } }
    case "REMOTE_COMMAND": {
      const command = pick(["reset", "unlock", "change-availability", "trigger-message"] as const)
      return { command: { from: null, to: command } }
    }
    case "WALLET_ADJUSTMENT": {
      const credit = chance(0.6)
      const amount = randInt(500, 500000) * (credit ? 1 : -1)
      return {
        amountCents: { from: null, to: amount },
        description: { from: null, to: credit ? "Crédito de cortesia por falha do carregador" : "Estorno de lançamento indevido" },
      }
    }
    default:
      return null
  }
}

function buildRow(index: number): { item: AuditLogListItem; detail: AuditLogDetail } {
  const daysAgo = randInt(0, 44)
  const occurredAt = isoDaysAgo(daysAgo, randInt(6, 22), randInt(0, 59))

  // Distribuição de ações — pesos aproximados de um dia normal de operação.
  const actionRoll = rng()
  let action: AuditAction
  if (actionRoll < 0.22) action = "UPDATE"
  else if (actionRoll < 0.32) action = "CREATE"
  else if (actionRoll < 0.4) action = "DELETE"
  else if (actionRoll < 0.55) action = "REMOTE_COMMAND"
  else if (actionRoll < 0.65) action = "WALLET_ADJUSTMENT"
  else if (actionRoll < 0.85) action = "LOGIN_SUCCESS"
  else if (actionRoll < 0.95) action = "LOGIN_FAILED"
  else if (actionRoll < 0.98) action = "EXPORT"
  else action = "OTHER"

  const isLoginFailed = action === "LOGIN_FAILED"
  const actor = isLoginFailed && chance(0.4) ? ACTOR_POOL[ACTOR_POOL.length - 1] : pick(ACTOR_POOL.slice(0, -1))

  const entity = ["CREATE", "UPDATE", "DELETE", "REMOTE_COMMAND"].includes(action) ? pick(ENTITIES) : null

  // Resultado: a maioria SUCCESS; DENIED quando um OPERATOR tenta algo que só
  // ADMIN pode (ex.: mexer em auth-tokens/operador de outro operador);
  // FAILED representa erro real (ex.: comando remoto que o gateway rejeitou
  // antes mesmo de chegar no carregador, ou 500 de validação).
  let outcome: AuditOutcome = "SUCCESS"
  if (isLoginFailed) outcome = "DENIED"
  else if (chance(0.06)) outcome = "DENIED"
  else if (chance(0.04)) outcome = "FAILED"

  let httpStatus: number
  let method: string
  let path: string
  let actionDetail: string | null = null
  const targetOperatorId = entity?.operatorId ?? (action === "WALLET_ADJUSTMENT" ? pick([OPERATOR_A_ID, OPERATOR_B_ID]) : null)

  // Calculado UMA vez (não dentro do switch) — `buildChanges` consome o RNG
  // (ex.: sorteia o comando remoto), então chamar de novo geraria um valor
  // diferente do que fica salvo em `changes`, e o `path` mostraria um
  // comando que não bate com o que o detalhe exibe.
  const changes = buildChanges(action, entity)

  switch (action) {
    case "CREATE":
      method = "POST"
      path = `/api/admin/${entity!.entityType === "Tariff" ? "tariffs" : entity!.entityType === "ChargePoint" ? "charge-points" : "sites"}`
      httpStatus = outcome === "SUCCESS" ? 201 : outcome === "DENIED" ? 403 : 422
      actionDetail = `Criação de ${entity!.entityType.toLowerCase()} · ${entity!.label}`
      break
    case "UPDATE":
      method = "PATCH"
      path = `/api/admin/${entity!.entityType === "Tariff" ? "tariffs" : entity!.entityType === "ChargePoint" ? "charge-points" : "sites"}/${entity!.entityId}`
      httpStatus = outcome === "SUCCESS" ? 200 : outcome === "DENIED" ? 403 : 422
      actionDetail = `Atualização de ${entity!.entityType.toLowerCase()} · ${entity!.label}`
      break
    case "DELETE":
      method = "DELETE"
      path = `/api/admin/${entity!.entityType === "Tariff" ? "tariffs" : entity!.entityType === "ChargePoint" ? "charge-points" : "sites"}/${entity!.entityId}`
      httpStatus = outcome === "SUCCESS" ? 204 : outcome === "DENIED" ? 403 : 404
      actionDetail = `Exclusão (soft-delete) de ${entity!.entityType.toLowerCase()} · ${entity!.label}`
      break
    case "REMOTE_COMMAND": {
      const cp = entity!
      method = "POST"
      path = `/api/admin/charge-points/${cp.entityId}/commands/${(changes?.command.to as string) ?? "reset"}`
      httpStatus = outcome === "SUCCESS" ? 202 : outcome === "DENIED" ? 403 : 409
      actionDetail = `Comando remoto em ${cp.label}${outcome === "FAILED" ? " — carregador offline" : ""}`
      break
    }
    case "WALLET_ADJUSTMENT": {
      const driver = pick(mockDrivers)
      method = "POST"
      path = `/api/admin/drivers/driver_${(index % mockDrivers.length) + 1}/wallet/entries`
      httpStatus = outcome === "SUCCESS" ? 201 : outcome === "DENIED" ? 403 : 422
      actionDetail = `Lançamento manual na carteira de ${driver.name}`
      break
    }
    case "LOGIN_SUCCESS":
      method = "POST"
      path = "/api/auth/login"
      httpStatus = 200
      actionDetail = "Login no painel administrativo"
      break
    case "LOGIN_FAILED":
      method = "POST"
      path = "/api/auth/login"
      httpStatus = 401
      actionDetail = "Senha incorreta"
      break
    case "EXPORT":
      method = "GET"
      path = pick(["/api/admin/reports/sessions", "/api/admin/reports/payments", "/api/admin/audit-logs"])
      httpStatus = 200
      actionDetail = "Exportação de CSV"
      break
    default:
      method = pick(["GET", "POST"])
      path = "/api/admin/rota-nao-mapeada"
      httpStatus = 404
      actionDetail = "Rota sem mapeamento de auditoria específico"
  }

  const hasChanges = !!changes && Object.keys(changes).length > 0

  const item: AuditLogListItem = {
    id: `audit_${index}`,
    occurredAt,
    actor,
    action,
    actionDetail,
    outcome,
    httpStatus,
    entityType: entity?.entityType ?? null,
    entityId: entity?.entityId ?? null,
    targetOperatorId,
    method,
    path,
    ipAddress: pick(IP_POOL),
    hasChanges,
  }

  const detail: AuditLogDetail = {
    ...item,
    userAgent: pick(USER_AGENTS),
    requestId: `req_${index}_${randInt(1000, 9999)}`,
    correlationId: action === "REMOTE_COMMAND" ? `corr_${index}_${randInt(1000, 9999)}` : null,
    changes: changes as Record<string, unknown> | null,
  }

  return { item, detail }
}

const ROWS = Array.from({ length: 220 }, (_, i) => buildRow(i)).sort(
  (a, b) => new Date(b.item.occurredAt).getTime() - new Date(a.item.occurredAt).getTime(),
)

export const mockAuditLogItems: AuditLogListItem[] = ROWS.map((r) => r.item)
export const mockAuditLogDetails: Map<string, AuditLogDetail> = new Map(ROWS.map((r) => [r.detail.id, r.detail]))

export interface AuditLogFilters {
  from: string
  to: string
  actorUserId?: string
  actorRole?: Role
  action?: AuditAction
  outcome?: AuditOutcome
  entityType?: string
  entityId?: string
  operatorId?: string
  q?: string
}

function inPeriod(occurredAt: string, from: string, to: string): boolean {
  const day = occurredAt.slice(0, 10)
  return day >= from && day <= to
}

export function filterAuditLogs(filters: AuditLogFilters): AuditLogListItem[] {
  return mockAuditLogItems.filter((item) => {
    if (!inPeriod(item.occurredAt, filters.from, filters.to)) return false
    if (filters.actorUserId && item.actor.userId !== filters.actorUserId) return false
    if (filters.actorRole && item.actor.role !== filters.actorRole) return false
    if (filters.action && item.action !== filters.action) return false
    if (filters.outcome && item.outcome !== filters.outcome) return false
    if (filters.entityType && item.entityType !== filters.entityType) return false
    if (filters.entityId && item.entityId !== filters.entityId) return false
    if (filters.operatorId && item.targetOperatorId !== filters.operatorId) return false
    if (filters.q) {
      const q = filters.q.toLowerCase()
      const haystack = `${item.actor.name} ${item.actor.email} ${item.entityId ?? ""}`.toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })
}

/** Ator + contagem de eventos no período — alimenta o `<select>` de ator do filtro (não é lista de usuários). */
export function listAuditLogActors(from: string, to: string): AuditLogActorSummary[] {
  const counts = new Map<string, { actor: AuditLogActor; count: number }>()
  mockAuditLogItems.filter((item) => inPeriod(item.occurredAt, from, to)).forEach((item) => {
    const existing = counts.get(item.actor.userId)
    if (existing) existing.count += 1
    else counts.set(item.actor.userId, { actor: item.actor, count: 1 })
  })
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ actor, count }) => ({ ...actor, eventCount: count }))
}
