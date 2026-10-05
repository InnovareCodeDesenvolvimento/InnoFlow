import type { PrismaClient } from '@prisma/client'
import type { EntradaDossie, EventoOcpp, PontoDeMedicao } from '../../core/estornos/dossie'

/**
 * Lê do banco o que o dossiê de chargeback precisa (L1.8) e entrega no formato do núcleo puro (`core/estornos/dossie.ts`). SÓ leitura, sem lock.
 * NÃO seleciona nome, e-mail, CPF, telefone, `idTag` nem token de cartão — a seleção é por lista explícita, não `include` de relação inteira.
 */

const LIMITE_MEDICOES_LIDAS = 50_000
const LIMITE_EVENTOS_OCPP = 200
const FOLGA_DA_TRILHA_MS = 5 * 60_000

const ACOES_DA_TRILHA = ['Authorize', 'StartTransaction', 'StopTransaction', 'RemoteStartTransaction', 'RemoteStopTransaction', 'StatusNotification']

type Db = PrismaClient

export class VendaDoChargebackInvalidaError extends Error {
  constructor(readonly motivo: 'PAYMENT_NOT_FOUND' | 'PAYMENT_NOT_CAPTURED') {
    super(motivo)
    this.name = 'VendaDoChargebackInvalidaError'
  }
}

/** O envelope OCPP-J de um CALL é `[2, id, action, payload]`. Devolve só o payload (objeto) ou `null`. */
function payloadDoCall(envelope: unknown): Record<string, unknown> | null {
  if (!Array.isArray(envelope) || envelope.length < 4) return null
  const p = envelope[3]
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
}

const comoTexto = (v: unknown): string | null => (typeof v === 'string' && v.length <= 80 ? v : null)
const comoNumero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Reduz o payload a campos de PROTOCOLO. `idTag` e qualquer outro campo ficam de fora. Devolve `null` quando o evento é de OUTRO conector/transação. */
export function resumirEventoOcpp(acao: string | null, payload: Record<string, unknown> | null, conector: number, ocppTransactionId: number): Record<string, string | number | null> | null {
  const p = payload ?? {}
  const connectorId = comoNumero(p.connectorId)
  if (connectorId !== null && connectorId !== 0 && connectorId !== conector) return null
  if (acao === 'StopTransaction') {
    if (comoNumero(p.transactionId) !== ocppTransactionId) return null
    return { transactionId: ocppTransactionId, meterStop: comoNumero(p.meterStop), reason: comoTexto(p.reason) }
  }
  if (acao === 'StartTransaction') return { connectorId, meterStart: comoNumero(p.meterStart) }
  if (acao === 'StatusNotification') return { connectorId, status: comoTexto(p.status), errorCode: comoTexto(p.errorCode) }
  if (acao === 'RemoteStartTransaction' || acao === 'RemoteStopTransaction') return { connectorId }
  return {}
}

