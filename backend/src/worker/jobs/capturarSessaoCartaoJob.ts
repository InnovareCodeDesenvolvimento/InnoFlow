import { DelayedError, Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { ehGatewayIndisponivelPorConfiguracao } from '../../core/pagamentos/erros'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { capturarSessaoCartao, CapturaCartaoEmAndamentoError } from '../../services/pagamentos/capturarSessaoCartao'
import { getPagamentoPort } from '../../services/pagamentos/pagamentoPortInstance'
import { CAPTURAR_SESSAO_CARTAO_QUEUE_NAME, type CapturarSessaoCartaoJobData } from '../queues'

/**
 * Quanto o job espera antes de olhar o gateway de novo quando ele está INDISPONÍVEL POR CONFIGURAÇÃO (produção sem
 * credencial, config ilegível/indecifrável, `PAYMENT_SECRETS_KEY` trocada). F5.7: antes isso LANÇAVA, e cada volta gastava
 * uma das tentativas do job — a config fora do ar por alguns minutos esgotava tudo e deixava o intent parado.
 */
export const GATEWAY_INDISPONIVEL_ADIAR_MS = 60_000

export interface CapturarSessaoCartaoWorkerOptions {
  /** Só para teste: fila própria (a fila padrão é compartilhada com a suíte inteira). */
  queueName?: string
  /** Só para teste: resolvedor da porta de pagamento. Default: `getPagamentoPort` (decide Cielo/Fake pela config). */
  getPort?: () => Promise<PagamentoPort>
  /** Só para teste: quanto adiar quando o gateway está indisponível. */
  adiarMs?: number
}

/**
 * Processa a captura de sessão CARD enfileirada por `finalizarSessao.ts` (F5.4) ou reenfileirada pelo varredor
 * (`reenfileirarCapturasPendentes`, F5.7). `capturarSessaoCartao` já é idempotente por construção — reentrega do BullMQ
 * (retry, ou reprocessamento) nunca duplica a captura nem a dívida.
 *
 * Gateway indisponível por CONFIGURAÇÃO: o job é ADIADO (`moveToDelayed` + `DelayedError`), o que NÃO consome tentativa
 * — a falha não é da captura, é da instalação, e passa quando alguém corrige a config. Qualquer OUTRO erro (Cielo fora,
 * timeout, status pendente) propaga e o BullMQ retenta com backoff.
 */
export function startCapturarSessaoCartaoWorker(options: CapturarSessaoCartaoWorkerOptions = {}): Worker<CapturarSessaoCartaoJobData> {
  const getPort = options.getPort ?? getPagamentoPort
  const adiarMs = options.adiarMs ?? GATEWAY_INDISPONIVEL_ADIAR_MS

  const worker = new Worker<CapturarSessaoCartaoJobData>(
    options.queueName ?? CAPTURAR_SESSAO_CARTAO_QUEUE_NAME,
    async (job: Job<CapturarSessaoCartaoJobData>, token?: string) => {
      let port: PagamentoPort
      try {
        port = await getPort()
      } catch (err) {
        if (!ehGatewayIndisponivelPorConfiguracao(err)) throw err
        logger.warn(
          { paymentIntentId: job.data.paymentIntentId, adiarMs, motivo: err instanceof Error ? err.name : 'desconhecido' },
          '[worker][capturar-sessao-cartao] gateway indisponível por configuração — captura ADIADA sem gastar tentativa',
        )
        await job.moveToDelayed(Date.now() + adiarMs, token)
        throw new DelayedError()
      }
      await capturarSessaoCartao(job.data.paymentIntentId, port)
    },
    { connection: createRedisConnection(), concurrency: 5 },
  )

  worker.on('failed', (job, err) => {
    // Outro executor está capturando este intent (lock por intent): é esperado, o job retenta com backoff — não é alarme.
    if (err instanceof CapturaCartaoEmAndamentoError) {
      logger.warn({ paymentIntentId: job?.data.paymentIntentId, attemptsMade: job?.attemptsMade }, '[worker][capturar-sessao-cartao] captura em andamento em outro executor — job vai retentar')
      return
    }
    logger.error({ err, paymentIntentId: job?.data.paymentIntentId, attemptsMade: job?.attemptsMade }, '[worker][capturar-sessao-cartao] job falhou')
  })
  worker.on('completed', (job) => {
    logger.info({ paymentIntentId: job.data.paymentIntentId }, '[worker][capturar-sessao-cartao] job concluído')
  })

  logger.info('[worker][capturar-sessao-cartao] worker ativo')
  return worker
}
