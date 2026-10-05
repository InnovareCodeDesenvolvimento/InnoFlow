import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { diffEntity } from '../../core/auditoria/diffEntity'
import { AppError } from '../../api/middleware/errorHandler'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { chargebackParaDto, type ChargebackDTO } from './consultasChargebacks'
import type { AtorEstorno, RequisicaoEstorno } from './tipos'

/**
 * Desbloqueio MANUAL do modo cartão depois de um chargeback PERDIDO (L1.8, DL7/P3 — aceito pelo dono em 06/10/2026): `LOST`/`ACCEPTED` bloqueia o cartão do motorista e o ADMIN pode devolver o
 * acesso, caso a caso, com MOTIVO e a SENHA dele (a rota confere antes). O desbloqueio NÃO apaga o registro nem mexe no desfecho/dossiê/dívida: só preenche `cardUnblockedAt/By/Reason` (o banco
 * recusa qualquer outra mudança no estado terminal e recusa mudar um desbloqueio já gravado). `OPEN` já bloqueia (resolve-se dando o desfecho) e `WON` nunca bloqueou. Um chargeback por venda:
 * se o motorista tiver OUTRO chargeback perdido ainda não desbloqueado, o cartão segue bloqueado por ele (cada um é desbloqueado separadamente).
 *
 * Concorrência: linha travada `FOR UPDATE`; dois desbloqueios simultâneos => o 2º recebe 409 `CARD_ALREADY_UNBLOCKED`. Auditoria FAIL-CLOSED na mesma transação (sem rastro, sem desbloqueio).
 */
export async function desbloquearCartaoPorChargeback(params: { chargebackId: string; reason: string; ator: AtorEstorno; requisicao: RequisicaoEstorno }): Promise<ChargebackDTO> {
  const { chargebackId, reason, ator, requisicao } = params

  const atualizado = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "PaymentReversal" WHERE id = ${chargebackId} FOR UPDATE`)
    const cb = await tx.paymentReversal.findUnique({ where: { id: chargebackId } })
    if (!cb || cb.kind !== 'CHARGEBACK') throw new AppError('Chargeback não encontrado.', 404, 'NOT_FOUND')
    if (cb.status !== 'LOST' && cb.status !== 'ACCEPTED') {
      throw new AppError('Só um chargeback perdido (LOST/ACCEPTED) tem o cartão a desbloquear: em aberto, dê o desfecho; ganho (WON) nunca bloqueou.', 409, 'CHARGEBACK_NOT_LOST')
    }
    if (cb.cardUnblockedAt !== null) throw new AppError('O cartão deste chargeback já foi desbloqueado.', 409, 'CARD_ALREADY_UNBLOCKED')

    const atual = await tx.paymentReversal.update({ where: { id: chargebackId }, data: { cardUnblockedAt: new Date(), cardUnblockedByUserId: ator.userId, cardUnblockReason: reason } })

    // FAIL-CLOSED. SEM o texto do motivo (livre, pode ter nome) — ele fica no registro do chargeback.
    await writeAuditLog(
      {
        actorUserId: ator.userId,
        actorRole: ator.role,
        actorEmail: ator.email,
        actorName: ator.name,
        actorOperatorId: ator.operatorId,
        action: 'CHARGEBACK',
        actionDetail: 'chargeback:card_unblocked',
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'PaymentReversal',
        entityId: chargebackId,
        method: requisicao.method,
        path: requisicao.path,
        ipAddress: requisicao.ipAddress,
        userAgent: requisicao.userAgent,
        requestId: requisicao.requestId,
        changes: diffEntity({ cardBlocked: true }, { cardBlocked: false, status: cb.status, paymentIntentId: cb.paymentIntentId, targetUserId: cb.userId }, ['cardBlocked', 'status', 'paymentIntentId', 'targetUserId']),
      },
      tx,
    )
    return atual
  })

  logger.info({ chargebackId, actorUserId: ator.userId }, '[chargeback] cartão do motorista desbloqueado manualmente')
  return chargebackParaDto(atualizado)
}
