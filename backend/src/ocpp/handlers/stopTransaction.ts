import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { STOP_REASON_MAP, stopTransactionReqSchema } from '../schemas/stopTransaction'
import { defineOcppHandler } from './defineHandler'

/**
 * MVP: encerra a `ChargingSession` (status, medidor final, energia
 * entregue) e libera o conector. NÃO calcula custo/idle fee — os campos
 * `*CostCents` ficam `null` de propósito, preenchidos pela tarifação
 * completa da F4. Responde ao carregador ANTES de qualquer liquidação de
 * dinheiro (regra da Nova) — aqui isso é automático porque não há
 * liquidação nenhuma ainda nesta fase.
 */
export const handleStopTransaction = defineOcppHandler('StopTransaction', stopTransactionReqSchema, async (data, ctx) => {
  const session = await prisma.chargingSession.findUnique({ where: { ocppTransactionId: data.transactionId } })

  if (!session) {
    logger.warn({ chargePointId: ctx.chargePointId, transactionId: data.transactionId }, '[ocpp] StopTransaction: transactionId desconhecido')
    return { idTagInfo: { status: 'Accepted' } }
  }

  await prisma.chargingSession.update({
    where: { id: session.id },
    data: {
      status: 'STOPPED',
      meterStopWh: data.meterStop,
      energyDeliveredWh: data.meterStop - session.meterStartWh,
      stoppedAt: data.timestamp,
      stopReason: data.reason ? STOP_REASON_MAP[data.reason] : null,
    },
  })

  await prisma.connector.update({
    where: { id: session.connectorId },
    data: { status: 'AVAILABLE', statusUpdatedAt: data.timestamp },
  })

  logger.info({ chargePointId: ctx.chargePointId, transactionId: data.transactionId, meterStop: data.meterStop }, '[ocpp] StopTransaction processado')

  return { idTagInfo: { status: 'Accepted' } }
})
