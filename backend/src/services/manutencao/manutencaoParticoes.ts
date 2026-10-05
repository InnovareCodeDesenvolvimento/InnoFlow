import type { PrismaClient } from '@prisma/client'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { garantirParticoesFuturas, type RelatorioParticoes } from './particoes'
import { aplicarRetencao, type ConfigRetencao, type RelatorioRetencao } from './retencao'

export interface ConfigManutencao {
  mesesAFrente: number
  retencao: ConfigRetencao
}

export function configManutencaoDoEnv(): ConfigManutencao {
  return {
    mesesAFrente: env.PARTITION_AHEAD_MONTHS,
    retencao: {
      habilitada: env.RETENTION_ENABLED,
      dryRun: env.RETENTION_DRY_RUN,
      ocppMessageDias: env.RETENTION_OCPP_MESSAGE_DAYS,
      meterSampleDias: env.RETENTION_METER_SAMPLE_DAYS,
      webhookEventDias: env.RETENTION_WEBHOOK_EVENT_DAYS,
      notificationLogDias: env.RETENTION_NOTIFICATION_LOG_DAYS,
    },
  }
}

export interface RelatorioManutencao {
  particoes: RelatorioParticoes[]
  retencao: RelatorioRetencao
}

/**
 * Uma rodada completa: 1) garante as partições futuras (e alerta), 2) aplica a retenção (se ligada). A ORDEM importa: criar antes de
 * purgar garante que uma retenção mal configurada nunca deixa o banco sem partição para o mês corrente. Falha numa etapa não impede
 * a outra; erros viram `throw` no FIM (o BullMQ marca a rodada como falha e o log já tem o detalhe).
 */
export async function executarManutencaoParticoes(db: PrismaClient, cfg: ConfigManutencao = configManutencaoDoEnv(), agora: Date = new Date()): Promise<RelatorioManutencao> {
  const particoes = await garantirParticoesFuturas(db, { mesesAFrente: cfg.mesesAFrente, agora })
  const retencao = await aplicarRetencao(db, cfg.retencao, agora)

  const erros = [...particoes.filter((p) => p.erro).map((p) => `${p.tabela}: ${p.erro}`), ...retencao.erros]
  logger.info({ event: 'partition_maintenance_done', criadas: particoes.reduce((n, p) => n + p.criadas.length, 0), acoesRetencao: retencao.acoes.length, erros: erros.length }, '[manutencao] rodada concluída')
  if (erros.length > 0) throw new Error(`manutenção de partições terminou com erro(s): ${erros.join(' | ')}`)
  return { particoes, retencao }
}
