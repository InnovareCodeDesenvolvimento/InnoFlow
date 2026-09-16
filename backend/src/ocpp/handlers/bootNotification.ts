import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { bootNotificationReqSchema } from '../schemas/bootNotification'
import { defineOcppHandler } from './defineHandler'

export const handleBootNotification = defineOcppHandler('BootNotification', bootNotificationReqSchema, async (data, ctx) => {
  const now = new Date()

  await prisma.chargePoint.update({
    where: { id: ctx.chargePointId },
    data: {
      vendor: data.chargePointVendor,
      model: data.chargePointModel,
      serialNumber: data.chargePointSerialNumber ?? data.chargeBoxSerialNumber,
      firmwareVersion: data.firmwareVersion,
      lastBootAt: now,
      lastSeenAt: now,
    },
  })

  logger.info({ chargePointId: ctx.chargePointId, vendor: data.chargePointVendor, model: data.chargePointModel }, '[ocpp] BootNotification aceito')

  return {
    status: 'Accepted',
    interval: 300, // segundos entre Heartbeats — fixo no MVP, sem config por charge point ainda
    currentTime: now.toISOString(),
  }
})
