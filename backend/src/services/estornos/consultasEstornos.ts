import { prisma } from '../../lib/prisma'
import { AppError } from '../../api/middleware/errorHandler'
import { calcularCobradoCents, calcularReembolsavelCents } from '../../core/estornos/avaliarEstorno'
import { carregarFotoCobrancaSessao } from './fotoCobranca'

/** Leituras do ADMIN para a tela de estorno. Só ADMIN chega aqui (a rota decide); sem dado do motorista além do id (pseudônimo). */

export interface SessionRefundDTO {
  id: string
  sessionId: string
  paymentIntentId: string | null
  destination: 'WALLET' | 'CARD_VIA_PORTAL'
  status: 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'CANCELLED'
  amountCents: number
  reason: string
  portalReference: string | null
  walletEntryId: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface SessionRefundsResponse {
  sessionId: string
  /** Quanto a sessão de fato cobrou (nunca acima do total). */
  billedCents: number
  /** Σ dos estornos NÃO cancelados (pendentes seguram o teto). */
  refundedCents: number
  /** Quanto ainda dá para estornar. */
  refundableCents: number
  items: SessionRefundDTO[]
}

export async function listarEstornosDaSessao(sessionId: string): Promise<SessionRefundsResponse> {
  const sessao = await prisma.chargingSession.findUnique({ where: { id: sessionId }, select: { id: true, status: true, totalCostCents: true } })
  if (!sessao) throw new AppError('Sessão não encontrada.', 404, 'SESSION_NOT_FOUND')
  const [{ foto }, linhas] = await Promise.all([
    carregarFotoCobrancaSessao(prisma, sessionId, sessao.totalCostCents),
    prisma.paymentReversal.findMany({ where: { chargingSessionId: sessionId, kind: 'REFUND' }, orderBy: { createdAt: 'desc' }, take: 200 }),
  ])
  // Sessão não encerrada não cobrou nada ainda (o registro recusa com SESSION_NOT_BILLED): mostra 0 em vez de um "reembolsável" que a rota negaria.
  const cobrado = sessao.status === 'STOPPED' ? calcularCobradoCents(foto) : 0
  const reembolsavel = sessao.status === 'STOPPED' ? calcularReembolsavelCents(foto) : 0
  return {
    sessionId,
    billedCents: cobrado,
    refundedCents: foto.estornadoCents,
    refundableCents: reembolsavel,
    items: linhas.map((r) => ({
      id: r.id,
      sessionId,
      paymentIntentId: r.paymentIntentId,
      destination: r.destination as SessionRefundDTO['destination'],
      status: r.status as SessionRefundDTO['status'],
      amountCents: r.amountCents,
      reason: r.reason ?? '',
      portalReference: r.portalReference,
      walletEntryId: r.walletEntryId,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
  }
}
