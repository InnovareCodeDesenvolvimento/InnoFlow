import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { CONNECTOR_STATUS_MAP, statusNotificationReqSchema } from '../schemas/statusNotification'
import { defineOcppHandler } from './defineHandler'

export const handleStatusNotification = defineOcppHandler('StatusNotification', statusNotificationReqSchema, async (data, ctx) => {
  const now = new Date()

  // connectorId = 0 representa o charge point inteiro no protocolo — NUNCA
  // existe uma linha Connector para ele (regra do Cronos, CHECK
  // connector_id <> 0). Só atualizamos a presença do charge point.
  if (data.connectorId === 0) {
    await prisma.chargePoint.update({ where: { id: ctx.chargePointId }, data: { lastSeenAt: now } })
    logger.info({ chargePointId: ctx.chargePointId, status: data.status }, '[ocpp] StatusNotification (charge point inteiro)')
    return {}
  }

  const updated = await prisma.connector.updateMany({
    where: { chargePointId: ctx.chargePointId, connectorId: data.connectorId },
    data: {
      status: CONNECTOR_STATUS_MAP[data.status],
      statusUpdatedAt: data.timestamp ?? now,
      errorCode: data.errorCode,
    },
  })

  if (updated.count === 0) {
    // Carregador reportou um connectorId que não está cadastrado — não é um
    // erro fatal do protocolo (respondemos {} normalmente), mas é sinal de
    // charge point mal configurado ou conector cadastrado errado na API.
    logger.warn({ chargePointId: ctx.chargePointId, connectorId: data.connectorId }, '[ocpp] StatusNotification para conector não cadastrado')
  }

  await prisma.chargePoint.update({ where: { id: ctx.chargePointId }, data: { lastSeenAt: now } })

  return {}
})
