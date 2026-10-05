import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { ErroDeBackup } from '../../core/backup/erros'
import {
  INTERVALO_ALERTA_ATRASO_MS,
  PEDIDO_ENFILEIRADO_EXPIRA_EM_MS,
  RETENCAO_DO_HISTORICO_DIAS,
  TRAVA_EXPIRA_EM_MS,
  CONFERENCIA_EXPIRA_EM_MS,
  backupAgendadoDevido,
  conferenciaDevida,
  destinoAtivo,
  inicioDoHorarioMarcado,
  situacaoDeAtraso,
} from '../../core/backup/politica'
import { carregarConfigDeBackup } from './configBackup'
import { executarBackup, paraCodigo, type DepsDoBackup } from './executarBackup'
import { verificarUltimaCopia, type DepsDaConferencia } from './verificarBackup'

/**
 * Uma passada do agendador: roda o backup se for a hora marcada (Brasília) e ainda não houve tentativa devida, confere a cópia mais recente 1x por semana, fecha o que ficou
 * pendurado e avisa se o backup está atrasado. Chamada de 10 em 10 minutos pelo job BullMQ do worker (`worker/jobs/backupJob.ts`, `upsertJobScheduler`).
 *
 * SEGURO COM 2 RÉPLICAS DO WORKER: o `upsertJobScheduler` mantém UM agendamento (o BullMQ entrega cada disparo a um worker só) e, mesmo que dois ticks coincidam, a trava
 * `runningSince` (UPDATE condicional no banco) deixa só um dump rodar; o alerta de atraso é reservado por UPDATE condicional (`lastStaleAlertAt`). NUNCA lança.
 *
 * A FRAQUEZA DESTE DESENHO, DITA EM VOZ ALTA: o agendador roda dentro do próprio worker. Se ele estiver fora do ar, nenhum dump acontece, justamente quando se vai querer um.
 * Não há como consertar isso de dentro; o que dá é não deixar passar em branco: o alerta `backup_stale` avisa quando nenhuma cópia entrou dentro do limite (mas ele também depende
 * do worker — quem monitora o worker de fora, como o EasyPanel, é a segunda linha de defesa).
 */

export interface ResumoDoTick {
  fechadas: number
  executou: boolean
  ok: boolean | null
  atrasado: boolean
  conferiu: boolean | null
  historicoApagado: number
}

/** Fecha como FALHA o que ficou pendurado: execução RUNNING além da trava (o processo morreu no meio do dump), conferência RUNNING velha, pedido QUEUED que o worker nunca pegou. */
export async function fecharExecucoesAbandonadas(agora: Date): Promise<number> {
  const limiteBackup = new Date(agora.getTime() - TRAVA_EXPIRA_EM_MS)
  const limiteConferencia = new Date(agora.getTime() - CONFERENCIA_EXPIRA_EM_MS)
  const limiteFila = new Date(agora.getTime() - PEDIDO_ENFILEIRADO_EXPIRA_EM_MS)
  const candidatas = await prisma.backupRun.findMany({
    where: {
      OR: [
        { status: 'RUNNING', trigger: { not: 'VERIFY' }, startedAt: { lt: limiteBackup } },
        { status: 'RUNNING', trigger: 'VERIFY', startedAt: { lt: limiteConferencia } },
        { status: 'QUEUED', createdAt: { lt: limiteFila } },
      ],
    },
    select: { id: true, trigger: true, status: true, destination: true },
    take: 100,
  })
  let fechadas = 0
  for (const c of candidatas) {
    const codigo = c.status === 'QUEUED' ? 'NOT_PICKED_UP' : 'INTERRUPTED'
    const r = await prisma.backupRun.updateMany({ where: { id: c.id, status: c.status }, data: { status: 'FAILED', finishedAt: agora, errorCode: codigo } })
    if (r.count !== 1) continue
    fechadas += 1
    logger.error({ runId: c.id, codigo, gatilho: c.trigger }, '[backup] execução abandonada fechada como falha')
    if (c.trigger === 'SCHEDULED') {
      logger.error({ alert: 'backup_failed', motivo: codigo, operacao: 'SCHEDULED', escopo: c.destination ?? 'nenhum' }, '[backup] o backup agendado do banco FALHOU — o banco está sem cópia nova')
    }
  }
  return fechadas
}

/**
 * Confere se o backup está atrasado e, se estiver, emite o alerta `backup_stale` (IMPORTANTE) — no máximo 1 a cada 12 h (`lastStaleAlertAt`, reserva atômica no banco: dois
 * disparos simultâneos nunca emitem dois). Sem e-mail/WhatsApp configurados o alerta vira só log (o notificador decide).
 */
