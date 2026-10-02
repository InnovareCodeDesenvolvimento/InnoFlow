import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { varrerPreAutorizacoesCartao } from '../../services/pagamentos/varrerPreAutorizacoesCartao'
import { reenfileirarCapturasPendentes } from '../../services/pagamentos/reenfileirarCapturasPendentes'
import { getPagamentoPort, isPagamentoDisponivel } from '../../services/pagamentos/pagamentoPortInstance'
import { createQueue, VARRER_PREAUTORIZACOES_CARTAO_QUEUE_NAME, type VarrerPreAutorizacoesCartaoJobData } from '../queues'

/** Processa cada disparo do agendador (ver `scheduleVarrerPreAutorizacoesCartaoScan`). */
export function startVarrerPreAutorizacoesCartaoWorker(): Worker<VarrerPreAutorizacoesCartaoJobData> {
  const worker = new Worker<VarrerPreAutorizacoesCartaoJobData>(
    VARRER_PREAUTORIZACOES_CARTAO_QUEUE_NAME,
    async (_job: Job<VarrerPreAutorizacoesCartaoJobData>) => {
      // Produção sem credencial Cielo (gateway bloqueado): nada para varrer, pula em silêncio em vez de falhar a cada rodada.
      const disponivel = await isPagamentoDisponivel()
      let erroDaVarredura: unknown = null
      if (disponivel) {
        try {
          await varrerPreAutorizacoesCartao(await getPagamentoPort())
        } catch (err) {
          erroDaVarredura = err // não pode impedir a rede de segurança da captura (abaixo) de rodar nesta rodada
        }
      }
      // F5.7: a rede de segurança da CAPTURA roda SEMPRE — com o gateway fora ela só alerta (não reenfileira nem gasta o
      // teto), e um intent de dinheiro já entregue parado em CAPTURE_PENDING não pode ficar mudo só porque a config caiu.
      await reenfileirarCapturasPendentes({ gatewayDisponivel: disponivel })
      if (erroDaVarredura) throw erroDaVarredura
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
