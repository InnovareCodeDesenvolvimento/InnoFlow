import type Redis from 'ioredis'
import { createRedisConnection } from '../lib/redis'
import { logger } from '../lib/logger'
import { createLogGate } from '../lib/rateLimitedLog'
import { DeadlineExceededError, withDeadline } from '../lib/withDeadline'
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

/** Estado da conexão de PUBLICAÇÃO (diagnóstico/testes): `ready`, `reconnecting`, ... */
export function publisherStatus(): string {
  return getPublisher().status
}

/**
 * Prazo do publish. Vários chamadores fazem `await` do publish DEPOIS de o dinheiro/sessão já ter
 * sido gravado (`walletLedger`, `finalizarSessao`, `liquidarSessao`): com o Redis fora do ar, esse
 * `await` é o tempo a mais da resposta. Curto de propósito (mesma ordem do `throttleSafely` do login).
 */
export const PUBLISH_TIMEOUT_MS = 500

/**
 * Teto de publishes SEM resposta ao mesmo tempo. Com o Redis fora do ar o ioredis não rejeita: ele
 * ENFILEIRA o comando (fila offline, sem limite próprio) e o comando abandonado pelo prazo continua
 * lá até a reconexão — numa queda longa, cada evento do sistema empilharia mais um. Acima do teto o
 * evento é DESCARTADO na hora (evento de UI é best-effort e o polling de segurança cobre); abaixo, o
 * pior caso ao voltar é entregar no máximo este tanto de eventos atrasados.
 */
export const MAX_PUBLISHES_IN_FLIGHT = 100

/**
 * Disjuntor de ESPERA (não de envio) para o Redis lento ou mudo: depois de UM publish estourar o prazo,
 * os seguintes por este tempo AINDA SÃO ENVIADOS (o comando vai para a conexão), mas o chamador não
 * espera por eles — em vez de cada um pagar os 500ms de novo (vários `await publish` em sequência
 * dentro de um mesmo fluxo de negócio somariam segundos). Curto para o Redis que volta ser notado logo.
 *
 * Por que NÃO descartar: com a conexão `ready` o Redis está vivo — lento (fork de BGSAVE, disco, CPU
 * disputada), mas entrega. Descartar o envio perdia evento que ele entregaria: o `session.stopped`
 * estourava o prazo, abria o disjuntor e o `wallet.updated` seguinte era jogado fora — o motorista via a
 * sessão encerrada com o saldo velho (o frontend só invalida a carteira no `wallet.updated`). Quem
 * protege a fila de eventos velhos é o teto `MAX_PUBLISHES_IN_FLIGHT`; com o Redis DERRUBADO (a conexão
 * sabe que caiu) o descarte é imediato: ver `connectionIsDown`. (Nome antigo mantido: o teste de
 * resiliência importa esta constante.)
 */
export const PUBLISH_CIRCUIT_OPEN_MS = 1_000

/** A conexão SABE que está fora (reconectando/fechada): enfileirar só empilha comando que ninguém vai esperar. Inclui só o que é certeza — 'connecting' pode ser o primeiro uso da conexão preguiçosa. */
function connectionIsDown(connection: Redis): boolean {
  return connection.status === 'reconnecting' || connection.status === 'close' || connection.status === 'end'
}

let publishesInFlight = 0
let waitSkippedUntil = 0
const logPublishFailure = createLogGate(10_000)

/**
 * Publica em um canal — best-effort, NUNCA lança E NUNCA pendura (evento de UI não pode derrubar
 * nem atrasar o fluxo de negócio que o originou: uma sessão que termina/um saldo que muda tem que
 * persistir no banco, e a resposta sair, mesmo que o Redis esteja fora do ar naquele instante; o pior
 * caso é a tela não atualizar sozinha, e o polling de segurança cobre isso — ver decisão 7 da Nova).
 *
 * O `.catch` sozinho NÃO bastava: com `maxRetriesPerRequest: null` (exigência do BullMQ) o ioredis
 * não rejeita com o Redis fora — enfileira e espera reconectar, então o `await` nunca voltava. Duas
 * decisões separadas, que antes eram uma só:
 *  - ENVIAR: sempre, com a conexão de pé. Só descarta com a conexão sabidamente fora
 *    (`connectionIsDown`) ou com o teto de pendentes cheio (`MAX_PUBLISHES_IN_FLIGHT`).
 *  - ESPERAR: até `PUBLISH_TIMEOUT_MS`; se estourar, por `PUBLISH_CIRCUIT_OPEN_MS` os seguintes são
 *    enviados sem espera. O comando abandonado pelo prazo segue na conexão e o Redis o entrega quando
 *    responder (a ordem de envio é preservada).
 */
export async function publish(channel: string, event: RealtimeEvent): Promise<void> {
  let pending: Promise<number>
  try {
    const connection = getPublisher()
    if (connectionIsDown(connection) || publishesInFlight >= MAX_PUBLISHES_IN_FLIGHT) {
      logPublishFailure((suppressed) => logger.warn({ channel, type: event.type, status: connection.status, suppressed }, '[realtime] Redis indisponível — evento de UI descartado (best-effort)'))
      return
    }
    pending = connection.publish(channel, JSON.stringify(event))
  } catch (err) {
    logPublishFailure((suppressed) => logger.error({ err, channel, type: event.type, suppressed }, '[realtime] falha ao publicar evento (best-effort, não propaga)'))
    return
  }

  publishesInFlight++
  // O contador desce quando o comando de fato liquida (não no prazo): é ele que mede a fila do ioredis.
  // É também quem registra a falha do comando, aguardado ou não (o `await` abaixo não loga erro do Redis: seria em dobro).
  pending.then(
    () => publishesInFlight--,
    (err: unknown) => {
      publishesInFlight--
      logPublishFailure((suppressed) => logger.error({ err, channel, type: event.type, suppressed }, '[realtime] falha ao publicar evento (best-effort, não propaga)'))
    },
  )

  if (Date.now() < waitSkippedUntil) return // Redis lento há pouco: o comando já foi, mas este fluxo não paga o prazo de novo
  try {
    await withDeadline(pending, PUBLISH_TIMEOUT_MS, 'publish no Redis')
  } catch (err) {
    if (!(err instanceof DeadlineExceededError)) return // falha do próprio comando: já registrada acima
    waitSkippedUntil = Date.now() + PUBLISH_CIRCUIT_OPEN_MS
    logPublishFailure((suppressed) => logger.warn({ err, channel, type: event.type, suppressed }, '[realtime] Redis lento — não esperando a confirmação do publish (o comando segue e é entregue quando o Redis responder)'))
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
