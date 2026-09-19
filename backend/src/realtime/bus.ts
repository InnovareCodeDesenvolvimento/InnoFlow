import type Redis from 'ioredis'
import { createRedisConnection } from '../lib/redis'
import { logger } from '../lib/logger'
import { createChannelHub, type ChannelHub } from '../core/realtime/channelHub'
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

/**
 * CANAL PÚBLICO de estações ("eletropostos perto de mim" — Nova,
 * decisoes-mapa-eletropostos.md, decisão 5). Todo motorista LOGADO assina
 * (`/api/me/events`, junto com o próprio `ui:ev:user:{id}`).
 *
 * REGRA: nada pode ser publicado aqui que já não esteja na resposta REST
 * pública (`GET /api/sites`). Hoje só `chargepoint.status` (chargePointId/
 * connectorId/status — todos já públicos). NUNCA operatorId, userId, sessão,
 * saldo, potência instantânea. Como o canal é lido por qualquer motorista de
 * qualquer operador, um campo a mais aqui vaza para a plataforma inteira —
 * a fronteira multi-tenant deste canal é "o que ele carrega", não a
 * assinatura (por isso a regra vale no PUBLICADOR, ver `emit.ts`).
 *
 * Não existe SSE público sem login (conexão longa anônima = superfície de
 * exaustão; o `publicRateLimit` conta requisições, não duração) — visitante
 * anônimo fica no refetch periódico.
 */
export const STATIONS_CHANNEL = `${CHANNEL_PREFIX}stations`

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

/** Ver a regra no comentário de `STATIONS_CHANNEL`: só o que já é público. */
export function publishToStations(event: RealtimeEvent): Promise<void> {
  return publish(STATIONS_CHANNEL, event)
}

let hub: ChannelHub<RealtimeEvent> | undefined
function getHub(): ChannelHub<RealtimeEvent> {
  // Lazy: o gateway OCPP/worker importam este módulo só para PUBLICAR e não devem abrir um assinante.
  if (!hub) {
    hub = createChannelHub<RealtimeEvent>(createRedisConnection(), {
      onError: (err, context) => logger.error({ err }, `[realtime] ${context}`),
    })
  }
  return hub
}

/**
 * Assina um conjunto de canais no assinante Redis COMPARTILHADO do processo (Órion A2): um único
 * cliente Redis para todas as conexões SSE, com fan-out em memória (`core/realtime/channelHub.ts`).
 * Antes era uma conexão Redis por stream — 1000 abas = 1000 conexões. O ouvinte recebe o evento já
 * parseado E o texto cru (para o SSE não re-serializar por conexão). Retorna o "cancelar" —
 * SEMPRE chamar quando o `Response` fechar, senão o ouvinte vaza.
 */
export function subscribeChannels(channels: string[], listener: (event: RealtimeEvent, raw: string) => void): () => void {
  return getHub().subscribe(channels, listener)
}
