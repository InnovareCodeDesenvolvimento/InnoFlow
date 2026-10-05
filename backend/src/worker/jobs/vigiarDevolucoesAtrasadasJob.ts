import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { createQueue } from '../queues'
import { vigiarDevolucoesAtrasadas } from '../../services/lgpd/devolucaoDeSaldo'

/**
 * Vigia diária das devoluções de saldo de conta excluída (L1.4, DL2): pedido `PENDING_REFUND` há mais de 30 dias vira o alerta `payment_refund_pending_overdue` (IMPORTANTE:
 * e-mail ao dono). Job REPEATABLE sem dado próprio (`upsertJobScheduler`, idempotente entre réplicas), 1x a cada 24 h — o alerta é por contagem e o notificador faz o dedupe; nada
 * a varrer com pressa. Nome da fila local (não mexe em `queues.ts`).
 */
export const VIGIAR_DEVOLUCOES_ATRASADAS_QUEUE_NAME = 'vigiar-devolucoes-atrasadas'
const INTERVALO_MS = 24 * 60 * 60 * 1000

export function startVigiarDevolucoesAtrasadasWorker(): Worker<Record<string, never>> {
  const worker = new Worker<Record<string, never>>(
    VIGIAR_DEVOLUCOES_ATRASADAS_QUEUE_NAME,
    async (_job: Job<Record<string, never>>) => {
      await vigiarDevolucoesAtrasadas()
    },
    { connection: createRedisConnection(), concurrency: 1 },
  )
  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, '[worker][vigiar-devolucoes-atrasadas] rodada falhou')
  })
  logger.info('[worker][vigiar-devolucoes-atrasadas] worker ativo')
  return worker
}

export async function scheduleVigiarDevolucoesAtrasadas(): Promise<void> {
  const queue = createQueue(VIGIAR_DEVOLUCOES_ATRASADAS_QUEUE_NAME)
  try {
    await queue.upsertJobScheduler('vigiar-devolucoes-atrasadas-scan', { every: INTERVALO_MS }, { name: 'scan', data: {} })
    logger.info({ intervalMs: INTERVALO_MS }, '[worker][vigiar-devolucoes-atrasadas] vigia agendada')
  } finally {
    await queue.close()
  }
}
