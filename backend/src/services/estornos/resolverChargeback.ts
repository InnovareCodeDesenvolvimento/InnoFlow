import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { diffEntity } from '../../core/auditoria/diffEntity'
import { AppError } from '../../api/middleware/errorHandler'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { chargebackParaDto, type ChargebackDTO } from './consultasChargebacks'
import type { AtorEstorno, RequisicaoEstorno } from './tipos'

/**
 * Desfecho de um chargeback (L1.8, DL7): `OPEN -> WON | LOST | ACCEPTED`, só o ADMIN, com step-up (a rota confere a senha antes).
 *  - `WON`: o modo cartão do motorista volta (o bloqueio é DERIVADO de OPEN/LOST/ACCEPTED, então sair de OPEN para WON o libera sozinho). `CREATE_DEBT` é recusado (400).
 *  - `LOST`/`ACCEPTED`: a PLATAFORMA absorve e o motorista segue SEM o modo cartão (não há desbloqueio manual — pendência de política P3). Dívida só por ação MANUAL:
 *    `debtPolicy: 'CREATE_DEBT'` cria `Debt` OPEN do motorista com o valor do chargeback; omitido/`ABSORB` não cria nada.
 *
 * A DÍVIDA NÃO é ligada à sessão (`Debt.chargingSessionId` fica nulo, só `paymentIntentId`): a conciliação soma `Debt OPEN` por sessão do período na identidade
 * `faturamento = capturas + débitos + dívida aberta`; uma dívida de chargeback ali somaria um valor que o faturamento da sessão já cobriu (a venda foi CAPTURADA) e quebraria a identidade.
 * Ela bloqueia a próxima recarga como qualquer dívida (DRIVER_HAS_OPEN_DEBT) e é quitada pelo crédito de Pix automaticamente (FIFO).
 *
 * Concorrência: a linha é travada `FOR UPDATE`; dois desfechos simultâneos => o 2º vê o estado final e recebe 409 `CHARGEBACK_ALREADY_RESOLVED` (o banco também
 * recusa mudar estado terminal). Auditoria FAIL-CLOSED na mesma transação (a dívida, se houver, inclusa).
 */

export async function resolverChargeback(params: {
  chargebackId: string
  outcome: 'WON' | 'LOST' | 'ACCEPTED'
  debtPolicy?: 'CREATE_DEBT' | 'ABSORB'
  ator: AtorEstorno
  requisicao: RequisicaoEstorno
}): Promise<ChargebackDTO> {
  const { chargebackId, outcome, debtPolicy, ator, requisicao } = params
  if (debtPolicy === 'CREATE_DEBT' && outcome === 'WON') {
    throw new AppError('Dados inválidos.', 400, 'VALIDATION_ERROR', [{ path: 'debtPolicy', message: 'Chargeback ganho não gera dívida.' }])
  }

  const atualizado = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "PaymentReversal" WHERE id = ${chargebackId} FOR UPDATE`)
    const cb = await tx.paymentReversal.findUnique({ where: { id: chargebackId } })
    if (!cb || cb.kind !== 'CHARGEBACK') throw new AppError('Chargeback não encontrado.', 404, 'NOT_FOUND')
    if (cb.status !== 'OPEN') throw new AppError('Este chargeback já teve o desfecho registrado.', 409, 'CHARGEBACK_ALREADY_RESOLVED')

    let debtId: string | null = null
    if (debtPolicy === 'CREATE_DEBT') {
      const sessao = cb.chargingSessionId ? await tx.chargingSession.findUnique({ where: { id: cb.chargingSessionId }, select: { operatorId: true } }) : null
      const divida = await tx.debt.create({
        data: {
          userId: cb.userId,
          operatorId: sessao?.operatorId ?? null,
          chargingSessionId: null, // ver o comentário do arquivo: a dívida do chargeback NÃO entra na identidade de conciliação por sessão
          paymentIntentId: cb.paymentIntentId,
          amountCents: cb.amountCents,
          status: 'OPEN',
          reason: 'CHARGEBACK',
        },
        select: { id: true },
      })
      debtId = divida.id
    }

    const atual = await tx.paymentReversal.update({
      where: { id: chargebackId },
      data: { status: outcome, resolvedAt: new Date(), resolvedByUserId: ator.userId, debtId },
    })

    await writeAuditLog(
      {
        actorUserId: ator.userId,
        actorRole: ator.role,
        actorEmail: ator.email,
        actorName: ator.name,
        actorOperatorId: ator.operatorId,
        action: 'CHARGEBACK',
        actionDetail: `chargeback:${outcome.toLowerCase()}${debtId ? ':debt_created' : ''}`,
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'PaymentReversal',
        entityId: chargebackId,
        method: requisicao.method,
        path: requisicao.path,
        ipAddress: requisicao.ipAddress,
        userAgent: requisicao.userAgent,
        requestId: requisicao.requestId,
        changes: diffEntity(
          { status: 'OPEN' },
          { status: outcome, amountCents: cb.amountCents, debtId, paymentIntentId: cb.paymentIntentId, targetUserId: cb.userId },
          ['status', 'amountCents', 'debtId', 'paymentIntentId', 'targetUserId'],
        ),
      },
      tx,
    )
    return atual
  })

  logger.info({ chargebackId, outcome, debtCreated: atualizado.debtId !== null, actorUserId: ator.userId }, '[chargeback] desfecho registrado')
  return chargebackParaDto(atualizado)
}
