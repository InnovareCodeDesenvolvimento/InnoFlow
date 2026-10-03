import type { Prisma, StopReason } from '@prisma/client'
import { logger } from '../../lib/logger'
import { escolherLeituraFinal, type LeituraAmostra, type LeituraFinal, type LeituraStopNoLog } from '../../core/sessao/leituraFinal'
import { stopTransactionReqSchema, STOP_REASON_MAP } from '../../ocpp/schemas/stopTransaction'

/**
 * Busca, no banco, as provas de leitura final de uma sessão e escolhe a melhor (`core/sessao/leituraFinal.ts`). Chamada DENTRO do
 * lock da sessão (encerramento pelo servidor) para que um StopTransaction que acabou de ser logado entre o snapshot do watchdog e
 * o lock já seja visto; e também fora de lock pelo watchdog, só para saber se há prova (booleanos do snapshot).
 *
 * Fecha a limitação documentada em `liquidarSessao.ts`: o payload do StopTransaction (meterStop/timestamp/reason) está no log bruto
 * `OcppMessage` (gravado por `idempotency.ts` ANTES do handler), mesmo quando a finalização falhou e a sessão ficou aberta.
 */

/** Margem do filtro de partição do log (`OcppMessage` é particionada por `occurredAt`, que é o `timestamp` do PAYLOAD = relógio do carregador). */
const MARGEM_PARTICAO_MS = 2 * 24 * 3_600_000

export interface SessaoParaLeitura {
  id: string
  chargePointId: string
  ocppTransactionId: number
  meterStartWh: number
  startedAt: Date
  /** Para o `max(...)` do instante final (ALTO-1). */
  chargingEndedAt?: Date | null
}

export interface LeituraResolvida extends LeituraFinal {
  /** `reason` do Stop do log já no enum do banco, ou `null` (amostra/sem leitura: o chamador usa `OTHER`). */
  stopReason: StopReason | null
}

export async function buscarStopTransactionNoLog(tx: Prisma.TransactionClient, sessao: Pick<SessaoParaLeitura, 'id' | 'chargePointId' | 'ocppTransactionId' | 'startedAt'>): Promise<LeituraStopNoLog | null> {
  const mensagens = await tx.ocppMessage.findMany({
    where: {
      chargePointId: sessao.chargePointId,
      direction: 'INBOUND',
      action: 'StopTransaction',
      occurredAt: { gte: new Date(sessao.startedAt.getTime() - MARGEM_PARTICAO_MS) },
      payload: { path: ['transactionId'], equals: sessao.ocppTransactionId },
    },
    orderBy: { receivedAt: 'desc' },
    take: 5, // o mais recente que VALIDA vence (um payload malformado no log não pode esconder um Stop bom logo atrás)
    select: { payload: true },
  })

  for (const mensagem of mensagens) {
    const parsed = stopTransactionReqSchema.safeParse(mensagem.payload)
    if (parsed.success) return { meterStopWh: parsed.data.meterStop, timestamp: parsed.data.timestamp, reason: parsed.data.reason ?? null }
    logger.warn({ sessionId: sessao.id }, '[sessao] StopTransaction do log bruto não passou na validação — ignorado como prova de leitura')
  }
  return null
}

/** ALTO-2: filtra TAMBÉM pelo carregador da sessão — amostra gravada com o `sessionId` certo mas por OUTRO carregador não é prova. */
export async function buscarUltimaAmostra(tx: Prisma.TransactionClient, sessionId: string, chargePointId: string): Promise<LeituraAmostra | null> {
  const amostra = await tx.meterSample.findFirst({
    where: { sessionId, chargePointId, measurand: 'Energy.Active.Import.Register' },
    orderBy: { ts: 'desc' },
    select: { value: true, ts: true },
  })
  return amostra ? { meterWh: Number(amostra.value), timestamp: amostra.ts } : null
}

export async function resolverLeituraFinal(tx: Prisma.TransactionClient, sessao: SessaoParaLeitura): Promise<LeituraResolvida> {
  const [stopNoLog, ultimaAmostra] = await Promise.all([buscarStopTransactionNoLog(tx, sessao), buscarUltimaAmostra(tx, sessao.id, sessao.chargePointId)])
  const leitura = escolherLeituraFinal({ stopNoLog, ultimaAmostra, meterStartWh: sessao.meterStartWh, startedAt: sessao.startedAt, chargingEndedAt: sessao.chargingEndedAt })
  const reason = leitura.reason && leitura.reason in STOP_REASON_MAP ? STOP_REASON_MAP[leitura.reason as keyof typeof STOP_REASON_MAP] : null
  return { ...leitura, stopReason: reason }
}
