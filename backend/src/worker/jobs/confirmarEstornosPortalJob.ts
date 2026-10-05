import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { confirmarEstornosPortal } from '../../services/estornos/confirmarEstornosPortal'
import { createQueue, CONFIRMAR_ESTORNOS_PORTAL_QUEUE_NAME, type ConfirmarEstornosPortalJobData } from '../queues'

/**
 * Processa cada disparo do agendador (ver `scheduleConfirmarEstornosPortal`): reconsulta na Cielo as devoluções registradas pelo ADMIN como feitas no portal (L1.8). Sem credencial
 * Cielo (ou com o adaptador Fake) a rodada é PULADA dentro do serviço — o job fica inerte, não falha.
 */
export function startConfirmarEstornosPortalWorker(): Worker<ConfirmarEstornosPortalJobData> {
  const worker = new Worker<ConfirmarEstornosPortalJobData>(
    CONFIRMAR_ESTORNOS_PORTAL_QUEUE_NAME,
    async (_job: Job<ConfirmarEstornosPortalJobData>) => {
      await confirmarEstornosPortal()
    },
    { connection: createRedisConnection(), concurrency: 1 }, // 1: nunca duas rodadas reconsultando a mesma venda da conta compartilhada
  )

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, '[worker][confirmar-estornos-portal] rodada falhou')
  })

  logger.info('[worker][confirmar-estornos-portal] worker ativo')
  return worker
}

/** Job REPEATABLE via `upsertJobScheduler` — mesmo padrão de `scheduleVarrerPreAutorizacoesCartaoScan`. Baixa frequência (30 min por padrão). */
export async function scheduleConfirmarEstornosPortal(): Promise<void> {
  const queue = createQueue(CONFIRMAR_ESTORNOS_PORTAL_QUEUE_NAME)
  try {
    await queue.upsertJobScheduler('confirmar-estornos-portal-scan', { every: env.REFUND_PORTAL_SCAN_INTERVAL_MS }, { name: 'scan', data: {} })
    logger.info({ intervalMs: env.REFUND_PORTAL_SCAN_INTERVAL_MS }, '[worker][confirmar-estornos-portal] varredura agendada')
  } finally {
    await queue.close()
  }
}
