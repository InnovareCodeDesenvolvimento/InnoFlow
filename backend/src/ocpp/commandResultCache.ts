import { redis } from '../lib/redis'

/**
 * Conserta o "202 cego" dos comandos remotos fire-and-forget (achado de
 * produto do PWA do motorista, F6 — ver decisoes-pwa-motorista.md §4): o
 * resultado de `sendCommand()` hoje só vai para o log, então quem disparou o
 * comando via HTTP não tem como saber se o carregador aceitou ou rejeitou
 * sem consultar o log do servidor. Isto grava o resultado em Redis por
 * `correlationId`, com TTL curto — `GET /api/me/commands/:correlationId` só
 * lê essa chave.
 *
 * Sem migration nova (mesmo espírito do dedupe de auto-stop em
 * `meterValues.ts`) — é estado efêmero, não precisa sobreviver a um restart.
 */

const KEY_PREFIX = 'ocpp:cmdresult:'
/** 2min — bem maior que o timeout de 35s de um comando, dá folga pro cliente consultar depois de reconectar. */
const TTL_MS = 120_000

export type CommandResultStatus = 'ACCEPTED' | 'REJECTED' | 'TIMEOUT'

/**
 * O resultado fica VINCULADO ao usuário que disparou o comando (Órion, 19/09/2026): o valor gravado
 * é `<userId>|<status>`. Sem isso, `GET /api/me/commands/:correlationId` respondia o status de
 * QUALQUER correlationId para qualquer motorista logado (o UUID é imprevisível, mas vaza em log e
 * em resposta 202 — defesa em profundidade). `userId` é um cuid (sem `|`).
 */
export function encodeCommandResult(userId: string, status: CommandResultStatus): string {
  return `${userId}|${status}`
}

/** `null` quando o valor é de OUTRO usuário, está malformado ou não existe — a rota trata como `PENDING` (indistinguível de "ainda em andamento": não confirma que o correlationId existe). */
export function decodeCommandResult(raw: string | null, userId: string): CommandResultStatus | null {
  if (!raw) return null
  const separator = raw.indexOf('|')
  if (separator < 0 || raw.slice(0, separator) !== userId) return null
  const status = raw.slice(separator + 1)
  return status === 'ACCEPTED' || status === 'REJECTED' || status === 'TIMEOUT' ? status : null
}

export async function recordCommandResult(correlationId: string, status: CommandResultStatus, userId: string): Promise<void> {
  await redis.set(`${KEY_PREFIX}${correlationId}`, encodeCommandResult(userId, status), 'PX', TTL_MS)
}

/** `null` = comando ainda em andamento, a chave já expirou/nunca existiu OU pertence a outro usuário — a rota trata tudo como `PENDING`. */
export async function getCommandResult(correlationId: string, userId: string): Promise<CommandResultStatus | null> {
  return decodeCommandResult(await redis.get(`${KEY_PREFIX}${correlationId}`), userId)
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
