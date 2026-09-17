import type { Prisma } from '@prisma/client'
import { createRPCError } from 'ocpp-rpc'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { startTransactionReqSchema } from '../schemas/startTransaction'
import { resolveActiveTariff } from '../tariffResolution'
import { checkAuthorization } from '../authorizationCheck'
import { serializeTariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { defineOcppHandler } from './defineHandler'

/**
 * F4 (2026-09-17): repete a MESMA checagem do `Authorize` (o Authorize é
 * opcional no protocolo — o carregador pode ir direto pro Start) via
 * `checkAuthorization` — saldo/Debt/status do token, tudo centralizado em
 * `avaliarInicioSessao`. `tariffSnapshot` agora inclui `TariffWindow[]`
 * (fecha o gap documentado desde a F3a). NÃO escreve mais
 * `Connector.status` aqui — a fonte de verdade do conector passa a ser só o
 * `StatusNotification` real (o write forçado aqui mentia quando o
 * carregador demorava a confirmar `Charging`).
 */
export const handleStartTransaction = defineOcppHandler('StartTransaction', startTransactionReqSchema, async (data, ctx) => {
  const chargePoint = await prisma.chargePoint.findUniqueOrThrow({ where: { id: ctx.chargePointId } })

  const connector = await prisma.connector.findUnique({
    where: { chargePointId_connectorId: { chargePointId: ctx.chargePointId, connectorId: data.connectorId } },
  })
  if (!connector) {
    throw createRPCError('PropertyConstraintViolation', `Conector ${data.connectorId} não está cadastrado neste charge point.`)
  }

  const { resultado, token } = await checkAuthorization(data.idTag, data.timestamp)
  if (resultado.decision !== 'Accepted' || !token?.userId) {
    logger.warn(
      { chargePointId: ctx.chargePointId, idTag: data.idTag, decision: resultado.decision, reason: 'reason' in resultado ? resultado.reason : undefined },
      '[ocpp] StartTransaction recusado',
    )
    // transactionId 0 é o valor convencional do spec para "não vou abrir
    // transação nenhuma" — o carregador não deve liberar a tomada.
    return { transactionId: 0, idTagInfo: { status: resultado.decision } }
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
      authTokenId: token.id,
      userId: token.userId,
      status: 'STARTED',
      meterStartWh: data.meterStart,
      startedAt: data.timestamp,
      tariffId: tariff.id,
      // Congela a tarifa vigente (com as janelas ponta/fora-ponta) — sessão
      // antiga nunca recalcula com a tarifa de hoje.
      tariffSnapshot: serializeTariffSnapshot(tariff, tariff.windows) as unknown as Prisma.InputJsonValue,
    },
  })

  logger.info(
    { chargePointId: ctx.chargePointId, connectorId: data.connectorId, transactionId: session.ocppTransactionId, userId: token.userId },
    '[ocpp] StartTransaction aceito',
  )

  return { transactionId: session.ocppTransactionId, idTagInfo: { status: 'Accepted' } }
})
