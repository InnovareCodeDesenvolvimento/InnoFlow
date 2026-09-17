import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { liquidarSessao } from '../../services/carteira/liquidarSessao'
import { LIQUIDAR_SESSAO_QUEUE_NAME, type LiquidarSessaoJobData } from '../queues'

/**
 * Processa o retry de liquidação enfileirado pelo `StopTransaction` quando a
 * `$transaction` inline falha (ver `services/carteira/liquidarSessao.ts`).
 * `liquidarSessao` já é idempotente — reprocessar o mesmo job (retry do
 * próprio BullMQ, ou reentrega) nunca duplica o débito.
 */
export function startLiquidarSessaoWorker(): Worker<LiquidarSessaoJobData> {
  const worker = new Worker<LiquidarSessaoJobData>(
    LIQUIDAR_SESSAO_QUEUE_NAME,
    async (job: Job<LiquidarSessaoJobData>) => {
      await liquidarSessao(job.data.sessionId)
    },
    { connection: createRedisConnection(), concurrency: 5 },
  )

  worker.on('failed', (job, err) => {
    logger.error({ err, sessionId: job?.data.sessionId, attemptsMade: job?.attemptsMade }, '[worker][liquidar-sessao] job falhou')
  })
  worker.on('completed', (job) => {
    logger.info({ sessionId: job.data.sessionId }, '[worker][liquidar-sessao] job concluído')
  })

  logger.info('[worker][liquidar-sessao] worker ativo')
  return worker
}
