import type Redis from 'ioredis'
import type { Queue } from 'bullmq'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { redis as redisPadrao } from '../../lib/redis'
import { incrWithTtl } from '../../lib/redisCounter'
import { decidirReenfileirarCaptura, severidadeCapturaPendente } from '../../core/pagamentos/politicaCapturaPendente'
import { createQueue, CAPTURAR_SESSAO_CARTAO_QUEUE_NAME } from '../../worker/queues'
import { enqueueCapturarSessaoCartao, type OpcoesJobCaptura } from './capturarSessaoCartao'

/**
 * REDE DE SEGURANÇA DA CAPTURA (F5.7, ALTO-1 do portão final do Órion).
 *
 * O buraco: `finalizarSessao` grava `CAPTURE_PENDING` na transação do Stop e só DEPOIS do commit enfileira o job de captura.
 * Se o enfileiramento falha (Redis fora) — ou se o job esgota as tentativas (Cielo/Redis/`PAYMENT_SECRETS_KEY` fora por mais
 * tempo que o backoff) — nada mais olhava para esse intent: energia entregue, nada cobrado, pré-autorização expirando no cartão.
 * O varredor antigo só ALERTAVA depois de 24 h.
 *
 * Agora, a cada rodada do varredor periódico (já repeatable), todo `CAPTURE_PENDING` parado há mais de
 * `CARD_CAPTURE_RETRY_AFTER_MINUTES` é REENFILEIRADO. É seguro repetir porque a captura é idempotente por RECONSULTA
 * (`capturarSessaoCartao` consulta a Cielo antes de capturar — se já está CAPTURED, só espelha) e porque o `jobId` é
 * determinístico (nunca dois jobs vivos para o mesmo intent).
 *
 * Estado do varredor (sem tocar no schema) vive no Redis, com TTL — perder isso só reinicia a contagem, nunca duplica captura:
 *  - `card-capture:cooldown:<id>`: espaça os reenfileiramentos do MESMO intent (SET NX EX = `RETRY_AFTER`) e limita o ALERTA
 *    de teto atingido a 1x/h;
 *  - `card-capture:sweeps:<id>`: quantas vezes o varredor já reenfileirou (teto `CARD_CAPTURE_MAX_SWEEP_RETRIES`).
 *
 * Gateway indisponível (produção sem credencial, config ilegível): NÃO reenfileira nem gasta o teto — não é culpa do intent —,
 * só alerta, pelo mesmo escalonamento de idade.
 */

const BATCH_SIZE = 50
const SWEEP_COUNT_TTL_SECONDS = 30 * 24 * 3600
const EXHAUSTED_ALERT_INTERVAL_SECONDS = 3600

export const chaveCooldownCaptura = (paymentIntentId: string) => `card-capture:cooldown:${paymentIntentId}`
export const chaveTentativasCaptura = (paymentIntentId: string) => `card-capture:sweeps:${paymentIntentId}`

export interface ReenfileirarCapturasPendentesResultado {
  reenfileiradas: number
  jaEmAndamento: number
  tetoAtingido: number
  semGateway: number
  falhas: number
}

export interface ReenfileirarCapturasPendentesDeps {
  /** `false` = gateway indisponível por configuração: só alerta, não enfileira. Default `true`. */
  gatewayDisponivel?: boolean
  redis?: Redis
  /** Fila injetada (testes usam uma própria; o dono fecha). Default: abre e fecha a fila padrão de captura. */
  queue?: Queue
  agora?: Date
  /** Só para teste: política de tentativas do job reduzida. */
  opcoesJob?: OpcoesJobCaptura
}

