import { redis } from '../lib/redis'

/**
 * Conserta o "202 cego" dos comandos remotos fire-and-forget (achado de
 * produto do PWA do motorista, F6 — ver decisoes-pwa-motorista.md §4): o
 * resultado de `sendCommand()` hoje só vai para o log, então quem disparou o
 * comando via HTTP não tem como saber se o carregador aceitou ou rejeitou
 * sem consultar o log do servidor. Isto grava o resultado em Redis por
 * `correlationId`, com TTL curto — `GET /api/me/commands/:correlationId`
 * (motorista) e `GET /api/admin/commands/:correlationId` (staff, L1.5) só
 * leem essa chave.
 *
 * Sem migration nova (mesmo espírito do dedupe de auto-stop em
 * `meterValues.ts`) — é estado efêmero, não precisa sobreviver a um restart.
 */

const KEY_PREFIX = 'ocpp:cmdresult:'
/** 2min — bem maior que o timeout de 35s de um comando, dá folga pro cliente consultar depois de reconectar. */
const TTL_MS = 120_000

export type CommandResultStatus = 'ACCEPTED' | 'REJECTED' | 'TIMEOUT'
/** Estado gravado: os 3 resultados de verdade + `PENDING` (o registro nasce no disparo, antes de o carregador responder — é o que distingue "em andamento" de "id desconhecido/expirado" na consulta do staff). */
export type CommandRecordStatus = CommandResultStatus | 'PENDING'

/**
 * DONO e ESCOPO do comando (L1.5). `userId` = o motorista afetado (`/api/me/commands` só responde a ele); `chargePointId`/`operatorId` = onde o comando foi disparado
 * (`/api/admin/commands` só responde a quem enxerga aquele operador). Todos vêm do SERVIDOR (linha do charge point/sessão já resolvida sob o escopo de quem chamou), nunca do cliente.
 */
export interface CommandOwner {
  userId: string
  chargePointId: string
  operatorId: string
}

export interface CommandRecord {
  userId: string
  status: CommandRecordStatus
  /** `null` só em registro do formato ANTIGO (`userId|status`, anterior à L1.5; vive no máximo 2 min depois do deploy) — staff de operador NUNCA o enxerga. */
  chargePointId: string | null
  operatorId: string | null
}

const STATUS_VALIDOS: ReadonlySet<string> = new Set<CommandRecordStatus>(['ACCEPTED', 'REJECTED', 'TIMEOUT', 'PENDING'])

/**
 * Valor gravado: `<userId>|<status>|<chargePointId>|<operatorId>`. O resultado fica VINCULADO ao motorista (Órion, 19/09/2026) E ao escopo do operador (L1.5): sem isso,
 * `GET /api/me/commands/:correlationId` respondia o status de QUALQUER correlationId para qualquer motorista logado (o UUID é imprevisível, mas vaza em log e em resposta 202 —
 * defesa em profundidade) e a consulta admin vazaria entre operadores. Os ids são cuids (sem `|`).
 */
export function encodeCommandResult(owner: CommandOwner, status: CommandRecordStatus): string {
  return `${owner.userId}|${status}|${owner.chargePointId}|${owner.operatorId}`
}

/** `null` = ausente ou malformado. Aceita também o formato antigo de 2 partes (`userId|status`). */
export function decodeCommandRecord(raw: string | null): CommandRecord | null {
  if (!raw) return null
  const parts = raw.split('|')
  if (parts.length !== 2 && parts.length !== 4) return null
  const [userId, status, chargePointId, operatorId] = parts
  if (!userId || !status || !STATUS_VALIDOS.has(status)) return null
  if (parts.length === 4 && (!chargePointId || !operatorId)) return null
  return { userId, status: status as CommandRecordStatus, chargePointId: chargePointId ?? null, operatorId: operatorId ?? null }
}

/** `null` quando o valor é de OUTRO usuário, está malformado, não existe OU ainda está `PENDING` — a rota do motorista trata tudo como `PENDING` (indistinguível de "ainda em andamento": não confirma que o correlationId existe). */
export function decodeCommandResult(raw: string | null, userId: string): CommandResultStatus | null {
  const record = decodeCommandRecord(raw)
  if (!record || record.userId !== userId || record.status === 'PENDING') return null
  return record.status
}

/**
 * Regra de escopo da consulta do STAFF (`GET /api/admin/commands/:id`). `scope` é o `operatorScopeWhere(req)`: `{}` (ADMIN) enxerga todos; `{ operatorId }` (OPERATOR) só os do
 * próprio operador. Registro sem `operatorId` (formato antigo) NUNCA é visível a OPERATOR. `null` = "não existe" — fora do escopo é indistinguível de inexistente/expirado.
 */
export function decodeCommandStatusForStaff(raw: string | null, scope: { operatorId?: string }): CommandRecordStatus | null {
  const record = decodeCommandRecord(raw)
  if (!record) return null
  // `in` (não `!== undefined`): um escopo `{ operatorId: undefined }` por bug do chamador falha FECHADO (não vê nada) em vez de virar "ADMIN vê tudo".
  if ('operatorId' in scope && record.operatorId !== scope.operatorId) return null
  return record.status
}

export async function recordCommandResult(correlationId: string, status: CommandRecordStatus, owner: CommandOwner): Promise<void> {
  await redis.set(`${KEY_PREFIX}${correlationId}`, encodeCommandResult(owner, status), 'PX', TTL_MS)
}

/**
 * Registra "em andamento" NO DISPARO. Chamar SEM await (fire-and-forget com `.catch`): o ioredis enfileira se o Redis cair e isto não pode pendurar o 202. A ordem dos comandos
 * na MESMA conexão garante que o resultado, gravado depois, nunca seja sobrescrito por este.
 */
export function recordCommandPending(correlationId: string, owner: CommandOwner): Promise<void> {
  return recordCommandResult(correlationId, 'PENDING', owner)
}

/** `null` = comando ainda em andamento, a chave já expirou/nunca existiu OU pertence a outro usuário — a rota trata tudo como `PENDING`. */
export async function getCommandResult(correlationId: string, userId: string): Promise<CommandResultStatus | null> {
  return decodeCommandResult(await redis.get(`${KEY_PREFIX}${correlationId}`), userId)
}

/** Consulta do staff: `null` = 404 (inexistente, expirado ou fora do escopo — indistinguíveis). */
export async function getCommandStatusForStaff(correlationId: string, scope: { operatorId?: string }): Promise<CommandRecordStatus | null> {
  return decodeCommandStatusForStaff(await redis.get(`${KEY_PREFIX}${correlationId}`), scope)
}

/**
 * O resultado bruto de `sendCommand()` para RemoteStartTransaction/
 * RemoteStopTransaction é o corpo da resposta OCPP: `{ status: 'Accepted' |
 * 'Rejected' }`. `unknown` porque `sendCommand()` não tipa o retorno (é
 * genérico para qualquer method OCPP) — checagem defensiva de shape.
 */
export function isAcceptedCommandResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'status' in result && (result as { status?: unknown }).status === 'Accepted'
}
