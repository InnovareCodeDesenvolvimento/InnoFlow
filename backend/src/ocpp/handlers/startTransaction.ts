import type { Prisma } from '@prisma/client'
import { createRPCError } from 'ocpp-rpc'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { startTransactionReqSchema } from '../schemas/startTransaction'
import { resolveActiveTariff } from '../tariffResolution'
import { defineOcppHandler } from './defineHandler'

/**
 * MVP: cria a `ChargingSession` e marca o conector como CHARGING. NÃO
 * calcula custo nem idle fee (F4) e NÃO faz pré-autorização de pagamento
 * (F5) — a decisão de aceitar a transação aqui é só "o idTag está
 * ACCEPTED", igual ao Authorize.
 */
export const handleStartTransaction = defineOcppHandler('StartTransaction', startTransactionReqSchema, async (data, ctx) => {
  const chargePoint = await prisma.chargePoint.findUniqueOrThrow({ where: { id: ctx.chargePointId } })

  const connector = await prisma.connector.findUnique({
    where: { chargePointId_connectorId: { chargePointId: ctx.chargePointId, connectorId: data.connectorId } },
  })
  if (!connector) {
    throw createRPCError('PropertyConstraintViolation', `Conector ${data.connectorId} não está cadastrado neste charge point.`)
  }

  const authToken = await prisma.authToken.findUnique({ where: { idTag: data.idTag } })
  if (!authToken || authToken.status !== 'ACCEPTED' || !authToken.userId) {
    logger.warn({ chargePointId: ctx.chargePointId, idTag: data.idTag }, '[ocpp] StartTransaction: idTag não autorizado — sessão recusada')
    // transactionId 0 é o valor convencional do spec para "não vou abrir
    // transação nenhuma" — o carregador não deve liberar a tomada.
    return { transactionId: 0, idTagInfo: { status: 'Invalid' } }
  }

  const tariff = await resolveActiveTariff(connector, chargePoint)

  const session = await prisma.chargingSession.create({
    data: {
      // operatorId é reescrito por trigger a partir de connector.operatorId
      // de qualquer forma (ver schema-innoelektron.md do Cronos) — mandamos
      // ctx.operatorId (o mesmo valor, já resolvido no handshake) só para
      // satisfazer o tipo obrigatório do Prisma, não por precisar acertar.
      operatorId: ctx.operatorId,
      siteId: chargePoint.siteId,
      chargePointId: chargePoint.id,
      connectorId: connector.id,
      authTokenId: authToken.id,
      userId: authToken.userId,
      status: 'STARTED',
      meterStartWh: data.meterStart,
      startedAt: data.timestamp,
      tariffId: tariff.id,
      // Congela a tarifa vigente — sessão antiga nunca recalcula com a
      // tarifa de hoje (regra do Cronos).
      tariffSnapshot: tariff as unknown as Prisma.InputJsonValue,
    },
  })

  await prisma.connector.update({
    where: { id: connector.id },
    data: { status: 'CHARGING', statusUpdatedAt: data.timestamp },
  })

  logger.info(
    { chargePointId: ctx.chargePointId, connectorId: data.connectorId, transactionId: session.ocppTransactionId, userId: authToken.userId },
    '[ocpp] StartTransaction aceito',
  )

  return { transactionId: session.ocppTransactionId, idTagInfo: { status: 'Accepted' } }
})