export async function reenfileirarCapturasPendentes(deps: ReenfileirarCapturasPendentesDeps = {}): Promise<ReenfileirarCapturasPendentesResultado> {
  const redis = deps.redis ?? redisPadrao
  const gatewayDisponivel = deps.gatewayDisponivel ?? true
  const agora = deps.agora ?? new Date()
  const retryAfterSeconds = env.CARD_CAPTURE_RETRY_AFTER_MINUTES * 60
  const limite = new Date(agora.getTime() - retryAfterSeconds * 1000)

  const resultado: ReenfileirarCapturasPendentesResultado = { reenfileiradas: 0, jaEmAndamento: 0, tetoAtingido: 0, semGateway: 0, falhas: 0 }

  const pendentes = await prisma.paymentIntent.findMany({
    where: { purpose: 'SESSION_CARD_CAPTURE', status: 'CAPTURE_PENDING', updatedAt: { lt: limite } },
    orderBy: { updatedAt: 'asc' }, // os mais antigos (mais perto de perder a pré-auth) primeiro
    take: BATCH_SIZE,
  })
  if (pendentes.length === 0) return resultado

  const queue = deps.queue ?? createQueue(CAPTURAR_SESSAO_CARTAO_QUEUE_NAME)
  try {
    for (const intent of pendentes) {
      const idadeMinutos = Math.floor((agora.getTime() - intent.updatedAt.getTime()) / 60_000)
      const severidade = severidadeCapturaPendente(idadeMinutos)
      try {
        const tentativas = Number((await redis.get(chaveTentativasCaptura(intent.id))) ?? '0')

        if (decidirReenfileirarCaptura(tentativas, env.CARD_CAPTURE_MAX_SWEEP_RETRIES) === 'TETO_ATINGIDO') {
          // Para de martelar a Cielo, mas NÃO esconde: alerta 1x/h até um humano resolver (ou apagar o contador).
          if ((await redis.set(chaveCooldownCaptura(intent.id), '1', 'EX', EXHAUSTED_ALERT_INTERVAL_SECONDS, 'NX')) === 'OK') {
            logger.error(
              { alert: 'payment_capture_retry_exhausted', paymentIntentId: intent.id, ageMinutes: idadeMinutos, severity: severidade, sweepAttempts: tentativas, captureAmountCents: intent.captureAmountCents },
              '[reenfileirarCapturasPendentes] captura de cartão NÃO concluiu e o teto de reenfileiramentos foi atingido — INTERVENÇÃO MANUAL (conferir a Cielo; apagar a chave card-capture:sweeps:<id> para retomar)',
            )
          }
          resultado.tetoAtingido++
          continue
        }

        // Espaça os reenfileiramentos do mesmo intent (e entre processos de worker): só quem pega o NX age.
        if ((await redis.set(chaveCooldownCaptura(intent.id), '1', 'EX', retryAfterSeconds, 'NX')) !== 'OK') continue

        if (!gatewayDisponivel) {
          logAlertaParada(severidade, { paymentIntentId: intent.id, ageMinutes: idadeMinutos, severity: severidade, sweepAttempts: tentativas, gatewayAvailable: false }, 'gateway indisponível — captura NÃO reenfileirada (não gasta o teto)')
          resultado.semGateway++
          continue
        }

        const enfileirou = await enqueueCapturarSessaoCartao(intent.id, queue, deps.opcoesJob)
        // Só conta no teto quando de fato reenfileirou — um job que já está vivo (esperando/ativo/atrasado) não gasta tentativa.
        const feitas = enfileirou === 'ENFILEIRADO' ? await incrWithTtl(redis, chaveTentativasCaptura(intent.id), SWEEP_COUNT_TTL_SECONDS) : tentativas
        if (enfileirou === 'JA_EM_ANDAMENTO') resultado.jaEmAndamento++
        else resultado.reenfileiradas++
        logAlertaParada(severidade, { paymentIntentId: intent.id, ageMinutes: idadeMinutos, severity: severidade, sweepAttempts: feitas, captureAmountCents: intent.captureAmountCents, enqueue: enfileirou }, 'captura de cartão pendente há tempo demais — reenfileirada')
      } catch (err) {
        resultado.falhas++
        logger.error({ err, paymentIntentId: intent.id }, '[reenfileirarCapturasPendentes] falha ao reenfileirar a captura deste intent — tenta de novo na próxima rodada')
      }
    }
  } finally {
    if (!deps.queue) await queue.close()
  }

  return resultado
}

/** `normal` (<1 h) é aviso; `alta` (>=1 h) e `critica` (>=24 h) são ERRO — é o escalonamento por idade pedido no portão. */
function logAlertaParada(severidade: 'normal' | 'alta' | 'critica', campos: Record<string, unknown>, mensagem: string): void {
  const payload = { alert: 'payment_capture_pending_stale', ...campos }
  const texto = `[reenfileirarCapturasPendentes] ${mensagem}`
  if (severidade === 'normal') logger.warn(payload, texto)
  else logger.error(payload, texto)
}
