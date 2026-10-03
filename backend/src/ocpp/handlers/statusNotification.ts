import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { CONNECTOR_STATUS_MAP, statusNotificationReqSchema } from '../schemas/statusNotification'
import { defineOcppHandler } from './defineHandler'
import { emitChargePointStatus } from '../../realtime/emit'
import { listarEstadosSessaoAberta } from '../../core/sessao/estadosSessao'

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

  const mappedStatus = CONNECTOR_STATUS_MAP[data.status]

  await prisma.connector.update({
    where: { id: connector.id },
    // statusUpdatedAt = relógio do CARREGADOR (payload), mantido como sempre; statusReceivedAt = relógio do SERVIDOR (F5.9, regra R2).
    data: { status: mappedStatus, statusUpdatedAt: data.timestamp ?? now, statusReceivedAt: now, errorCode: data.errorCode },
  })

  await syncChargingSessionStatus(connector.id, data.status, data.timestamp ?? now)

  await prisma.chargePoint.update({ where: { id: ctx.chargePointId }, data: { lastSeenAt: now } })

  void emitChargePointStatus(ctx.operatorId, ctx.chargePointId, data.connectorId, mappedStatus).catch((err) =>
    logger.error({ err, chargePointId: ctx.chargePointId, connectorId: data.connectorId }, '[realtime] falha ao publicar chargepoint.status (não bloqueante)'),
  )

  return {}
})

async function syncChargingSessionStatus(connectorId: string, ocppStatus: string, eventAt: Date): Promise<void> {
  // Constante ÚNICA de sessão aberta (F5.9) — inclui FAULTED, que antes ficava de fora e nunca voltava a CHARGING.
  const session = await prisma.chargingSession.findFirst({
    where: { connectorId, status: { in: listarEstadosSessaoAberta() } },
    orderBy: { startedAt: 'desc' },
  })
  if (!session) return

  // F5.9: o StatusNotification Charging/SuspendedEV/SuspendedEVSE/Finishing de um conector COM sessão aberta é atividade do carregador
  // sobre a transação — move `lastActivityAt` (RELÓGIO DO SERVIDOR; `eventAt` abaixo é o do carregador e não entra aqui).
  const atividade = ATIVIDADE_DO_CONECTOR.has(ocppStatus) ? { lastActivityAt: new Date() } : {}

  // M1 (Órion): TODO update da sessão é CONDICIONAL ao status ainda ser aberto (`updateMany`, atômico contra o UPDATE do fechamento). O `findFirst` acima
  // roda fora de qualquer lock: entre ele e o update o StopTransaction/watchdog podia commitar STOPPED, e um `update({ status })` incondicional RESSUSCITAVA a
  // sessão — que o watchdog fechava de novo, recalculando e sobrescrevendo `totalCostCents` com débito/captura já gravados (conciliação quebrada).
  const aindaAberta = { id: session.id, status: { in: listarEstadosSessaoAberta() } }

  if (ocppStatus === 'SuspendedEVSE') {
    // Decisão do dono: não é ociosidade cobrável (problema da estação) — só registra a atividade, não mexe no status da sessão.
    await prisma.chargingSession.updateMany({ where: aindaAberta, data: atividade })
    return
  }

  if (ocppStatus === 'Charging') {
    // Inclusive FAULTED -> CHARGING: o carregador voltou a carregar, a falha passou.
    await prisma.chargingSession.updateMany({ where: aindaAberta, data: { status: 'CHARGING', chargingEndedAt: null, ...atividade } })
    return
  }

  if (ocppStatus === 'SuspendedEV' || ocppStatus === 'Finishing') {
    await prisma.chargingSession.updateMany({
      where: aindaAberta,
      data: { status: 'FINISHING', ...(session.chargingEndedAt ? {} : { chargingEndedAt: eventAt }), ...atividade },
    })
    return
  }

  if (ocppStatus === 'Faulted') {
    await prisma.chargingSession.updateMany({ where: aindaAberta, data: { status: 'FAULTED' } })
  }

  // Outros status (Available, Preparing, Reserved, Unavailable) não afetam a
  // sessão de recarga — o encerramento real acontece só no StopTransaction
  // (ou, sem ele, pelo watchdog: R2 usa `Connector.statusReceivedAt`).
}

/** Status OCPP do conector que contam como atividade da transação em curso (F5.9). */
const ATIVIDADE_DO_CONECTOR = new Set(['Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'])
