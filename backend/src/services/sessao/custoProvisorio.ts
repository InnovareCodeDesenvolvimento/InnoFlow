import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { calcularFechamentoSessao, CustoNaoCalculadoError } from '../carteira/finalizarSessao'

/**
 * M3 (Órion): `provisionalCostCents` congelava na marcação — mas é ele que desconta o saldo comprometido (D7). Uma sessão que continua medindo em
 * STOP_UNCONFIRMED (carregador que desobedece, MeterValues em buffer) tem custo crescente; com o provisório velho o motorista iniciava outra recarga
 * com saldo que a primeira já consumia. Chamado pelo MeterValues quando chega leitura de energia numa sessão STOP_UNCONFIRMED: recalcula com a MESMA conta
 * do fechamento (`calcularFechamentoSessao`, janela normalizada) e grava só se a sessão CONTINUA em confirmação (update condicional).
 * Cálculo que falha NÃO zera: mantém o valor anterior (e o alerta de custo fica por conta de quem fecha).
 */
export interface SessaoParaProvisorio {
  id: string
  meterStartWh: number
  startedAt: Date
  chargingEndedAt: Date | null
  tariffSnapshot: Prisma.JsonValue
  site: { timezone: string }
}

export async function atualizarCustoProvisorio(sessao: SessaoParaProvisorio, energiaWh: number, instante: Date): Promise<number | null> {
  try {
    const { custos } = calcularFechamentoSessao(sessao, { meterStopWh: Math.round(energiaWh), timestamp: instante, stopReason: 'OTHER' })
    const r = await prisma.chargingSession.updateMany({ where: { id: sessao.id, status: 'STOP_UNCONFIRMED' }, data: { provisionalCostCents: custos.totalCostCents } })
    return r.count === 1 ? custos.totalCostCents : null
  } catch (err) {
    if (err instanceof CustoNaoCalculadoError) {
      logger.error({ err, sessionId: sessao.id }, '[sessao] não foi possível recalcular o custo provisório — mantido o valor anterior')
      return null
    }
    throw err
  }
}
