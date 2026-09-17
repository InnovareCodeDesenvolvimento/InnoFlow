import { randomUUID } from 'node:crypto'
import type Redis from 'ioredis'
import { createRedisConnection } from '../lib/redis'
import { logger } from '../lib/logger'
import { getConnection } from './registry'

/**
 * Barramento de comandos API -> carregador (decisão da Nova, ver
 * decisoes-arquitetura-ocpp.md). A API publica em `ocpp:cmd:{chargePointId}`;
 * o gateway OCPP que TEM a conexão local daquele charge point (só ele, por
 * causa do lock de `registry.ts`) executa o `client.call()` de verdade e
 * publica a resposta em `ocpp:reply:{correlationId}`. Todo nó do gateway
 * assina `ocpp:cmd:*`, mas só quem tem a conexão local age — os outros
 * ignoram silenciosamente (fan-out simples, sem serviço de descoberta).
 *
 * `sendCommand()` roda no processo da API. `startCommandListener()` roda no
 * processo do gateway OCPP. Os dois lados vivem neste módulo porque
 * compartilham os nomes de canal e o formato de mensagem — deixar em dois
 * arquivos separados arriscaria os dois lados divergirem em silêncio.
 */

const CMD_CHANNEL_PREFIX = 'ocpp:cmd:'
const REPLY_CHANNEL_PREFIX = 'ocpp:reply:'
const DEFAULT_TIMEOUT_MS = 35_000

interface CommandMessage {
  correlationId: string
  method: string
  params: Record<string, unknown>
}

interface CommandReply {
  correlationId: string
  ok: boolean
  result?: unknown
  error?: string
}

// ------------------------------------------------------------
// Lado da API — quem MANDA o comando
// ------------------------------------------------------------

let publisher: Redis | undefined
function getPublisher(): Redis {
  // Lazy: o entrypoint do gateway OCPP importa este módulo só para
  // `startCommandListener()` e não precisa abrir uma conexão de publisher
  // que nunca vai usar.
  if (!publisher) publisher = createRedisConnection()
  return publisher
}

export class OcppCommandError extends Error {}
export class OcppCommandTimeoutError extends OcppCommandError {}

/**
 * Envia um comando ao charge point e aguarda a resposta (ou timeout).
 * Lançado do processo da API. Quem chama decide se quer aguardar (ex.: um
 * job do worker) ou disparar em background (rotas HTTP 202 assíncronas —
 * ver `api/routes/chargePoints.routes.ts`).
 */
export async function sendCommand(
  chargePointId: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const correlationId = randomUUID()
  const replyChannel = `${REPLY_CHANNEL_PREFIX}${correlationId}`
  const subscriber = createRedisConnection()

  try {
    await subscriber.subscribe(replyChannel)

    // BUG REAL corrigido 17/09/2026: a versão anterior dava `await` nesta
    // Promise ANTES de publicar o comando — ou seja, ficava esperando uma
    // resposta a uma pergunta que ainda não tinha sido feita. Resultado:
    // TODO remote-start/stop/reset/etc. estourava o timeout de 35s sempre,
    // incondicionalmente, porque o `publish()` (a linha que de fato dispara
    // o comando) era código morto — só rodaria depois que a Promise abaixo
    // resolvesse, e ela só resolve em reação a uma resposta que depende
    // desse mesmo publish já ter acontecido. Confirmado em produção:
    // OcppCommandTimeoutError em 100% das tentativas, mesmo com o charge
    // point conectado e saudável. Ordem certa: registra o listener (sem
    // aguardar), publica, só DEPOIS aguarda a resposta.
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new OcppCommandTimeoutError(`Timeout aguardando resposta do charge point ${chargePointId} para ${method}.`))
      }, timeoutMs)
      timer.unref?.()

      subscriber.on('message', (channel, message) => {
        if (channel !== replyChannel) return
        clearTimeout(timer)
        try {
          const reply = JSON.parse(message) as CommandReply
          if (reply.ok) resolve(reply.result)
          else reject(new OcppCommandError(reply.error ?? `Comando ${method} falhou no charge point.`))
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })

    const message: CommandMessage = { correlationId, method, params }
    await getPublisher().publish(`${CMD_CHANNEL_PREFIX}${chargePointId}`, JSON.stringify(message))

    return await resultPromise
  } finally {
    subscriber.disconnect()
  }
}

// ------------------------------------------------------------
// Lado do gateway OCPP — quem RECEBE e executa no charge point
// ------------------------------------------------------------

let listenerStarted = false

export function startCommandListener(): void {
  if (listenerStarted) return
  listenerStarted = true

  const subscriber = createRedisConnection()
  const replyPublisher = createRedisConnection()

  subscriber.psubscribe(`${CMD_CHANNEL_PREFIX}*`).catch((err) => {
    logger.error({ err }, '[ocpp][commands] falha ao assinar canal de comandos')
  })

  subscriber.on('pmessage', (_pattern, channel, message) => {
    void handleIncomingCommand(channel, message, replyPublisher)
  })

  logger.info('[ocpp][commands] listener de comandos ativo')
}

async function handleIncomingCommand(channel: string, message: string, replyPublisher: Redis): Promise<void> {
  const chargePointId = channel.slice(CMD_CHANNEL_PREFIX.length)
  const client = getConnection(chargePointId)
  // Diagnóstico real, 17/09/2026: um remote-start ficou 35s sem NENHUM
  // rastro no log do gateway (nem "recebido", nem "sem conexão local", nem
  // erro) — impossível saber se o pmessage chegou e foi ignorado (nó errado,
  // comportamento esperado com N>1 réplicas) ou se nunca chegou. Log
  // explícito nos dois ramos a partir de agora, mesmo o "ignorado" — em N=1
  // réplica (o caso real hoje) isso não deveria nunca disparar, então vale
  // saber se dispara.
  if (!client) {
    logger.warn({ chargePointId, channel }, '[ocpp][commands] comando recebido mas sem conexão local para este charge point')
    return
  }
  logger.info({ chargePointId, channel }, '[ocpp][commands] comando recebido, conexão local encontrada')

  let payload: CommandMessage
  try {
    payload = JSON.parse(message) as CommandMessage
  } catch (err) {
    logger.error({ err, message }, '[ocpp][commands] mensagem de comando malformada')
    return
  }

  const replyChannel = `${REPLY_CHANNEL_PREFIX}${payload.correlationId}`

  try {
    logger.info({ chargePointId, method: payload.method, correlationId: payload.correlationId }, '[ocpp][commands] enviando ao charge point')
    const result = await client.call(payload.method, payload.params ?? {}, { callTimeoutMs: DEFAULT_TIMEOUT_MS })
    logger.info({ chargePointId, method: payload.method, correlationId: payload.correlationId, result }, '[ocpp][commands] charge point respondeu')
    const reply: CommandReply = { correlationId: payload.correlationId, ok: true, result }
    await replyPublisher.publish(replyChannel, JSON.stringify(reply))
  } catch (err) {
    logger.error({ err, chargePointId, method: payload.method, correlationId: payload.correlationId }, '[ocpp][commands] falha ao enviar/receber do charge point')
    const reply: CommandReply = { correlationId: payload.correlationId, ok: false, error: err instanceof Error ? err.message : String(err) }
    await replyPublisher.publish(replyChannel, JSON.stringify(reply))
  }
}
