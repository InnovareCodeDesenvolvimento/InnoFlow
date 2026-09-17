import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { STOP_REASON_MAP, stopTransactionReqSchema } from '../schemas/stopTransaction'
import { finalizarSessao } from '../../services/carteira/finalizarSessao'
import { enqueueLiquidarSessaoRetry } from '../../services/carteira/liquidarSessao'
import { defineOcppHandler } from './defineHandler'

/**
 * F4 (2026-09-17): agora calcula custo de verdade e liquida a carteira via
 * `finalizarSessao` — regra de ouro da Nova, reforçada aqui: o carregador
 * NUNCA fica refém da nossa contabilidade — respondemos `Accepted` mesmo se
 * a transação de finalização falhar, enfileirando um retry
 * (`enqueueLiquidarSessaoRetry`) em vez de deixar o `CALL_ERROR` propagar (o
 * carregador ficaria retentando o StopTransaction pra sempre).
 *
 * F5 (2026-09-17): o núcleo (cálculo de energia/idle/custo + débito) foi
 * extraído para `finalizarSessao` — reaproveitado agora também pela
 * reconciliação de sessão órfã em `bootNotification.ts`. Este handler cuida
 * só da parte OCPP-específica: idempotência de negócio (sessão já
 * conhecida/já STOPPED) e o mapeamento de `StopReason`.
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
    await finalizarSessao(existing.id, {
      meterStopWh: data.meterStop,
      timestamp: data.timestamp,
      stopReason: data.reason ? STOP_REASON_MAP[data.reason] : null,
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
