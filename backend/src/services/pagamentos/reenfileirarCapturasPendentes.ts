import type { PaymentIntent } from '@prisma/client'
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

/** Quantos intents ACIONÁVEIS (nem com teto atingido, nem em cooldown) uma rodada processa. */
const BATCH_SIZE = 50
/**
 * Tamanho da página da varredura e teto de intents olhados por rodada. O lote antigo (`take 50 orderBy updatedAt asc`) passava FOME:
 * intent com o teto atingido nunca muda `updatedAt`, então ficava para sempre no começo da fila e, com 50 deles, nenhum intent novo
 * era visto. Agora a seleção PAGINA (cursor por `updatedAt, id`) pulando o que não é acionável até juntar `BATCH_SIZE` acionáveis.
 * O teto de varredura limita o custo (1 round trip de Redis por página) caso muita gente deixe intents esgotados sem resolver.
 */
const SCAN_PAGE_SIZE = 200
const MAX_SCANNED_INTENTS = 2000
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

  const pendentes = await selecionarPendentesAcionaveis(redis, limite)
  if (pendentes.length === 0) return resultado

  const queue = deps.queue ?? createQueue(CAPTURAR_SESSAO_CARTAO_QUEUE_NAME)
  try {
    for (const { intent, tentativas } of pendentes) {
      const idadeMinutos = Math.floor((agora.getTime() - intent.updatedAt.getTime()) / 60_000)
      const severidade = severidadeCapturaPendente(idadeMinutos)
      try {
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

interface PendenteSelecionado {
  intent: PaymentIntent
  /** Quantas vezes o varredor já reenfileirou (contador no Redis). */
  tentativas: number
}

/**
 * Junta até `BATCH_SIZE` intents ACIONÁVEIS, do mais antigo para o mais novo, paginando por cursor (`updatedAt, id`).
 *  - com o teto atingido: ENTRA na lista (o loop principal ainda emite o alerta `payment_capture_retry_exhausted`, 1x/h), mas NÃO gasta
 *    vaga do lote — é o que impede a inanição;
 *  - em cooldown (reenfileirado há menos de `RETRY_AFTER`): fica de fora, não é acionável agora (o `SET NX` do loop continua sendo
 *    quem decide de verdade; este `EXISTS` só evita que ele ocupe vaga);
 *  - leitura do Redis que falha: entra como acionável e o `try/catch` por intent do loop conta `falhas` (nunca perde o intent de vista).
 * Sem schema novo: o "marcador" do esgotado é o próprio contador do Redis, e retomar continua sendo apagar a chave.
 */
async function selecionarPendentesAcionaveis(redis: Redis, limite: Date): Promise<PendenteSelecionado[]> {
  const selecionados: PendenteSelecionado[] = []
  let acionaveis = 0
  let varridos = 0
  let cursorId: string | undefined
  let ultimaPaginaCheia = false

  while (acionaveis < BATCH_SIZE && varridos < MAX_SCANNED_INTENTS) {
    const pagina = await prisma.paymentIntent.findMany({
      where: { purpose: 'SESSION_CARD_CAPTURE', status: 'CAPTURE_PENDING', updatedAt: { lt: limite } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], // os mais antigos (mais perto de perder a pré-auth) primeiro
      take: SCAN_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    })
    if (pagina.length === 0) {
      ultimaPaginaCheia = false
      break
    }
    varridos += pagina.length
    ultimaPaginaCheia = pagina.length === SCAN_PAGE_SIZE
    cursorId = pagina[pagina.length - 1]!.id

    const pipeline = redis.pipeline()
    for (const intent of pagina) {
      pipeline.get(chaveTentativasCaptura(intent.id))
      pipeline.exists(chaveCooldownCaptura(intent.id))
    }
    const respostas = (await pipeline.exec()) ?? []

    for (let i = 0; i < pagina.length && acionaveis < BATCH_SIZE; i++) {
      const intent = pagina[i]!
      const [erroTentativas, valorTentativas] = respostas[2 * i] ?? [new Error('sem resposta'), null]
      const [erroCooldown, valorCooldown] = respostas[2 * i + 1] ?? [new Error('sem resposta'), null]
      if (erroTentativas || erroCooldown) {
        selecionados.push({ intent, tentativas: 0 })
        acionaveis++
        continue
      }
      const tentativas = Number(valorTentativas ?? '0')
      if (decidirReenfileirarCaptura(tentativas, env.CARD_CAPTURE_MAX_SWEEP_RETRIES) === 'TETO_ATINGIDO') {
        selecionados.push({ intent, tentativas })
        continue
      }
      if (Number(valorCooldown) > 0) continue
      selecionados.push({ intent, tentativas })
      acionaveis++
    }
    if (pagina.length < SCAN_PAGE_SIZE) break
  }

  if (acionaveis < BATCH_SIZE && varridos >= MAX_SCANNED_INTENTS && ultimaPaginaCheia) {
    logger.warn(
      { alert: 'payment_capture_sweep_scan_truncated', scanned: varridos, actionable: acionaveis },
      '[reenfileirarCapturasPendentes] a varredura atingiu o teto de intents olhados sem juntar um lote inteiro — há muitas capturas esgotadas esperando intervenção manual; podem existir pendentes acionáveis além do teto',
    )
  }
  return selecionados
}
