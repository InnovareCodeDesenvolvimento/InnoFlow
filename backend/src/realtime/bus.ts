import type Redis from 'ioredis'
import { createRedisConnection } from '../lib/redis'
import { logger } from '../lib/logger'
import type { RealtimeEvent } from './events'

/**
 * Barramento de eventos de UI (Redis pub/sub), namespace PRÓPRIO `ui:ev:*` —
 * NÃO reaproveita `ocpp:cmd:*`/`ocpp:reply:*` (`ocpp/commands.ts`): mesmo
 * transporte, contrato oposto. O barramento de comando é request/reply de
 * consumidor único (só quem tem a conexão local do charge point responde);
 * evento de UI é fan-out best-effort para N assinantes (0, 1 ou 100 abas
 * abertas, tanto faz). Ver decisão da Nova (decisoes-tempo-real-sse.md,
 * item 2).
 *
 * Fronteira multi-tenant na ASSINATURA do canal, não num `if` depois de
 * receber (item 3 da Nova): uma conexão SSE de um OPERATOR só assina
 * `ui:ev:op:{seu-próprio-operatorId}` — nunca existe a possibilidade de
 * receber o canal de outro operador, então não há `if` para esquecer.
 */

const CHANNEL_PREFIX = 'ui:ev:'
export const ADMIN_CHANNEL = `${CHANNEL_PREFIX}admin`

export function operatorChannel(operatorId: string): string {
  return `${CHANNEL_PREFIX}op:${operatorId}`
}

export function userChannel(userId: string): string {
  return `${CHANNEL_PREFIX}user:${userId}`
}

let publisher: Redis | undefined
function getPublisher(): Redis {
  if (!publisher) publisher = createRedisConnection()
  return publisher
}

/**
 * Publica em um canal — best-effort, NUNCA lança (evento de UI não pode
 * derrubar o fluxo de negócio que o originou: uma sessão que termina/um
 * saldo que muda tem que persistir no banco mesmo que o Redis esteja fora
 * do ar naquele instante; o pior caso é a tela não atualizar sozinha, e o
 * polling de segurança cobre isso — ver decisão 7 da Nova).
 */
export async function publish(channel: string, event: RealtimeEvent): Promise<void> {
  try {
    await getPublisher().publish(channel, JSON.stringify(event))
  } catch (err) {
    logger.error({ err, channel, type: event.type }, '[realtime] falha ao publicar evento (best-effort, não propaga)')
  }
}

export function publishToOperator(operatorId: string, event: RealtimeEvent): Promise<void> {
  return publish(operatorChannel(operatorId), event)
}

export function publishToUser(userId: string, event: RealtimeEvent): Promise<void> {
  return publish(userChannel(userId), event)
}

export function publishToAdmin(event: RealtimeEvent): Promise<void> {
  return publish(ADMIN_CHANNEL, event)
}

/**
 * Assina um conjunto de canais numa conexão Redis DEDICADA (uma por conexão
 * SSE — mesmo padrão de `sendCommand()` em `ocpp/commands.ts`: uma conexão
 * em modo subscriber não pode ser reaproveitada para outros comandos).
 * Retorna uma função de limpeza — SEMPRE chamar quando o `Response` fechar
 * (`req.on('close', ...)`), senão a conexão Redis vaza.
 */
export function subscribeChannels(channels: string[], onEvent: (event: RealtimeEvent) => void): () => void {
  const subscriber = createRedisConnection()
  let closed = false

  subscriber.on('message', (channel, message) => {
    if (closed || !channels.includes(channel)) return
    try {
      onEvent(JSON.parse(message) as RealtimeEvent)
    } catch (err) {
      logger.error({ err, channel }, '[realtime] evento malformado recebido — ignorado')
    }
  })

  if (channels.length > 0) {
    subscriber.subscribe(...channels).catch((err) => {
      logger.error({ err, channels }, '[realtime] falha ao assinar canais')
    })
  }

  return () => {
    if (closed) return
    closed = true
    subscriber.disconnect()
  }
}
