import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { createQueue } from '../queues'
import { vigiarPrazoChargebacks } from '../../services/estornos/vigiarPrazoChargebacks'

/**
 * Vigia diária do prazo de resposta dos chargebacks em aberto (L1.8): `chargeback_response_deadline_near` (prazo em até 3 dias) e `chargeback_response_deadline_overdue` (vencido), ambos
 * CRITICO. Job REPEATABLE sem dado próprio (`upsertJobScheduler`, idempotente entre réplicas; mesmo padrão de `vigiarDevolucoesAtrasadasJob.ts`), 1x a cada 24 h: a janela diária é o dedupe
 * natural — o aviso não se repete a cada hora. Nome da fila local (não mexe em `queues.ts`).
 */
export const VIGIAR_PRAZO_CHARGEBACKS_QUEUE_NAME = 'vigiar-prazo-chargebacks'
export const VIGIAR_PRAZO_CHARGEBACKS_INTERVALO_MS = 24 * 60 * 60 * 1000

export function startVigiarPrazoChargebacksWorker(): Worker<Record<string, never>> {
  const worker = new Worker<Record<string, never>>(
    VIGIAR_PRAZO_CHARGEBACKS_QUEUE_NAME,
    async (_job: Job<Record<string, never>>) => {
      await vigiarPrazoChargebacks()
    },
    { connection: createRedisConnection(), concurrency: 1 },
  )
  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, '[worker][vigiar-prazo-chargebacks] rodada falhou')
  })
  logger.info('[worker][vigiar-prazo-chargebacks] worker ativo')
  return worker
}

export async function scheduleVigiarPrazoChargebacks(): Promise<void> {
  const queue = createQueue(VIGIAR_PRAZO_CHARGEBACKS_QUEUE_NAME)
  try {
    await queue.upsertJobScheduler('vigiar-prazo-chargebacks-scan', { every: VIGIAR_PRAZO_CHARGEBACKS_INTERVALO_MS }, { name: 'scan', data: {} })
    logger.info({ intervalMs: VIGIAR_PRAZO_CHARGEBACKS_INTERVALO_MS }, '[worker][vigiar-prazo-chargebacks] vigia agendada')
  } finally {
    await queue.close()
  }
}
