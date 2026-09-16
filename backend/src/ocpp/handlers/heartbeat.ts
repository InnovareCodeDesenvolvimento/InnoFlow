import { prisma } from '../../lib/prisma'
import { heartbeatReqSchema } from '../schemas/heartbeat'
import { defineOcppHandler } from './defineHandler'

export const handleHeartbeat = defineOcppHandler('Heartbeat', heartbeatReqSchema, async (_data, ctx) => {
  const now = new Date()
  await prisma.chargePoint.update({ where: { id: ctx.chargePointId }, data: { lastSeenAt: now } })
  return { currentTime: now.toISOString() }
})