export async function lerDadosDoDossie(db: Db, paymentIntentId: string): Promise<Omit<EntradaDossie, 'chargeback' | 'geradoEm'> & { operatorId: string; chargingSessionId: string; userId: string; amountCapturedCents: number }> {
  const intent = await db.paymentIntent.findUnique({
    where: { id: paymentIntentId },
    select: {
      id: true,
      provider: true,
      purpose: true,
      environment: true,
      status: true,
      returnCode: true,
      userId: true,
      operatorId: true,
      chargingSessionId: true,
      paymentMethodId: true,
      amountRequestedCents: true,
      amountAuthorizedCents: true,
      amountCapturedCents: true,
      authorizedAt: true,
      capturedAt: true,
      cieloPaymentId: true,
      cieloTid: true,
      cieloAuthorizationCode: true,
      cieloProofOfSale: true,
    },
  })
  if (!intent || intent.provider !== 'CIELO_CARD' || !intent.chargingSessionId) throw new VendaDoChargebackInvalidaError('PAYMENT_NOT_FOUND')
  if (!intent.amountCapturedCents || intent.amountCapturedCents <= 0) throw new VendaDoChargebackInvalidaError('PAYMENT_NOT_CAPTURED')

  const sessao = await db.chargingSession.findUniqueOrThrow({
    where: { id: intent.chargingSessionId },
    select: {
      id: true,
      ocppTransactionId: true,
      status: true,
      paymentMode: true,
      startedAt: true,
      chargingEndedAt: true,
      stoppedAt: true,
      stopReason: true,
      meterStartWh: true,
      meterStopWh: true,
      energyDeliveredWh: true,
      idleSeconds: true,
      energyCostCents: true,
      timeCostCents: true,
      idleFeeCents: true,
      sessionFeeCents: true,
      minChargeAdjustmentCents: true,
      totalCostCents: true,
      tariffSnapshot: true,
      startIp: true,
      startUserAgent: true,
      chargePointId: true,
      site: { select: { name: true, city: true, timezone: true } },
      chargePoint: { select: { ocppIdentity: true, vendor: true, model: true } },
      connector: { select: { connectorId: true, type: true } },
    },
  })

  const [pagador, aceites, cartao, medicoes, totalDeMedicoes] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: intent.userId }, select: { id: true, createdAt: true, googleSub: true } }),
    db.consentRecord.findMany({ where: { userId: intent.userId }, orderBy: { acceptedAt: 'desc' }, take: 10, select: { kind: true, version: true, acceptedAt: true, source: true } }),
    intent.paymentMethodId ? db.paymentMethod.findUnique({ where: { id: intent.paymentMethodId }, select: { brand: true, last4: true, expiryMonth: true, expiryYear: true, createdAt: true } }) : Promise.resolve(null),
    db.meterSample.findMany({
      where: { sessionId: sessao.id, measurand: { in: ['Energy.Active.Import.Register', 'Power.Active.Import', 'SoC'] } },
      orderBy: { ts: 'asc' },
      take: LIMITE_MEDICOES_LIDAS,
      select: { ts: true, measurand: true, value: true, unit: true },
    }),
    db.meterSample.count({ where: { sessionId: sessao.id } }),
  ])

  const de = new Date(sessao.startedAt.getTime() - FOLGA_DA_TRILHA_MS)
  const ate = new Date((sessao.stoppedAt ?? new Date()).getTime() + FOLGA_DA_TRILHA_MS)
  const mensagens = await db.ocppMessage.findMany({
    where: { chargePointId: sessao.chargePointId, occurredAt: { gte: de, lte: ate }, messageType: 'CALL', action: { in: ACOES_DA_TRILHA } },
    orderBy: { occurredAt: 'asc' },
    take: LIMITE_EVENTOS_OCPP * 3, // sobra: parte é descartada por ser de outro conector/transação
    select: { occurredAt: true, direction: true, messageType: true, action: true, payload: true },
  })
  const trilhaOcpp: EventoOcpp[] = []
  for (const m of mensagens) {
    const resumo = resumirEventoOcpp(m.action, payloadDoCall(m.payload), sessao.connector.connectorId, sessao.ocppTransactionId)
    if (resumo === null) continue
    trilhaOcpp.push({ occurredAt: m.occurredAt, direction: m.direction, messageType: m.messageType, action: m.action, resumo })
    if (trilhaOcpp.length >= LIMITE_EVENTOS_OCPP) break
  }

  const pontos: PontoDeMedicao[] = medicoes.map((m) => ({ ts: m.ts, measurand: m.measurand, value: Number(m.value), unit: m.unit }))

  return {
    operatorId: intent.operatorId ?? '',
    chargingSessionId: sessao.id,
    userId: intent.userId,
    amountCapturedCents: intent.amountCapturedCents,
    venda: {
      paymentIntentId: intent.id,
      environment: intent.environment,
      status: intent.status,
      returnCode: intent.returnCode,
      amountRequestedCents: intent.amountRequestedCents,
      amountAuthorizedCents: intent.amountAuthorizedCents,
      amountCapturedCents: intent.amountCapturedCents,
      authorizedAt: intent.authorizedAt,
      capturedAt: intent.capturedAt,
      cieloPaymentId: intent.cieloPaymentId,
      tid: intent.cieloTid,
      authorizationCode: intent.cieloAuthorizationCode,
      proofOfSale: intent.cieloProofOfSale,
    },
    cartao: cartao ? { brand: cartao.brand, last4: cartao.last4, expiryMonth: cartao.expiryMonth, expiryYear: cartao.expiryYear, cadastradoEm: cartao.createdAt } : null,
    pagador: { id: pagador.id, contaCriadaEm: pagador.createdAt, identidadeVerificada: pagador.googleSub !== null, aceites },
    sessao: {
      id: sessao.id,
      ocppTransactionId: sessao.ocppTransactionId,
      status: sessao.status,
      paymentMode: sessao.paymentMode,
      startedAt: sessao.startedAt,
      chargingEndedAt: sessao.chargingEndedAt,
      stoppedAt: sessao.stoppedAt,
      stopReason: sessao.stopReason,
      meterStartWh: sessao.meterStartWh,
      meterStopWh: sessao.meterStopWh,
      energyDeliveredWh: sessao.energyDeliveredWh,
      idleSeconds: sessao.idleSeconds,
      energyCostCents: sessao.energyCostCents,
      timeCostCents: sessao.timeCostCents,
      idleFeeCents: sessao.idleFeeCents,
      sessionFeeCents: sessao.sessionFeeCents,
      minChargeAdjustmentCents: sessao.minChargeAdjustmentCents,
      totalCostCents: sessao.totalCostCents,
      tariffSnapshot: sessao.tariffSnapshot,
      origem: { startIp: sessao.startIp, startUserAgent: sessao.startUserAgent },
    },
    local: {
      siteName: sessao.site.name,
      city: sessao.site.city,
      timezone: sessao.site.timezone,
      chargePointIdentity: sessao.chargePoint.ocppIdentity,
      vendor: sessao.chargePoint.vendor,
      model: sessao.chargePoint.model,
      connectorNumber: sessao.connector.connectorId,
      connectorType: sessao.connector.type,
    },
    medicoes: pontos,
    totalDeMedicoes,
    trilhaOcpp,
  }
}
