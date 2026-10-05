import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { AppError } from '../../api/middleware/errorHandler'

/** Leituras do ADMIN para as telas de chargeback. Só ADMIN chega aqui (a rota decide); sem dado do motorista além do id (pseudônimo). */

/** `ChargebackDTO` do contrato (`frontend/src/types/api.ts`) + campos ADITIVOS (todos opcionais para o consumidor atual). */
export interface ChargebackDTO {
  id: string
  paymentIntentId: string
  amountCents: number
  caseReference: string
  outcome: 'WON' | 'LOST' | 'ACCEPTED' | null
  notifiedAt: string
  responseDeadline: string | null
  dossierId: string
  // ---- aditivos ----
  chargingSessionId: string | null
  reasonCode: string | null
  /** Estado bruto: `OPEN` enquanto não há desfecho. */
  status: 'OPEN' | 'WON' | 'LOST' | 'ACCEPTED'
  debtId: string | null
  createdAt: string
  resolvedAt: string | null
  /** O motorista está sem o modo cartão POR ESTE chargeback agora (OPEN, ou LOST/ACCEPTED ainda não desbloqueado). */
  cardBlocked: boolean
  /** Desbloqueio manual do ADMIN (P3): quando e por quê. `null` enquanto não houve. O registro/dossiê/desfecho não mudam. */
  cardUnblockedAt: string | null
  cardUnblockReason: string | null
}

type LinhaChargeback = Prisma.PaymentReversalGetPayload<Record<string, never>>

export function chargebackParaDto(r: LinhaChargeback): ChargebackDTO {
  const status = r.status as ChargebackDTO['status']
  return {
    id: r.id,
    paymentIntentId: r.paymentIntentId!,
    amountCents: r.amountCents,
    caseReference: r.caseReference!,
    outcome: status === 'OPEN' ? null : (status as 'WON' | 'LOST' | 'ACCEPTED'),
    notifiedAt: r.notifiedAt!.toISOString(),
    responseDeadline: r.responseDeadline?.toISOString() ?? null,
    dossierId: r.id,
    chargingSessionId: r.chargingSessionId,
    reasonCode: r.reasonCode,
    status,
    debtId: r.debtId,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    cardBlocked: status === 'OPEN' || ((status === 'LOST' || status === 'ACCEPTED') && r.cardUnblockedAt === null),
    cardUnblockedAt: r.cardUnblockedAt?.toISOString() ?? null,
    cardUnblockReason: r.cardUnblockReason,
  }
}

export async function listarChargebacks(params: { outcome?: 'OPEN' | 'WON' | 'LOST' | 'ACCEPTED'; paymentIntentId?: string; page: number; pageSize: number }): Promise<{ items: ChargebackDTO[]; total: number; page: number; pageSize: number }> {
  const where: Prisma.PaymentReversalWhereInput = { kind: 'CHARGEBACK', ...(params.outcome ? { status: params.outcome } : {}), ...(params.paymentIntentId ? { paymentIntentId: params.paymentIntentId } : {}) }
  const [linhas, total] = await Promise.all([
    prisma.paymentReversal.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
    prisma.paymentReversal.count({ where }),
  ])
  return { items: linhas.map(chargebackParaDto), total, page: params.page, pageSize: params.pageSize }
}

export async function lerChargeback(id: string): Promise<ChargebackDTO> {
  const r = await prisma.paymentReversal.findFirst({ where: { id, kind: 'CHARGEBACK' } })
  if (!r) throw new AppError('Chargeback não encontrado.', 404, 'NOT_FOUND')
  return chargebackParaDto(r)
}

/** O snapshot gravado no momento do registro (imutável). `dossierId` = id do chargeback. */
export async function lerDossie(id: string): Promise<Record<string, unknown>> {
  const r = await prisma.paymentReversal.findFirst({ where: { id, kind: 'CHARGEBACK' }, select: { dossierSnapshot: true } })
  if (!r || r.dossierSnapshot === null || typeof r.dossierSnapshot !== 'object' || Array.isArray(r.dossierSnapshot)) throw new AppError('Dossiê não encontrado.', 404, 'NOT_FOUND')
  return r.dossierSnapshot as Record<string, unknown>
}
