import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { diffEntity } from '../../core/auditoria/diffEntity'
import { AppError } from '../../api/middleware/errorHandler'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import type { AtorEstorno, RequisicaoEstorno } from './tipos'

/**
 * O ADMIN desfaz o REGISTRO de uma devolução pelo portal que ainda está `PENDING_CONFIRMATION` (digitou errado, o dono desistiu, o estorno nunca foi feito no portal).
 * Só cancela o registro — nunca mexe na Cielo. Libera o teto que o pendente segurava. Estorno já CONFIRMED/CANCELLED é terminal (409 `REFUND_NOT_CANCELLABLE`),
 * e estorno para a carteira nunca é cancelável (o dinheiro já está no saldo do motorista).
 *
 * CORRIDA com o job de confirmação: trava a linha `FOR UPDATE`; o job atualiza com `updateMany WHERE status = 'PENDING_CONFIRMATION'` (confere a contagem), então
 * quem chegar depois do outro enxerga o estado novo e não sobrescreve.
 */
export async function cancelarEstornoPortal(params: { refundId: string; ator: AtorEstorno; requisicao: RequisicaoEstorno }): Promise<{ refundId: string; status: 'CANCELLED' }> {
  const { refundId, ator, requisicao } = params

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "PaymentReversal" WHERE id = ${refundId} FOR UPDATE`)
    const estorno = await tx.paymentReversal.findUnique({
      where: { id: refundId },
      select: { id: true, kind: true, destination: true, status: true, amountCents: true, chargingSessionId: true, paymentIntentId: true, userId: true },
    })
    if (!estorno || estorno.kind !== 'REFUND') throw new AppError('Estorno não encontrado.', 404, 'NOT_FOUND')
    if (estorno.destination !== 'CARD_VIA_PORTAL' || estorno.status !== 'PENDING_CONFIRMATION') {
      throw new AppError('Só dá para cancelar o registro de uma devolução no cartão que ainda aguarda confirmação.', 409, 'REFUND_NOT_CANCELLABLE')
    }

    await tx.paymentReversal.update({ where: { id: refundId }, data: { status: 'CANCELLED', resolvedAt: new Date(), resolvedByUserId: ator.userId } })

    await writeAuditLog(
      {
        actorUserId: ator.userId,
        actorRole: ator.role,
        actorEmail: ator.email,
        actorName: ator.name,
        actorOperatorId: ator.operatorId,
        action: 'REFUND',
        actionDetail: 'refund:cancelled',
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'PaymentReversal',
        entityId: refundId,
        method: requisicao.method,
        path: requisicao.path,
        ipAddress: requisicao.ipAddress,
        userAgent: requisicao.userAgent,
        requestId: requisicao.requestId,
        changes: diffEntity({ status: 'PENDING_CONFIRMATION' }, { status: 'CANCELLED', amountCents: estorno.amountCents, chargingSessionId: estorno.chargingSessionId, paymentIntentId: estorno.paymentIntentId, targetUserId: estorno.userId }, [
          'status',
          'amountCents',
          'chargingSessionId',
          'paymentIntentId',
          'targetUserId',
        ]),
      },
      tx,
    )
  })

  logger.info({ refundId, actorUserId: ator.userId }, '[estorno] registro de devolução no portal cancelado')
  return { refundId, status: 'CANCELLED' }
}
