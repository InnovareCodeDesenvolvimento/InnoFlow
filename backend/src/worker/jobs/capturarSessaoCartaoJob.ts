import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { capturarSessaoCartao } from '../../services/pagamentos/capturarSessaoCartao'
import { getPagamentoPort } from '../../services/pagamentos/pagamentoPortInstance'
import { CAPTURAR_SESSAO_CARTAO_QUEUE_NAME, type CapturarSessaoCartaoJobData } from '../queues'

/**
 * Processa a captura de sessão CARD enfileirada por `finalizarSessao.ts`
 * (F5.4). `capturarSessaoCartao` já é idempotente por construção — reentrega
 * do BullMQ (retry, ou reprocessamento) nunca duplica a captura nem a dívida.
 */
export function startCapturarSessaoCartaoWorker(): Worker<CapturarSessaoCartaoJobData> {
  const worker = new Worker<CapturarSessaoCartaoJobData>(
    CAPTURAR_SESSAO_CARTAO_QUEUE_NAME,
    async (job: Job<CapturarSessaoCartaoJobData>) => {
      await capturarSessaoCartao(job.data.paymentIntentId, getPagamentoPort())
    },
    { connection: createRedisConnection(), concurrency: 5 },
  )

  worker.on('failed', (job, err) => {
    logger.error({ err, paymentIntentId: job?.data.paymentIntentId, attemptsMade: job?.attemptsMade }, '[worker][capturar-sessao-cartao] job falhou')
  })
  worker.on('completed', (job) => {
    logger.info({ paymentIntentId: job.data.paymentIntentId }, '[worker][capturar-sessao-cartao] job concluído')
  })

  logger.info('[worker][capturar-sessao-cartao] worker ativo')
  return worker
}
