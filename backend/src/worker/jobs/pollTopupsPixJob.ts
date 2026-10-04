import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { varrerTopupsPixPendentes } from '../../services/pagamentos/pollTopupsPix'
import { getPagamentoPort, isPagamentoDisponivel } from '../../services/pagamentos/pagamentoPortInstance'
import { createQueue, POLL_TOPUPS_PIX_QUEUE_NAME, type PollTopupsPixJobData } from '../queues'

/**
 * Polling do Pix pendente (conta Cielo compartilhada, sem webhook do InnoFlow). Mesmo molde de `expirarTopupsPixJob`: job repeatable, concorrência 1, gateway indisponível pula em silêncio.
 * O intervalo (`TOPUP_PIX_POLL_INTERVAL_MS`, 15 s) só dispara a rodada; quem decide QUAIS Pix consultar é o backoff por intent dentro de `varrerTopupsPixPendentes`.
 */
export function startPollTopupsPixWorker(): Worker<PollTopupsPixJobData> {
  const worker = new Worker<PollTopupsPixJobData>(
    POLL_TOPUPS_PIX_QUEUE_NAME,
    async (_job: Job<PollTopupsPixJobData>) => {
      if (!(await isPagamentoDisponivel())) return
      await varrerTopupsPixPendentes(await getPagamentoPort())
    },
    { connection: createRedisConnection(), concurrency: 1 },
  )
  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, '[worker][poll-topups-pix] rodada falhou')
  })
  logger.info('[worker][poll-topups-pix] worker ativo')
  return worker
}

export async function schedulePollTopupsPixScan(): Promise<void> {
  const queue = createQueue(POLL_TOPUPS_PIX_QUEUE_NAME)
  try {
    await queue.upsertJobScheduler('poll-topups-pix-scan', { every: env.TOPUP_PIX_POLL_INTERVAL_MS }, { name: 'scan', data: {} })
    logger.info({ intervalMs: env.TOPUP_PIX_POLL_INTERVAL_MS }, '[worker][poll-topups-pix] varredura agendada')
  } finally {
    await queue.close()
  }
}
