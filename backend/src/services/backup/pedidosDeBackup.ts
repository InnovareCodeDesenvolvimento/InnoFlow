import type { BackupRun, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { AppError } from '../../api/middleware/errorHandler'
import { mensagemDoErro } from '../../core/backup/erros'
import { CONFERENCIA_EXPIRA_EM_MS, PEDIDO_ENFILEIRADO_EXPIRA_EM_MS, TRAVA_EXPIRA_EM_MS, destinoAtivo, type DestinoDeBackup } from '../../core/backup/politica'
import { carregarConfigDeBackup } from './configBackup'
import type { PedidoNaFila, TipoDePedido } from './tiposDePedido'

export type { PedidoNaFila, TipoDePedido } from './tiposDePedido'

/**
 * Lado da API dos pedidos MANUAIS ("fazer backup agora", "conferir backup"): a API não tem `pg_dump` (a imagem do worker tem) — ela só cria a linha `QUEUED` em `BackupRun` e
 * enfileira o job; o worker a pega, vira `RUNNING` e termina. A tela acompanha por `GET /status` e `GET /runs`. Se ninguém pegar em 15 min, o agendador fecha como `NOT_PICKED_UP`.
 *
 * ANTI-DUPLICIDADE: a checagem "já tem um em andamento?" e a criação da linha andam sob `pg_advisory_xact_lock`, então dois cliques/duas pessoas ao mesmo tempo não criam dois pedidos
 * (e, se criassem, a trava `runningSince` do worker deixaria só um rodar).
 */

export type Enfileirador = (pedido: PedidoNaFila) => Promise<void>

let enfileiradorInjetado: Enfileirador | null = null
/** Só teste: troca o enfileirador (sem Redis/worker). `null` volta ao real. */
export function definirEnfileiradorParaTeste(fn: Enfileirador | null): void {
  enfileiradorInjetado = fn
}

async function enfileirar(pedido: PedidoNaFila): Promise<void> {
  if (enfileiradorInjetado) return enfileiradorInjetado(pedido)
  // Importação preguiçosa: a API só carrega o BullMQ quando alguém pede um backup.
  const { enfileirarPedidoDeBackup } = await import('../../worker/jobs/backupJob')
  return enfileirarPedidoDeBackup(pedido)
}

export interface BackupRunDto {
  id: string
  trigger: 'SCHEDULED' | 'MANUAL' | 'VERIFY'
  status: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED'
  destination: DestinoDeBackup | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  fileName: string | null
  objectKey: string | null
  sizeBytes: number | null
  checksumSha256: string | null
  tablesWithData: number | null
  /** Impressão digital da chave que cifrou a cópia (nulo = não cifrada / execução de teste). */
  keyFingerprint: string | null
  /** CÓDIGO do erro (KEY, DUMP, NETWORK...). Nunca texto livre. */
  errorCode: string | null
  /** Texto fixo para uma pessoa ler a partir do código (nunca o stderr do pg_dump). */
  errorMessage: string | null
}

export function toBackupRunDto(r: BackupRun): BackupRunDto {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    destination: r.destination,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.durationMs,
    fileName: r.fileName,
    objectKey: r.objectKey,
    sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
    checksumSha256: r.checksumSha256,
    tablesWithData: r.tablesWithData,
    keyFingerprint: r.encryptionKeyFingerprint,
    errorCode: r.errorCode,
    errorMessage: mensagemDoErro(r.errorCode),
  }
}

export async function listarExecucoes(params: { page: number; pageSize: number; trigger?: BackupRun['trigger']; status?: BackupRun['status'] }): Promise<{ items: BackupRunDto[]; total: number }> {
  const where: Prisma.BackupRunWhereInput = { ...(params.trigger ? { trigger: params.trigger } : {}), ...(params.status ? { status: params.status } : {}) }
  const [total, linhas] = await Promise.all([
    prisma.backupRun.count({ where }),
    prisma.backupRun.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
  ])
  return { items: linhas.map(toBackupRunDto), total }
}

export async function buscarExecucao(id: string): Promise<BackupRunDto | null> {
  const r = await prisma.backupRun.findUnique({ where: { id } })
  return r ? toBackupRunDto(r) : null
}

