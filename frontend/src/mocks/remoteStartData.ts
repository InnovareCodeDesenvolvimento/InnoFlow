/**
 * Mock da recarga remota do Admin (L1.5): `POST /api/admin/charge-points/:id/commands/remote-start` e `GET /api/admin/commands/:correlationId`, espelho de
 * `chargePoints.routes.ts` + `adminCommands.routes.ts` + `iniciarSessaoRemota.ts` (backend af6b32b). Lógica PURA (sem MSW) para os handlers só traduzirem em HTTP.
 *
 * Ordem das checagens = a do servidor: política de papel (403, ANTES do corpo) → validação do corpo (400, `details[].path = "reason"`) → motorista (404 `USER_NOT_FOUND`) →
 * carregador no escopo (404 `CHARGE_POINT_NOT_FOUND`) → conector (404 `CONNECTOR_NOT_FOUND`) → online (409 `CHARGE_POINT_OFFLINE`) → conector livre (409 `CONNECTOR_BUSY`) →
 * dívida (409 `DRIVER_HAS_OPEN_DEBT`) → saldo (409 `INSUFFICIENT_BALANCE`, piso de R$ 20,00 como o `startMockSession` do PWA).
 *
 * CENÁRIOS por `localStorage["mock:remote-start"]` (lido no POST): `rejected` (o carregador recusa), `timeout` (sem resposta em 35 s), `not-found` (o GET dá 404),
 * `stuck` (fica PENDING para sempre → "ainda sem resposta" aos 60 s), `poll-5xx` (o GET dá 500), `offline`, `busy`, `forbidden`, `5xx` (POST 500). Sem valor = aceito.
 * Por DADO (sem gatilho): Juliana/Aline/Camila têm dívida (e saldo zero) → `DRIVER_HAS_OPEN_DEBT`; Eduardo (saldo zero, sem dívida) → `INSUFFICIENT_BALANCE`; Carla (R$ 50,00) inicia.
 * Resultado: PENDING por `PENDING_MS` (dá para ver "aguardando") e depois o desfecho do cenário. Estado vive na PÁGINA (zera a cada `page.goto`).
 */
import { mockChargePoints, mockConnectors } from "./data"
import { getDriverWallet } from "./driversData"
import type { AdminCommandStatusResponse, MeCommandStatus, RemoteStartResponse, Role } from "@/types/api"

export const PENDING_MS = 3_000
const REASON_MIN = 10
const REASON_MAX = 200
// eslint-disable-next-line no-control-regex -- espelha o backend
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

export type RemoteStartScenario = "accepted" | "rejected" | "timeout" | "not-found" | "stuck" | "poll-5xx" | "offline" | "busy" | "forbidden" | "5xx"

export function parseScenario(raw: string | null): RemoteStartScenario {
  const known: RemoteStartScenario[] = ["rejected", "timeout", "not-found", "stuck", "poll-5xx", "offline", "busy", "forbidden", "5xx"]
  return known.find((k) => k === raw) ?? "accepted"
}

interface CommandRecord {
  startedAt: number
  scenario: RemoteStartScenario
  operatorId: string | null
}
const commands = new Map<string, CommandRecord>()
let counter = 1

/** UUID de mentira, mas com a forma de UUID v4 (o servidor valida `z.string().uuid()` no GET). */
function nextCorrelationId(): string {
  const n = (counter++).toString(16).padStart(12, "0")
  return `3f9c2a10-5b7e-4d21-9a6c-${n}`
}

export type RemoteStartOutcome =
  | { ok: true; status: 202; body: RemoteStartResponse }
  | { ok: false; status: number; code: string; message: string; details?: Array<{ path: string; message: string }> }

const fail = (status: number, code: string, message: string, details?: Array<{ path: string; message: string }>): RemoteStartOutcome => ({ ok: false, status, code, message, details })

/** Só ADMIN (DL4). Chamado ANTES de olhar o corpo, como o `requireRecargaRemotaPolicy` real. */
export function remoteStartPolicyDenied(role: Role): boolean {
  return role !== "ADMIN"
}

