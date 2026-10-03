import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { STOP_REASON_MAP, stopTransactionReqSchema, type StopTransactionReq } from '../schemas/stopTransaction'
import { finalizarSessao } from '../../services/carteira/finalizarSessao'
import { enqueueLiquidarSessaoRetry } from '../../services/carteira/liquidarSessao'
import { registrarStopTardio } from '../../services/sessao/registrarStopTardio'
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
 * extraído para `finalizarSessao` — reaproveitado também pelo encerramento
 * pelo servidor (F5.9, `encerrarSessaoPeloServidor`). Este handler cuida só
 * da parte OCPP-específica: idempotência de negócio (sessão já
 * conhecida/já STOPPED) e o mapeamento de `StopReason`.
 *
 * F5.9 (2026-10-03): aceita o Stop sobre sessão `STOP_UNCONFIRMED` (o Stop que o
 * carregador enfileirou offline e manda DEPOIS do Boot fecha normalmente, com
 * `closureSource=CHARGER`) e trata o Stop que chega com a sessão já STOPPED:
 * se foi o SERVIDOR que a encerrou, `registrarStopTardio` guarda o que o
 * carregador diz sem mexer em dinheiro; se foi o próprio carregador, é duplicata.
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
    await tratarStopSobreSessaoEncerrada(existing.id, data, ctx.chargePointId)
    return { idTagInfo: { status: 'Accepted' } }
  }

  try {
    // Qualquer status != STOPPED fecha normalmente — inclusive STOP_UNCONFIRMED (F5.9, correção do D-A: o Stop que o carregador
    // enfileirou offline e manda DEPOIS do Boot fecha com o meterStop verdadeiro, em vez de cair em "já STOPPED, ignorando").
    const resultado = await finalizarSessao(existing.id, {
      meterStopWh: data.meterStop,
      timestamp: data.timestamp,
      stopReason: data.reason ? STOP_REASON_MAP[data.reason] : null,
      closureSource: 'CHARGER',
      meterStopSource: 'STOP_TRANSACTION',
    })
    // Corrida: entre a leitura acima e o lock, o watchdog (ou outra cópia deste Stop) fechou a sessão. Este Stop virou "tardio".
    if (resultado && !resultado.finalizada && resultado.motivo === 'JA_ENCERRADA') {
      await tratarStopSobreSessaoEncerrada(existing.id, data, ctx.chargePointId)
    }
    if (resultado && !resultado.finalizada && resultado.causa === 'CUSTO_NAO_CALCULADO') {
      // ALTO-1: o cálculo de custo falhou e `finalizarSessao` já abortou (alerta de erro emitido): a sessão NÃO foi fechada de graça. Retry de liquidação
      // não adiantaria (não há o que liquidar); o carregador recebe Accepted e a sessão fica para revisão manual / para o watchdog.
      logger.error({ chargePointId: ctx.chargePointId, transactionId: data.transactionId, sessionId: existing.id }, '[ocpp] StopTransaction: custo não calculado — sessão mantida aberta para revisão manual')
    }
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

/**
 * StopTransaction sobre sessão que JÁ está STOPPED. Duas origens muito diferentes:
 *  - duplicata (reconexão reenvia o MESMO evento com `ocppMessageId` novo): a sessão foi fechada pelo próprio carregador (ou é anterior à
 *    F5.9) — nada a fazer, só um log;
 *  - Stop TARDIO: o servidor encerrou a sessão (`closureSource=SERVER`) antes de o Stop chegar — `registrarStopTardio` guarda o que o
 *    carregador diz, SEM mexer em dinheiro, e alerta.
 * O carregador SEMPRE recebe `Accepted`: falha daqui é logada e engolida (ele ficaria reenviando o Stop para sempre).
 */
async function tratarStopSobreSessaoEncerrada(sessionId: string, data: StopTransactionReq, chargePointId: string): Promise<void> {
  try {
    const resultado = await registrarStopTardio({ sessionId, meterStopWh: data.meterStop, timestamp: data.timestamp })
    if (!resultado.registrado) {
      logger.info({ chargePointId, transactionId: data.transactionId, outcome: resultado.motivo }, '[ocpp] StopTransaction: sessão já STOPPED, ignorando')
    }
  } catch (err) {
    logger.error({ err, chargePointId, transactionId: data.transactionId, sessionId }, '[ocpp] StopTransaction tardio: falha ao registrar (não bloqueante — respondendo Accepted)')
  }
}
