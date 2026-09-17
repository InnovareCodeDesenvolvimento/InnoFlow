import { Prisma, type StopReason } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { STOP_REASON_MAP, stopTransactionReqSchema } from '../schemas/stopTransaction'
import { calcularCustoSessao, type CustoSessaoResultado, type TariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { liquidarSessao, enqueueLiquidarSessaoRetry } from '../../services/carteira/liquidarSessao'
import { defineOcppHandler } from './defineHandler'

const ZERO_CUSTOS: CustoSessaoResultado = {
  energyCostCents: 0,
  timeCostCents: 0,
  idleFeeCents: 0,
  sessionFeeCents: 0,
  minChargeAdjustmentCents: 0,
  totalCostCents: 0,
}

/**
 * F4 (2026-09-17): agora calcula custo de verdade (`calcularCustoSessao`) e
 * liquida a carteira (`liquidarSessao`) — dentro de UMA `$transaction`
 * (status + custo + débito). Regra de ouro da Nova, reforçada aqui: o
 * carregador NUNCA fica refém da nossa contabilidade — respondemos
 * `Accepted` mesmo se a transação de finalização falhar, enfileirando um
 * retry (`enqueueLiquidarSessaoRetry`) em vez de deixar o `CALL_ERROR`
 * propagar (o carregador ficaria retentando o StopTransaction pra sempre).
 *
 * NÃO escreve mais `Connector.status = AVAILABLE` aqui — mentia quando o
 * carro continuava plugado em `Finishing` (a fonte de verdade do conector
 * passa a ser só `StatusNotification`, ver `statusNotification.ts`).
 */
export const handleStopTransaction = defineOcppHandler('StopTransaction', stopTransactionReqSchema, async (data, ctx) => {
  const existing = await prisma.chargingSession.findUnique({
    where: { ocppTransactionId: data.transactionId },
    select: { id: true, status: true },
  })

  if (!existing) {
    logger.warn({ chargePointId: ctx.chargePointId, transactionId: data.transactionId }, '[ocpp] StopTransaction: transactionId desconhecido')
    return { idTagInfo: { status: 'Accepted' } }
  }

  if (existing.status === 'STOPPED') {
    // Idempotência de negócio: reconexão do carregador pode reenviar o MESMO
    // evento lógico com um ocppMessageId novo (idempotency.ts só dedupe por
    // (chargePointId, ocppMessageId) exato) — nunca reprocessa.
    logger.info({ chargePointId: ctx.chargePointId, transactionId: data.transactionId }, '[ocpp] StopTransaction: sessão já STOPPED, ignorando')
    return { idTagInfo: { status: 'Accepted' } }
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "ChargingSession" WHERE id = ${existing.id} FOR UPDATE`)

      const session = await tx.chargingSession.findUniqueOrThrow({
        where: { id: existing.id },
        select: {
          id: true,
          status: true,
          meterStartWh: true,
          startedAt: true,
          chargingEndedAt: true,
          tariffSnapshot: true,
          site: { select: { timezone: true } },
        },
      })

      if (session.status === 'STOPPED') return // corrida: outra chamada já finalizou entre o read e o lock

      const tariffSnapshot = session.tariffSnapshot as unknown as TariffSnapshot

      let energyDeliveredWh = data.meterStop - session.meterStartWh
      let stopReason: StopReason | null = data.reason ? STOP_REASON_MAP[data.reason] : null
      if (energyDeliveredWh < 0) {
        logger.warn(
          { sessionId: session.id, meterStop: data.meterStop, meterStartWh: session.meterStartWh },
          '[ocpp] StopTransaction: energyDeliveredWh negativo — clampado em 0',
        )
        energyDeliveredWh = 0
        stopReason = 'OTHER'
      }

      // Janela de ociosidade: [chargingEndedAt + carência, stoppedAt) — mesma
      // fórmula documentada no schema (`ChargingSession.idleSeconds`).
      let idleSeconds: number | null = null
      if (session.chargingEndedAt) {
        const idleStartMs = session.chargingEndedAt.getTime() + tariffSnapshot.idleGracePeriodSeconds * 1000
        idleSeconds = Math.max(0, Math.round((data.timestamp.getTime() - idleStartMs) / 1000))
      }

      // NUNCA pode lançar daqui pra fora — uma exceção viraria CALL_ERROR e o
      // carregador ficaria retentando o StopTransaction pra sempre.
      // `calcularCustoSessao` só lança para inconsistência estrutural (datas
      // fora de ordem), que os clamps acima já deveriam prevenir — mesmo
      // assim blindamos com fallback de custo zerado em vez de propagar.
      let custos: CustoSessaoResultado = ZERO_CUSTOS
      try {
        custos = calcularCustoSessao(tariffSnapshot, {
          energyDeliveredWh,
          startedAt: session.startedAt,
          chargingEndedAt: session.chargingEndedAt,
          stoppedAt: data.timestamp,
          timezone: session.site.timezone,
        })
      } catch (err) {
        logger.error({ err, sessionId: session.id }, '[ocpp] calcularCustoSessao lançou — usando custo zerado (nunca bloqueia o carregador)')
      }

      await tx.chargingSession.update({
        where: { id: session.id },
        data: {
          status: 'STOPPED',
          meterStopWh: data.meterStop,
          energyDeliveredWh,
          stoppedAt: data.timestamp,
          stopReason,
          idleSeconds,
          ...custos,
        },
      })

      // Débito atômico da carteira — MESMA função usada pelo job de retry
      // (`liquidarSessao`), aqui reaproveitando a transação já aberta (nunca
      // abre uma transação aninhada). Essa costura (inline + job) é o que a
      // F5 reaproveita sem reescrever o handler.
      await liquidarSessao(session.id, tx)
    })
  } catch (err) {
    logger.error(
      { err, chargePointId: ctx.chargePointId, transactionId: data.transactionId, sessionId: existing.id },
      '[ocpp] StopTransaction: transação de finalização falhou — respondendo Accepted mesmo assim e enfileirando retry',
    )
    await enqueueLiquidarSessaoRetry(existing.id).catch((enqueueErr) =>
      logger.error({ err: enqueueErr, sessionId: existing.id }, '[ocpp] falha ao enfileirar retry de liquidação'),
    )
  }

  logger.info({ chargePointId: ctx.chargePointId, transactionId: data.transactionId }, '[ocpp] StopTransaction processado')

  return { idTagInfo: { status: 'Accepted' } }
})
