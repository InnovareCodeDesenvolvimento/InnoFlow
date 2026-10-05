import { Queue, Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { ErroDeBackup } from '../../core/backup/erros'
import { executarBackup, paraCodigo } from '../../services/backup/executarBackup'
import { verificarUltimaCopia } from '../../services/backup/verificarBackup'
import { executarTickDoBackup } from '../../services/backup/agendador'
import type { PedidoNaFila } from '../../services/backup/tiposDePedido'

/**
 * Backup automático no worker (porte do InnoChat). UMA fila (`backup`) com 3 tipos de job:
 *  - `tick`: job REPEATABLE (`upsertJobScheduler`, idempotente entre réplicas: o agendamento é UM só, no Redis) a cada 10 min — roda o backup se for a hora, confere a cópia 1x
 *    por semana, fecha o que ficou pendurado e avisa se está atrasado (`services/backup/agendador.ts`);
 *  - `manual-run` / `manual-verify`: pedidos da tela Admin > Backup (a API cria a linha `QUEUED` e enfileira aqui; a API não tem `pg_dump`).
 * Concorrência 1 por processo e a trava `runningSince` no banco entre processos: seguro rodar em 2 réplicas. NENHUM job é retentado pelo BullMQ (`attempts: 1`): a retentativa de
 * um backup que falhou é do agendador (próximo tick, com espera e teto), e o resultado de cada tentativa fica em `BackupRun`. Nome da fila local (não mexe em `queues.ts`).
 */
export const BACKUP_QUEUE_NAME = 'backup'
export const INTERVALO_DO_TICK_MS = 10 * 60 * 1000

export type BackupJobData = { tipo: 'tick' } | PedidoNaFila

export async function processarJobDeBackup(job: Pick<Job<BackupJobData>, 'data' | 'id'>): Promise<void> {
  const d = job.data
  switch (d.tipo) {
    case 'tick':
      await executarTickDoBackup()
      return
    case 'manual-run':
      try {
        await executarBackup({ gatilho: 'MANUAL', runId: d.runId, criadoPorId: d.criadoPorId })
      } catch (err) {
        // Já gravado em BackupRun (e logado); o BullMQ não precisa marcar o job como falho (nem retentar).
        logger.info({ runId: d.runId, codigo: paraCodigo(err) }, '[worker][backup] pedido manual terminou com falha (ver o histórico)')
      }
      return
    case 'manual-verify':
      try {
        await verificarUltimaCopia({ gatilho: 'MANUAL', runId: d.runId, criadoPorId: d.criadoPorId })
      } catch (err) {
        logger.info({ runId: d.runId, codigo: err instanceof ErroDeBackup ? err.codigo : paraCodigo(err) }, '[worker][backup] conferência manual reprovou (ver o histórico)')
      }
      return
  }
}

export function startBackupWorker(): Worker<BackupJobData> {
  const worker = new Worker<BackupJobData>(BACKUP_QUEUE_NAME, async (job) => processarJobDeBackup(job), {
    connection: createRedisConnection(),
    concurrency: 1,
    // Um dump pode levar dezenas de minutos: o BullMQ renova o lock do job sozinho enquanto o processo está vivo; o prazo largo só evita falso "stalled" em evento de CPU pesado.
    lockDuration: 5 * 60 * 1000,
  })
  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, '[worker][backup] job falhou')
  })
  logger.info('[worker][backup] worker ativo')
  return worker
}

export async function scheduleBackupTick(): Promise<void> {
  const queue = new Queue(BACKUP_QUEUE_NAME, { connection: createRedisConnection() })
  try {
    await queue.upsertJobScheduler('backup-tick', { every: INTERVALO_DO_TICK_MS }, { name: 'tick', data: { tipo: 'tick' }, opts: { attempts: 1, removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } } })
    logger.info({ intervalMs: INTERVALO_DO_TICK_MS }, '[worker][backup] tick agendado')
  } finally {
    await queue.close()
  }
}

let filaDaApi: Queue<BackupJobData> | null = null

/** Chamado pela API (importação preguiçosa em `pedidosDeBackup.ts`): UMA fila por processo da API. `jobId` por pedido — nunca reaproveitado. */
export async function enfileirarPedidoDeBackup(pedido: PedidoNaFila): Promise<void> {
  filaDaApi ??= new Queue<BackupJobData>(BACKUP_QUEUE_NAME, { connection: createRedisConnection() })
  await filaDaApi.add(pedido.tipo, pedido, { jobId: `backup-${pedido.tipo}-${pedido.runId}`, attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } })
}

/** Só para teste/encerramento ordenado. */
export async function fecharFilaDaApiDeBackup(): Promise<void> {
  if (filaDaApi) await filaDaApi.close()
  filaDaApi = null
}
