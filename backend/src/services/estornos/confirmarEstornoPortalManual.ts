import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { diffEntity } from '../../core/auditoria/diffEntity'
import { AppError } from '../../api/middleware/errorHandler'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import type { AtorEstorno, RequisicaoEstorno } from './tipos'

/**
 * Confirmação MANUAL de uma devolução pelo portal da Cielo (L1.8). O job `confirmarEstornosPortal` só confirma o inequívoco (Status 11 + registro == capturado inteiro) e a consulta da
 * Cielo só alcança ~3 meses: estorno PARCIAL e venda antiga ficavam pendentes para sempre (a única saída era cancelar o registro e perder a confirmação). Aqui o ADMIN, que viu o estorno
 * no portal da Cielo, confirma com a REFERÊNCIA DO COMPROVANTE.
 *
 * Só `REFUND` + `CARD_VIA_PORTAL` + `PENDING_CONFIRMATION`. Qualquer outro estado (já confirmado, cancelado, de carteira, ou um chargeback) -> 409 `REFUND_NOT_CONFIRMABLE`
 * (inexistente -> 404). O valor NÃO muda e o teto já foi imposto no registro (o pendente segura o teto; o banco recusou o que passasse); confirmar só troca o estado, e o gatilho de sincronização
 * do banco recalcula `PaymentIntent.amountRefundedCents` (informativo; o status do intent e a conciliação NÃO mudam). O CHECK
 * de reembolso-não-excede-captura do PaymentIntent fica por baixo como rede de segurança da soma.
 *
 * Distinção manual x automática SEM coluna nova: o job grava `resolvedByUserId = NULL`; a confirmação manual grava o ADMIN. A referência do comprovante vai em `portalReference` (a referência
 * do estorno no portal — se o registro já trazia uma, a anterior é preservada na auditoria, que guarda de -> para; o registro original só gravou `hasPortalReference`).
 *
 * CORRIDA: trava a linha `FOR UPDATE` (mesmo padrão do cancelamento). Dois ADMINs ao mesmo tempo: o 2º só lê depois do commit do 1º, enxerga CONFIRMED e leva 409 — uma confirmação, uma
 * linha de auditoria. O job usa `updateMany WHERE status = 'PENDING_CONFIRMATION'` e confere a contagem, então perde a disputa sem sobrescrever (e vice-versa).
 *
 * AUDITORIA FAIL-CLOSED na mesma transação (`REFUND`/`refund:manually_confirmed`). Sem texto livre: a referência é um código validado na borda (sem espaço, sem e-mail).
 */
export interface ConfirmarEstornoManualResultado {
  refundId: string
  status: 'CONFIRMED'
  confirmedManually: true
  proofReference: string
}

export async function confirmarEstornoPortalManual(params: { refundId: string; proofReference: string; ator: AtorEstorno; requisicao: RequisicaoEstorno; agora?: Date }): Promise<ConfirmarEstornoManualResultado> {
  const { refundId, proofReference, ator, requisicao } = params
  const agora = params.agora ?? new Date()

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "PaymentReversal" WHERE id = ${refundId} FOR UPDATE`)
    const estorno = await tx.paymentReversal.findUnique({
      where: { id: refundId },
      select: { id: true, kind: true, destination: true, status: true, amountCents: true, chargingSessionId: true, paymentIntentId: true, userId: true, portalReference: true },
    })
    if (!estorno || estorno.kind !== 'REFUND') throw new AppError('Estorno não encontrado.', 404, 'NOT_FOUND')
    if (estorno.destination !== 'CARD_VIA_PORTAL' || estorno.status !== 'PENDING_CONFIRMATION') {
      throw new AppError('Só dá para confirmar à mão uma devolução no cartão que ainda aguarda confirmação.', 409, 'REFUND_NOT_CONFIRMABLE')
    }

    await tx.paymentReversal.update({
      where: { id: refundId },
      data: { status: 'CONFIRMED', resolvedAt: agora, resolvedByUserId: ator.userId, portalReference: proofReference },
    })

    await writeAuditLog(
      {
        actorUserId: ator.userId,
        actorRole: ator.role,
        actorEmail: ator.email,
        actorName: ator.name,
        actorOperatorId: ator.operatorId,
        action: 'REFUND',
        actionDetail: 'refund:manually_confirmed',
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'PaymentReversal',
        entityId: refundId,
        method: requisicao.method,
        path: requisicao.path,
        ipAddress: requisicao.ipAddress,
        userAgent: requisicao.userAgent,
        requestId: requisicao.requestId,
        changes: diffEntity(
          { status: 'PENDING_CONFIRMATION', portalReference: estorno.portalReference },
          { status: 'CONFIRMED', portalReference: proofReference, amountCents: estorno.amountCents, chargingSessionId: estorno.chargingSessionId, paymentIntentId: estorno.paymentIntentId, targetUserId: estorno.userId },
          ['status', 'portalReference', 'amountCents', 'chargingSessionId', 'paymentIntentId', 'targetUserId'],
        ),
      },
      tx,
    )
  })

  logger.info({ refundId, actorUserId: ator.userId }, '[estorno] devolução no portal confirmada manualmente pelo ADMIN')
  return { refundId, status: 'CONFIRMED', confirmedManually: true, proofReference }
}
