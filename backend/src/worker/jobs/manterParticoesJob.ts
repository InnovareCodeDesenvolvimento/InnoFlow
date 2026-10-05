import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { prisma } from '../../lib/prisma'
import { executarManutencaoParticoes } from '../../services/manutencao/manutencaoParticoes'
import { createQueue, MANTER_PARTICOES_QUEUE_NAME, type ManterParticoesJobData } from '../queues'

/**
 * Manutenção de partições + retenção (N-11). Job REPEATABLE (`upsertJobScheduler`, mesmo padrão de `vigiarSessoesJob.ts`), sem dado
 * próprio. `concurrency: 1` e lock consultivo no banco: duas réplicas do worker nunca criam/purgam ao mesmo tempo.
 */
export function startManterParticoesWorker(): Worker<ManterParticoesJobData> {
  const worker = new Worker<ManterParticoesJobData>(
    MANTER_PARTICOES_QUEUE_NAME,
    async (_job: Job<ManterParticoesJobData>) => {
      await executarManutencaoParticoes(prisma)
    },
    { connection: createRedisConnection(), concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, '[worker][manter-particoes] rodada falhou')
  })

  logger.info('[worker][manter-particoes] worker ativo')
  return worker
}

export async function scheduleManterParticoes(): Promise<void> {
  const queue = createQueue(MANTER_PARTICOES_QUEUE_NAME)
  try {
    await queue.upsertJobScheduler('manter-particoes-scan', { every: env.PARTITION_MAINTENANCE_INTERVAL_MS }, { name: 'scan', data: {} })
    logger.info({ intervalMs: env.PARTITION_MAINTENANCE_INTERVAL_MS, mesesAFrente: env.PARTITION_AHEAD_MONTHS, retentionEnabled: env.RETENTION_ENABLED, retentionDryRun: env.RETENTION_DRY_RUN }, '[worker][manter-particoes] manutenção agendada')
  } finally {
    await queue.close()
  }
}

/** Rodada imediata no boot do worker (não espera o 1º intervalo): é o que garante partições logo depois de um deploy/restart. */
export async function manterParticoesNoBoot(): Promise<void> {
  try {
    await executarManutencaoParticoes(prisma)
  } catch (err) {
    logger.error({ err, alert: 'partition_maintenance_boot_failed' }, '[worker][manter-particoes] rodada do boot falhou — o agendador segue de pé')
  }
}