function validateBody(body: { connectorId?: unknown; userId?: unknown; reason?: unknown }) {
  const details: Array<{ path: string; message: string }> = []
  if (typeof body.connectorId !== "number" || !Number.isInteger(body.connectorId) || body.connectorId < 1) details.push({ path: "connectorId", message: "connectorId inválido." })
  if (typeof body.userId !== "string" || body.userId === "") details.push({ path: "userId", message: "userId é obrigatório." })
  if (typeof body.reason !== "string") details.push({ path: "reason", message: "Informe o motivo da recarga remota." })
  else {
    const r = body.reason.trim()
    if (r.length < REASON_MIN) details.push({ path: "reason", message: `O motivo precisa de pelo menos ${REASON_MIN} caracteres.` })
    else if (r.length > REASON_MAX) details.push({ path: "reason", message: `O motivo pode ter no máximo ${REASON_MAX} caracteres.` })
    else if (CONTROL_CHARS.test(r)) details.push({ path: "reason", message: "O motivo não pode ter quebras de linha nem caracteres de controle." })
  }
  return details
}

export function startRemote(opts: {
  chargePointId: string
  body: { connectorId?: unknown; userId?: unknown; reason?: unknown }
  scenario: RemoteStartScenario
  scope: { role: Role; operatorId: string | null }
}): RemoteStartOutcome {
  const { body, scenario } = opts
  if (scenario === "forbidden") return fail(403, "FORBIDDEN", "Apenas administradores da plataforma podem iniciar recarga remota.")
  const details = validateBody(body)
  if (details.length > 0) return fail(400, "VALIDATION_ERROR", "Dados inválidos.", details)

  const driver = getDriverWallet(String(body.userId), 1, 1)
  if (!driver) return fail(404, "USER_NOT_FOUND", "Motorista não encontrado.")
  const cp = mockChargePoints.find((c) => c.id === opts.chargePointId && (opts.scope.role === "ADMIN" || c.operatorId === opts.scope.operatorId))
  if (!cp) return fail(404, "CHARGE_POINT_NOT_FOUND", "Charge point não encontrado.")
  const connector = mockConnectors.find((c) => c.chargePointId === cp.id && c.connectorId === body.connectorId)
  if (!connector) return fail(404, "CONNECTOR_NOT_FOUND", "Conector não encontrado.")
  if (scenario === "offline") return fail(409, "CHARGE_POINT_OFFLINE", "Charge point está offline.")
  if (scenario === "busy" || connector.status !== "AVAILABLE") return fail(409, "CONNECTOR_BUSY", "Conector ocupado.", [{ path: "connectorStatus", message: connector.status }])
  if (driver.openDebtCents > 0) return fail(409, "DRIVER_HAS_OPEN_DEBT", "Motorista com dívida em aberto.")
  if (driver.balanceCents < 2000) return fail(409, "INSUFFICIENT_BALANCE", "Saldo insuficiente para iniciar uma recarga.")

  const correlationId = nextCorrelationId()
  commands.set(correlationId, { startedAt: Date.now(), scenario, operatorId: cp.operatorId })
  return { ok: true, status: 202, body: { correlationId, status: "PENDING", idTag: `VIRT-${correlationId.slice(-6)}`, walletBalanceCents: driver.balanceCents, estimatedMaxCostCents: Math.min(driver.balanceCents, 5000) } }
}

export type CommandStatusOutcome = { ok: true; body: AdminCommandStatusResponse } | { ok: false; status: number; code: string; message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 404 `COMMAND_NOT_FOUND` indistinguível para inexistente/expirado/fora de escopo; id que não é UUID = 400 (o servidor valida o parâmetro). */
export function commandStatus(correlationId: string, scope: { role: Role; operatorId: string | null }): CommandStatusOutcome {
  if (!UUID.test(correlationId)) return { ok: false, status: 400, code: "VALIDATION_ERROR", message: "Parâmetro inválido." }
  const record = commands.get(correlationId)
  if (!record || (scope.role !== "ADMIN" && record.operatorId !== scope.operatorId)) return { ok: false, status: 404, code: "COMMAND_NOT_FOUND", message: "Comando não encontrado ou expirado." }
  if (record.scenario === "not-found") return { ok: false, status: 404, code: "COMMAND_NOT_FOUND", message: "Comando não encontrado ou expirado." }
  if (record.scenario === "poll-5xx") return { ok: false, status: 500, code: "INTERNAL_ERROR", message: "Erro interno." }
  if (record.scenario === "stuck" || Date.now() - record.startedAt < PENDING_MS) return { ok: true, body: { status: "PENDING" } }
  const final: MeCommandStatus = record.scenario === "rejected" ? "REJECTED" : record.scenario === "timeout" ? "TIMEOUT" : "ACCEPTED"
  return { ok: true, body: { status: final } }
}
