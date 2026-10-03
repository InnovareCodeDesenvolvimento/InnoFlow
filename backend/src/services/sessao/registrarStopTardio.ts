import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { calcularFechamentoSessao } from '../carteira/finalizarSessao'
import { alertarSessao } from './alertasSessao'
import { travarSessao } from './travarSessao'

/**
 * StopTransaction que chega com a sessão JÁ `STOPPED` (F5.9): o carregador enfileirou o Stop offline e só o mandou depois de o servidor
 * ter encerrado a sessão com a melhor prova que tinha. STOPPED é terminal — isto só REGISTRA o que o carregador diz:
 * `lateStopMeterWh`, `lateStopAt` (relógio do carregador), `lateStopReceivedAt` (servidor) e `unbilledCostCents` (informativo).
 *
 * NÃO mexe em `totalCostCents`, `meterStopWh`, nem em carteira/cartão: a identidade de conciliação continua fechando sem mudar a
 * fórmula, e cobrar a diferença é decisão do dono (D3: registra, alerta, absorve). O carregador SEMPRE recebe `Accepted` (quem chama
 * responde assim mesmo se isto falhar).
 *
 * Só se aplica a sessão fechada PELO SERVIDOR. Um Stop repetido sobre sessão que o próprio carregador fechou (retransmissão com
 * `messageId` novo) é só duplicata: `NAO_E_TARDIO`, nada é gravado. Idempotente: o 1º registro vence; repetição -> `JA_REGISTRADO`.
 */
export interface RegistrarStopTardioParams {
  sessionId: string
  /** `meterStop` do payload (Wh). */
  meterStopWh: number
  /** `timestamp` do payload (relógio do carregador). */
  timestamp: Date
}

export type RegistrarStopTardioResultado =
  | { registrado: true; unbilledCostCents: number }
  | { registrado: false; motivo: 'NAO_ENCERRADA' | 'NAO_E_TARDIO' | 'JA_REGISTRADO' }

export async function registrarStopTardio(params: RegistrarStopTardioParams): Promise<RegistrarStopTardioResultado> {
  const { sessionId } = params

  const resultado = await prisma.$transaction(async (tx) => {
    const travada = await travarSessao(tx, sessionId)
    if (travada.status !== 'STOPPED') return { tipo: 'NAO_ENCERRADA' as const }

    const sessao = await tx.chargingSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { id: true, meterStartWh: true, startedAt: true, chargingEndedAt: true, tariffSnapshot: true, site: { select: { timezone: true } }, closureSource: true, totalCostCents: true, meterStopWh: true, lateStopReceivedAt: true },
    })
    if (sessao.closureSource !== 'SERVER') return { tipo: 'NAO_E_TARDIO' as const }
    if (sessao.lateStopReceivedAt) return { tipo: 'JA_REGISTRADO' as const }

    // Quanto o Stop do carregador teria custado pela MESMA fórmula do fechamento real (cálculo puro, nenhum efeito).
    const hipotetico = calcularFechamentoSessao(sessao, { meterStopWh: params.meterStopWh, timestamp: params.timestamp, stopReason: 'OTHER' })
    const cobrado = sessao.totalCostCents ?? 0
    const unbilledCostCents = Math.max(0, hipotetico.custos.totalCostCents - cobrado)

    await tx.chargingSession.update({
      where: { id: sessionId },
      data: { lateStopMeterWh: params.meterStopWh, lateStopAt: params.timestamp, lateStopReceivedAt: new Date(), unbilledCostCents },
    })
    return { tipo: 'REGISTRADO' as const, unbilledCostCents, chargePointId: travada.chargePointId, meterStopWh: sessao.meterStopWh, cobrado }
  })

  if (resultado.tipo !== 'REGISTRADO') return { registrado: false, motivo: resultado.tipo }

  alertarSessao(
    'session_late_stop_transaction',
    { sessionId, chargePointId: resultado.chargePointId, lateStopMeterWh: params.meterStopWh, billedMeterStopWh: resultado.meterStopWh, billedCostCents: resultado.cobrado, unbilledCostCents: resultado.unbilledCostCents },
    resultado.unbilledCostCents > 0 ? 'StopTransaction TARDIO com consumo maior que o cobrado — registrado, NÃO cobrado (D3: absorve)' : 'StopTransaction tardio confere com o que foi cobrado — registrado',
    { diferencaCents: resultado.unbilledCostCents },
  )
  logger.info({ sessionId }, '[sessao] stop tardio registrado')
  return { registrado: true, unbilledCostCents: resultado.unbilledCostCents }
}
