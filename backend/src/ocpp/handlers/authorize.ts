import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { authorizeReqSchema } from '../schemas/authorize'
import { defineOcppHandler } from './defineHandler'

/**
 * MVP: só reflete o `AuthToken.status` já cadastrado. NÃO reserva
 * dinheiro/pré-autorização (isso é F5 — ver decisão da Nova: Authorize e
 * StartTransaction nunca chamam a Cielo de forma síncrona, o carregador está
 * esperando na tomada).
 */
export const handleAuthorize = defineOcppHandler('Authorize', authorizeReqSchema, async (data, ctx) => {
  const token = await prisma.authToken.findUnique({ where: { idTag: data.idTag } })

  if (!token) {
    logger.warn({ idTag: data.idTag, chargePointId: ctx.chargePointId }, '[ocpp] Authorize: idTag desconhecido')
    return { idTagInfo: { status: 'Invalid' } }
  }

  if (token.expiresAt && token.expiresAt.getTime() < Date.now()) {
    return { idTagInfo: { status: 'Expired' } }
  }

  const statusMap: Record<string, string> = {
    ACCEPTED: 'Accepted',
    BLOCKED: 'Blocked',
    EXPIRED: 'Expired',
    INVALID: 'Invalid',
  }

  return { idTagInfo: { status: statusMap[token.status] ?? 'Invalid' } }
})