/** Pedido manual de backup. 409 `BACKUP_BUSY` (já há um), 409 `BACKUP_DESTINATION_MISSING` (destino escolhido mas incompleto), 503 `QUEUE_UNAVAILABLE` (Redis/BullMQ fora). */
export async function solicitarBackupManual(params: { adminId: string; agora?: Date }): Promise<BackupRunDto> {
  const agora = params.agora ?? new Date()
  const run = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('backup-pedido'))`
    const config = await carregarConfigDeBackup(tx)
    const travaViva = config.runningSince !== null && agora.getTime() - config.runningSince.getTime() < TRAVA_EXPIRA_EM_MS
    const emAndamento = await tx.backupRun.findFirst({
      where: {
        trigger: { not: 'VERIFY' },
        OR: [{ status: 'RUNNING', startedAt: { gt: new Date(agora.getTime() - TRAVA_EXPIRA_EM_MS) } }, { status: 'QUEUED', createdAt: { gt: new Date(agora.getTime() - PEDIDO_ENFILEIRADO_EXPIRA_EM_MS) } }],
      },
      select: { id: true },
    })
    if (travaViva || emAndamento) throw new AppError('Já existe um backup em andamento. Espere terminar.', 409, 'BACKUP_BUSY')
    const ativo = destinoAtivo(config)
    // Destino ESCOLHIDO mas incompleto: um "backup" que descarta o dump em silêncio seria falsa segurança. Sem nenhum destino escolhido vale como TESTE do pg_dump.
    if (config.destination !== null && ativo === null) {
      throw new AppError('O destino do backup está incompleto. Complete os dados (ou conecte a conta Google) e use Testar destino antes de fazer backup.', 409, 'BACKUP_DESTINATION_MISSING')
    }
    return tx.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', destination: ativo, createdById: params.adminId } })
  })
  await enfileirarOuFalhar(run.id, 'manual-run', params.adminId)
  return toBackupRunDto(run)
}

/** Pedido manual de conferência da cópia mais recente. */
export async function solicitarConferenciaManual(params: { adminId: string; agora?: Date }): Promise<BackupRunDto> {
  const agora = params.agora ?? new Date()
  const run = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('backup-pedido'))`
    const config = await carregarConfigDeBackup(tx)
    const ativo = destinoAtivo(config)
    if (ativo === null) throw new AppError('Escolha e complete o destino antes de conferir: é lá que a cópia está.', 409, 'BACKUP_DESTINATION_MISSING')
    const emAndamento = await tx.backupRun.findFirst({
      where: {
        trigger: 'VERIFY',
        OR: [{ status: 'RUNNING', startedAt: { gt: new Date(agora.getTime() - CONFERENCIA_EXPIRA_EM_MS) } }, { status: 'QUEUED', createdAt: { gt: new Date(agora.getTime() - PEDIDO_ENFILEIRADO_EXPIRA_EM_MS) } }],
      },
      select: { id: true },
    })
    if (emAndamento) throw new AppError('Já existe uma conferência em andamento. Espere terminar.', 409, 'BACKUP_BUSY')
    return tx.backupRun.create({ data: { trigger: 'VERIFY', status: 'QUEUED', destination: ativo, createdById: params.adminId } })
  })
  await enfileirarOuFalhar(run.id, 'manual-verify', params.adminId)
  return toBackupRunDto(run)
}

async function enfileirarOuFalhar(runId: string, tipo: TipoDePedido, adminId: string): Promise<void> {
  try {
    await enfileirar({ tipo, runId, criadoPorId: adminId })
  } catch (err) {
    logger.error({ err, runId }, '[backup] não consegui enfileirar o pedido (Redis/BullMQ fora do ar?)')
    await prisma.backupRun.updateMany({ where: { id: runId, status: 'QUEUED' }, data: { status: 'FAILED', finishedAt: new Date(), errorCode: 'NOT_PICKED_UP' } })
    throw new AppError('Não foi possível enfileirar o pedido agora (fila indisponível). Tente de novo em instantes.', 503, 'QUEUE_UNAVAILABLE')
  }
}
