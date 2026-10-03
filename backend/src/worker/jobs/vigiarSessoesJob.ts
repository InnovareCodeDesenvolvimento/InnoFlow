import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { vigiarSessoes } from '../../services/sessao/vigiarSessoes'
import { createQueue, VIGIAR_SESSOES_QUEUE_NAME, type VigiarSessoesJobData } from '../queues'

/**
 * Processa cada disparo do agendador do watchdog de sessões (F5.9). `vigiarSessoes` já isola cada sessão num try/catch; o que escapa
 * daqui (falha ao consultar o banco) só faz o BullMQ marcar a rodada como falha — o worker e o agendador seguem de pé.
 */
export function startVigiarSessoesWorker(): Worker<VigiarSessoesJobData> {
  const worker = new Worker<VigiarSessoesJobData>(
    VIGIAR_SESSOES_QUEUE_NAME,
    async (_job: Job<VigiarSessoesJobData>) => {
      await vigiarSessoes()
    },
    { connection: createRedisConnection(), concurrency: 1 }, // 1: nunca dois ciclos do mesmo lote em paralelo neste worker
  )

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, '[worker][vigiar-sessoes] rodada falhou')
  })

  logger.info('[worker][vigiar-sessoes] worker ativo')
  return worker
}

/** Job REPEATABLE via `upsertJobScheduler` — mesmo padrão de `scheduleVarrerPreAutorizacoesCartaoScan`. */
export async function scheduleVigiarSessoesScan(): Promise<void> {
  const queue = createQueue(VIGIAR_SESSOES_QUEUE_NAME)
  try {
    await queue.upsertJobScheduler('vigiar-sessoes-scan', { every: env.SESSION_WATCHDOG_INTERVAL_MS }, { name: 'scan', data: {} })
    logger.info({ intervalMs: env.SESSION_WATCHDOG_INTERVAL_MS }, '[worker][vigiar-sessoes] varredura agendada')
  } finally {
    await queue.close()
  }
}
