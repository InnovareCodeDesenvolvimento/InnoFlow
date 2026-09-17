import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { finalizarSessao } from './finalizarSessao'

/**
 * Fecha uma sessão que o carregador não reconhece mais, usando a última
 * leitura de medidor conhecida — extraído de `bootNotification.ts` (F5,
 * 17/09/2026) para ser reaproveitado também quando um `RemoteStopTransaction`
 * volta `Rejected`. Ambos os gatilhos significam a mesma coisa do ponto de
 * vista do carregador: "não tenho mais essa transação" — seja porque ele
 * reconectou sem completar o `StopTransaction` (boot), seja porque um
 * comando de stop explícito não achou a transação que esperávamos que ele
 * tivesse (rejeição). Sem isto, a sessão fica presa em STARTED/CHARGING/
 * FINISHING pra sempre e o motorista fica travado numa tela de "parando a
 * recarga" que nunca termina.
 */
export async function reconciliarSessaoOrfa(sessionId: string): Promise<void> {
  const session = await prisma.chargingSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { chargePointId: true, meterStartWh: true, startedAt: true },
  })

  const lastSample = await prisma.meterSample.findFirst({
    where: { sessionId, measurand: 'Energy.Active.Import.Register' },
    orderBy: { ts: 'desc' },
    select: { value: true, ts: true },
  })

  const meterStopWh = lastSample ? Math.round(Number(lastSample.value)) : session.meterStartWh
  const timestamp = lastSample ? lastSample.ts : session.startedAt

  await finalizarSessao(sessionId, { meterStopWh, timestamp, stopReason: 'OTHER' })

  logger.warn(
    { chargePointId: session.chargePointId, sessionId, meterStopWh },
    '[carteira] sessão órfã reconciliada — carregador não reconhece mais esta transação',
  )
}
