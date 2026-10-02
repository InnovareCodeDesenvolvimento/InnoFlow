import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { varrerTopupsPixExpirados } from '../../services/pagamentos/varrerTopupsPixExpirados'
import { getPagamentoPort, isPagamentoDisponivel } from '../../services/pagamentos/pagamentoPortInstance'
import { createQueue, EXPIRAR_TOPUPS_PIX_QUEUE_NAME, type ExpirarTopupsPixJobData } from '../queues'

/** Processa cada disparo do agendador (ver `scheduleExpirarTopupsPixScan`). */
export function startExpirarTopupsPixWorker(): Worker<ExpirarTopupsPixJobData> {
  const worker = new Worker<ExpirarTopupsPixJobData>(
    EXPIRAR_TOPUPS_PIX_QUEUE_NAME,
    async (_job: Job<ExpirarTopupsPixJobData>) => {
      // Produção sem credencial Cielo (gateway bloqueado): nada para varrer, pula em silêncio em vez de falhar a cada rodada.
      if (!isPagamentoDisponivel()) return
      await varrerTopupsPixExpirados(getPagamentoPort())
    },
    { connection: createRedisConnection(), concurrency: 1 }, // 1: nunca duas varreduras do mesmo lote em paralelo
  )

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, '[worker][expirar-topups-pix] rodada falhou')
  })

  logger.info('[worker][expirar-topups-pix] worker ativo')
  return worker
}

/**
 * Agenda o job REPEATABLE (BullMQ `upsertJobScheduler` — API atual da lib,
 * substitui a antiga opção `repeat` em `queue.add()`). `upsertJobScheduler`
 * é idempotente pelo `jobSchedulerId`: chamar de novo no boot de uma réplica
 * nova só atualiza o agendamento existente, nunca duplica o cron.
 */
export async function scheduleExpirarTopupsPixScan(): Promise<void> {
  const queue = createQueue(EXPIRAR_TOPUPS_PIX_QUEUE_NAME)
  try {
    await queue.upsertJobScheduler('expirar-topups-pix-scan', { every: env.TOPUP_PIX_EXPIRY_SCAN_INTERVAL_MS }, { name: 'scan', data: {} })
    logger.info({ intervalMs: env.TOPUP_PIX_EXPIRY_SCAN_INTERVAL_MS }, '[worker][expirar-topups-pix] varredura agendada')
  } finally {
    await queue.close()
  }
}
