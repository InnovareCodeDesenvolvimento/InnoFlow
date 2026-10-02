import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { varrerPreAutorizacoesCartao } from '../../services/pagamentos/varrerPreAutorizacoesCartao'
import { getPagamentoPort, isPagamentoDisponivel } from '../../services/pagamentos/pagamentoPortInstance'
import { createQueue, VARRER_PREAUTORIZACOES_CARTAO_QUEUE_NAME, type VarrerPreAutorizacoesCartaoJobData } from '../queues'

/** Processa cada disparo do agendador (ver `scheduleVarrerPreAutorizacoesCartaoScan`). */
export function startVarrerPreAutorizacoesCartaoWorker(): Worker<VarrerPreAutorizacoesCartaoJobData> {
  const worker = new Worker<VarrerPreAutorizacoesCartaoJobData>(
    VARRER_PREAUTORIZACOES_CARTAO_QUEUE_NAME,
    async (_job: Job<VarrerPreAutorizacoesCartaoJobData>) => {
      // Produção sem credencial Cielo (gateway bloqueado): nada para varrer, pula em silêncio em vez de falhar a cada rodada.
      if (!(await isPagamentoDisponivel())) return
      await varrerPreAutorizacoesCartao(await getPagamentoPort())
    },
    { connection: createRedisConnection(), concurrency: 1 }, // 1: nunca duas varreduras do mesmo lote em paralelo
  )

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, '[worker][varrer-preautorizacoes-cartao] rodada falhou')
  })

  logger.info('[worker][varrer-preautorizacoes-cartao] worker ativo')
  return worker
}

/** Job REPEATABLE via `upsertJobScheduler` — mesmo padrão de `scheduleExpirarTopupsPixScan`. */
export async function scheduleVarrerPreAutorizacoesCartaoScan(): Promise<void> {
  const queue = createQueue(VARRER_PREAUTORIZACOES_CARTAO_QUEUE_NAME)
  try {
    await queue.upsertJobScheduler('varrer-preautorizacoes-cartao-scan', { every: env.CARD_PREAUTH_SCAN_INTERVAL_MS }, { name: 'scan', data: {} })
    logger.info({ intervalMs: env.CARD_PREAUTH_SCAN_INTERVAL_MS }, '[worker][varrer-preautorizacoes-cartao] varredura agendada')
  } finally {
    await queue.close()
  }
}
