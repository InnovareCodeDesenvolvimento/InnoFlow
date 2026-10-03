import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { alertarLimitadoPorEscopo } from '../services/sessao/alertasSessao'
import type { OcppHandlerCtx } from './context'

/**
 * ALTO-2 (Órion): StopTransaction e MeterValues localizavam a sessão só por `ocppTransactionId` — um Int sequencial, GLOBAL, de todos os carregadores de
 * todos os operadores. Um carregador autenticado (ou com credencial comprometida) podia fechar a sessão ALHEIA com um `meterStop` arbitrário (recarga
 * grátis, ou cobrança para a vítima) e forjar MeterValues (manter viva/reanimar a sessão; viravam a "última amostra" do watchdog).
 *
 * Regra agora: o handler busca `{ ocppTransactionId, chargePointId: ctx.chargePointId }`. Sem match a transação é DESCONHECIDA para aquele carregador —
 * e, se o id existe em OUTRO carregador, isto não é um simples id desconhecido: é tentativa de mexer em sessão alheia, e vira alerta de ERRO
 * `ocpp_foreign_transaction` (sem dado pessoal: só ids técnicos; 1x/h por carregador+transação). Nada na sessão do dono muda.
 */
export async function tratarTransacaoNaoEncontrada(ctx: OcppHandlerCtx, transactionId: number, action: 'StopTransaction' | 'MeterValues'): Promise<'ESTRANGEIRA' | 'DESCONHECIDA'> {
  const dona = await prisma.chargingSession.findUnique({ where: { ocppTransactionId: transactionId }, select: { chargePointId: true } })
  if (!dona || dona.chargePointId === ctx.chargePointId) return 'DESCONHECIDA'

  logger.error({ chargePointId: ctx.chargePointId, transactionId, action }, '[ocpp] transactionId pertence a OUTRO carregador — ignorado')
  await alertarLimitadoPorEscopo(
    'ocpp_foreign_transaction',
    `${ctx.chargePointId}:${transactionId}`,
    { chargePointId: ctx.chargePointId, transactionId, action },
    `${action} de um carregador com o transactionId de OUTRO carregador — ignorado (nada na sessão alheia foi alterado)`,
  ).catch(() => undefined)
  return 'ESTRANGEIRA'
}