export async function verificarAtrasoDoBackup(agora: Date): Promise<{ atrasado: boolean; alertou: boolean }> {
  const config = await carregarConfigDeBackup()
  const atraso = situacaoDeAtraso(config, agora)
  if (!atraso.atrasado) return { atrasado: false, alertou: false }
  const corte = new Date(agora.getTime() - INTERVALO_ALERTA_ATRASO_MS)
  const reservado = await prisma.backupConfig.updateMany({ where: { id: 1, OR: [{ lastStaleAlertAt: null }, { lastStaleAlertAt: { lt: corte } }] }, data: { lastStaleAlertAt: agora } })
  if (reservado.count !== 1) return { atrasado: true, alertou: false }
  logger.error(
    {
      alert: 'backup_stale',
      desfecho: atraso.nuncaRodou ? 'never_ran' : 'stale',
      ageMinutes: atraso.idadeEmHoras === null ? undefined : atraso.idadeEmHoras * 60,
      limite: config.alertAfterHours,
    },
    '[backup] o backup automático está ATRASADO — nenhuma cópia entrou dentro do limite',
  )
  return { atrasado: true, alertou: true }
}

export async function executarTickDoBackup(agora: Date = new Date(), deps: DepsDoBackup & DepsDaConferencia = {}): Promise<ResumoDoTick> {
  const resumo: ResumoDoTick = { fechadas: 0, executou: false, ok: null, atrasado: false, conferiu: null, historicoApagado: 0 }
  try {
    resumo.fechadas = await fecharExecucoesAbandonadas(agora)
    const config = await carregarConfigDeBackup()

    const horario = inicioDoHorarioMarcado(config.hourLocal, agora)
    const [ultimoSucesso, desdeOHorario] = await Promise.all([
      prisma.backupRun.findFirst({ where: { trigger: 'SCHEDULED', status: 'SUCCESS' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.backupRun.findMany({ where: { trigger: 'SCHEDULED', createdAt: { gte: horario } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, status: true }, take: 20 }),
    ])
    const devido = backupAgendadoDevido(config, agora, {
      ultimoSucessoAgendadoEm: ultimoSucesso?.createdAt ?? null,
      tentativasDesdeOHorario: desdeOHorario.length,
      ultimaTentativaDesdeOHorario: desdeOHorario[0] ? { em: desdeOHorario[0].createdAt, falhou: desdeOHorario[0].status === 'FAILED' } : null,
    })
    if (devido) {
      resumo.executou = true
      try {
        await executarBackup({ gatilho: 'SCHEDULED' }, { ...deps, agora: deps.agora ?? (() => agora) })
        resumo.ok = true
      } catch (err) {
        // `executarBackup` já gravou o histórico e emitiu o alerta; aqui só impedimos a exceção de matar o job.
        resumo.ok = false
        logger.error({ codigo: paraCodigo(err) }, '[backup] tick: o backup agendado falhou')
      }
    }

    resumo.atrasado = (await verificarAtrasoDoBackup(agora)).atrasado

    // Conferência semanal da cópia mais recente: só com o automático ligado, destino completo, chave e pelo menos uma cópia já enviada, e nunca na mesma passada do backup.
    if (!resumo.executou && config.enabled && config.lastSuccessAt && config.encryptionKeyCiphertext && destinoAtivo(config)) {
      const ultima = await prisma.backupRun.findFirst({ where: { trigger: 'VERIFY' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
      if (conferenciaDevida(ultima?.createdAt ?? null, agora)) {
        try {
          await verificarUltimaCopia({ gatilho: 'SCHEDULED' }, { exec: deps.exec, agora: deps.agora ?? (() => agora), destino: deps.destino, pastaTemporariaBase: deps.pastaTemporariaBase })
          resumo.conferiu = true
        } catch (err) {
          resumo.conferiu = false
          logger.error({ codigo: paraCodigo(err) }, '[backup] tick: a conferência semanal reprovou')
        }
      }
    }

    // O histórico existe para investigar, não para guardar para sempre.
    const corte = new Date(agora.getTime() - RETENCAO_DO_HISTORICO_DIAS * 24 * 60 * 60 * 1000)
    resumo.historicoApagado = (await prisma.backupRun.deleteMany({ where: { createdAt: { lt: corte }, status: { in: ['SUCCESS', 'FAILED'] } } })).count
  } catch (err) {
    logger.error({ err: err instanceof ErroDeBackup ? { codigo: err.codigo } : err }, '[backup] tick: erro inesperado (o próximo tick tenta de novo)')
  }
  return resumo
}
