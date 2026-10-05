import type { Prisma, PrismaClient } from '@prisma/client'
import type { FotoCobrancaSessao } from '../../core/estornos/avaliarEstorno'

type Db = Prisma.TransactionClient | PrismaClient

export interface IntentCartaoCapturado {
  id: string
  amountCapturedCents: number | null
}

/**
 * Lê o que a sessão cobrou e o que já foi estornado. Quem precisa de CONSISTÊNCIA (o registro do estorno) chama isto DEPOIS de travar a sessão
 * (`FOR NO KEY UPDATE`); a listagem só informativa pode chamar sem lock.
 */
export async function carregarFotoCobrancaSessao(db: Db, sessionId: string, totalCostCents: number | null): Promise<{ foto: FotoCobrancaSessao; intentsCartao: IntentCartaoCapturado[] }> {
  const [debitoCarteira, intentsCartao, dividaQuitada, estornado] = await Promise.all([
    db.walletEntry.aggregate({ _sum: { amountCents: true }, where: { type: 'CHARGE_DEBIT', referenceType: 'CHARGING_SESSION', referenceId: sessionId } }),
    db.paymentIntent.findMany({
      where: { chargingSessionId: sessionId, purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', status: 'CAPTURED' },
      select: { id: true, amountCapturedCents: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.debt.aggregate({ _sum: { amountCents: true }, where: { chargingSessionId: sessionId, status: 'SETTLED' } }),
    db.paymentReversal.aggregate({ _sum: { amountCents: true }, where: { chargingSessionId: sessionId, kind: 'REFUND', status: { not: 'CANCELLED' } } }),
  ])
  return {
    foto: {
      totalCostCents,
      walletDebitCents: -(debitoCarteira._sum.amountCents ?? 0),
      cardCapturedCents: intentsCartao.reduce((soma, i) => soma + (i.amountCapturedCents ?? 0), 0),
      debtSettledCents: dividaQuitada._sum.amountCents ?? 0,
      estornadoCents: estornado._sum.amountCents ?? 0,
    },
    intentsCartao,
  }
}
