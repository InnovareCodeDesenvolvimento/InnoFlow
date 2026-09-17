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

export async function recordCommandResult(correlationId: string, status: CommandResultStatus): Promise<void> {
  await redis.set(`${KEY_PREFIX}${correlationId}`, status, 'PX', TTL_MS)
}

/** `null` = comando ainda em andamento OU a chave já expirou/nunca existiu — a rota trata as duas coisas como `PENDING`, não dá para distinguir e não precisa. */
export async function getCommandResult(correlationId: string): Promise<CommandResultStatus | null> {
  const value = await redis.get(`${KEY_PREFIX}${correlationId}`)
  return value as CommandResultStatus | null
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
