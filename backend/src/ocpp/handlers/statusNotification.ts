import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { CONNECTOR_STATUS_MAP, statusNotificationReqSchema } from '../schemas/statusNotification'
import { defineOcppHandler } from './defineHandler'

/**
 * F4 (2026-09-17): além de atualizar `Connector.status` (como sempre fez),
 * agora também sincroniza o status da `ChargingSession` aberta naquele
 * conector — vira a ÚNICA fonte de verdade para `status`/`chargingEndedAt`
 * (os writes forçados que existiam em `startTransaction.ts`/
 * `stopTransaction.ts` foram removidos: eles mentiam sobre o estado real do
 * conector, especialmente no Stop, que marcava `AVAILABLE` mesmo com o carro
 * ainda plugado em `Finishing`).
 *
 * Mapeamento (decisão da Nova + dono, 2026-09-17):
 *   - `Charging`               -> `CHARGING`, `chargingEndedAt = null`
 *   - `SuspendedEV`/`Finishing`-> `FINISHING`, `chargingEndedAt` setado SE
 *                                  ainda `null` (marca o INÍCIO da janela de
 *                                  ociosidade, nunca reescrita depois)
 *   - `Faulted`                -> `FAULTED`
 *   - `SuspendedEVSE`          -> NÃO mexe na sessão (decisão do dono: não é
 *                                  ociosidade cobrável, é problema da estação)
 *   - qualquer outro status    -> não mexe na sessão (ex.: `Available`,
 *                                  `Preparing`, `Reserved`, `Unavailable` não
 *                                  têm efeito na sessão de recarga)
 */
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

  const connector = await prisma.connector.findUnique({
    where: { chargePointId_connectorId: { chargePointId: ctx.chargePointId, connectorId: data.connectorId } },
  })

  if (!connector) {
    // Carregador reportou um connectorId que não está cadastrado — não é um
    // erro fatal do protocolo (respondemos {} normalmente), mas é sinal de
    // charge point mal configurado ou conector cadastrado errado na API.
    logger.warn({ chargePointId: ctx.chargePointId, connectorId: data.connectorId }, '[ocpp] StatusNotification para conector não cadastrado')
    await prisma.chargePoint.update({ where: { id: ctx.chargePointId }, data: { lastSeenAt: now } })
    return {}
  }

  await prisma.connector.update({
    where: { id: connector.id },
    data: { status: CONNECTOR_STATUS_MAP[data.status], statusUpdatedAt: data.timestamp ?? now, errorCode: data.errorCode },
  })

  await syncChargingSessionStatus(connector.id, data.status, data.timestamp ?? now)

  await prisma.chargePoint.update({ where: { id: ctx.chargePointId }, data: { lastSeenAt: now } })

  return {}
})

async function syncChargingSessionStatus(connectorId: string, ocppStatus: string, eventAt: Date): Promise<void> {
  if (ocppStatus === 'SuspendedEVSE') return // decisão do dono: não é ociosidade cobrável.

  const openStatuses = ['STARTED', 'CHARGING', 'FINISHING'] as const
  const session = await prisma.chargingSession.findFirst({
    where: { connectorId, status: { in: [...openStatuses] } },
    orderBy: { startedAt: 'desc' },
  })
  if (!session) return

  if (ocppStatus === 'Charging') {
    await prisma.chargingSession.update({ where: { id: session.id }, data: { status: 'CHARGING', chargingEndedAt: null } })
    return
  }

  if (ocppStatus === 'SuspendedEV' || ocppStatus === 'Finishing') {
    await prisma.chargingSession.update({
      where: { id: session.id },
      data: { status: 'FINISHING', ...(session.chargingEndedAt ? {} : { chargingEndedAt: eventAt }) },
    })
    return
  }

  if (ocppStatus === 'Faulted') {
    await prisma.chargingSession.update({ where: { id: session.id }, data: { status: 'FAULTED' } })
  }

  // Outros status (Available, Preparing, Reserved, Unavailable) não afetam a
  // sessão de recarga — o encerramento real acontece só no StopTransaction.
}
