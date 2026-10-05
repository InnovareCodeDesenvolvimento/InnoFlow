import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { diffEntity } from '../../core/auditoria/diffEntity'
import { montarDossie } from '../../core/estornos/dossie'
import { AppError } from '../../api/middleware/errorHandler'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { lerDadosDoDossie, VendaDoChargebackInvalidaError } from './lerDadosDoDossie'
import type { AtorEstorno, RequisicaoEstorno } from './tipos'

/**
 * Registro MANUAL de um chargeback (L1.8, DL7) — o InnoFlow nunca "descobre sozinho" (conta Cielo compartilhada, sem webhook nosso; a Cielo avisa o dono por
 * e-mail/portal). O ADMIN acha a venda (relatório de pagamentos filtrado por Tid/NSU/código de autorização) e registra aqui. Efeitos, na MESMA transação:
 *   1. `PaymentReversal` CHARGEBACK/OPEN com o DOSSIÊ montado NESTE instante (a medição pode ser expurgada depois; a consulta Cielo só alcança ~3 meses);
 *   2. o motorista perde o MODO CARTÃO na hora (bloqueio DERIVADO: existe chargeback OPEN/LOST/ACCEPTED — `elegibilidadeCartao.ts`); Pix e carteira seguem;
 *   3. o trigger do banco grava `PaymentIntent.chargebackAt` (informativo). O status do intent NÃO muda: a conciliação não muda.
 * Um chargeback por venda: o índice único parcial do banco decide a corrida (409 `CHARGEBACK_ALREADY_REGISTERED`).
 */

export interface RegistrarChargebackParams {
  paymentIntentId: string
  amountCents: number
  notifiedAt: Date
  caseReference: string
  reasonCode?: string
  responseDeadline?: Date
  ator: AtorEstorno
  requisicao: RequisicaoEstorno
}

export async function registrarChargeback(params: RegistrarChargebackParams): Promise<{ chargebackId: string; dossierId: string }> {
  const { paymentIntentId, amountCents, notifiedAt, caseReference, reasonCode, responseDeadline, ator, requisicao } = params

  // Pré-checagem amigável (o índice único é a garantia real — abaixo, a corrida cai no mesmo 409).
  const jaRegistrado = await prisma.paymentReversal.findFirst({ where: { paymentIntentId, kind: 'CHARGEBACK' }, select: { id: true } })
  if (jaRegistrado) throw new AppError('Já existe um chargeback registrado para esta venda.', 409, 'CHARGEBACK_ALREADY_REGISTERED', { chargebackId: jaRegistrado.id })

  let dados
  try {
    dados = await lerDadosDoDossie(prisma, paymentIntentId)
  } catch (err) {
    if (err instanceof VendaDoChargebackInvalidaError) {
      if (err.motivo === 'PAYMENT_NOT_CAPTURED') throw new AppError('Esta venda não tem valor capturado: não há o que contestar.', 409, 'PAYMENT_NOT_CAPTURED')
      throw new AppError('Venda de cartão não encontrada.', 404, 'PAYMENT_NOT_FOUND')
    }
    throw err
  }
  if (amountCents > dados.amountCapturedCents) {
    throw new AppError('Dados inválidos.', 400, 'VALIDATION_ERROR', [{ path: 'amountCents', message: 'O valor do chargeback passa do que foi capturado nesta venda.' }])
  }

  const dossie = montarDossie({
    geradoEm: new Date(),
    chargeback: { caseReference, reasonCode: reasonCode ?? null, notifiedAt, responseDeadline: responseDeadline ?? null, amountCents },
    venda: dados.venda,
    cartao: dados.cartao,
    pagador: dados.pagador,
    sessao: dados.sessao,
    local: dados.local,
    medicoes: dados.medicoes,
    totalDeMedicoes: dados.totalDeMedicoes,
    trilhaOcpp: dados.trilhaOcpp,
  })

  let id: string
  try {
    id = await prisma.$transaction(async (tx) => {
      const criado = await tx.paymentReversal.create({
        data: {
          kind: 'CHARGEBACK',
          status: 'OPEN',
          chargingSessionId: dados.chargingSessionId,
          paymentIntentId,
          userId: dados.userId, // o trigger reescreve a partir da venda; o tipo do Prisma exige o campo
          amountCents,
          caseReference,
          reasonCode: reasonCode ?? null,
          notifiedAt,
          responseDeadline: responseDeadline ?? null,
          dossierSnapshot: dossie as Prisma.InputJsonObject,
          createdByUserId: ator.userId,
        },
        select: { id: true },
      })
      // FAIL-CLOSED: sem rastro, sem bloqueio do cartão do motorista. Sem texto livre e sem dado do motorista além do id.
      await writeAuditLog(
        {
          actorUserId: ator.userId,
          actorRole: ator.role,
          actorEmail: ator.email,
          actorName: ator.name,
          actorOperatorId: ator.operatorId,
          action: 'CHARGEBACK',
          actionDetail: 'chargeback:registered',
          outcome: 'SUCCESS',
          httpStatus: 201,
          entityType: 'PaymentReversal',
          entityId: criado.id,
          method: requisicao.method,
          path: requisicao.path,
          ipAddress: requisicao.ipAddress,
          userAgent: requisicao.userAgent,
          requestId: requisicao.requestId,
          changes: diffEntity(
            null,
            { status: 'OPEN', amountCents, caseReference, paymentIntentId, chargingSessionId: dados.chargingSessionId, targetUserId: dados.userId },
            ['status', 'amountCents', 'caseReference', 'paymentIntentId', 'chargingSessionId', 'targetUserId'],
          ),
        },
        tx,
      )
      return criado.id
    })
  } catch (err) {
    // Corrida: duas requisições passaram da pré-checagem — o índice único parcial do banco decide. Só ele pode conflitar aqui (walletEntryId/debtId vão nulos).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('Já existe um chargeback registrado para esta venda.', 409, 'CHARGEBACK_ALREADY_REGISTERED')
    }
    throw err
  }

  logger.info({ chargebackId: id, paymentIntentId, amountCents, actorUserId: ator.userId }, '[chargeback] chargeback registrado — modo cartão do motorista bloqueado; responder à Cielo dentro do prazo')
  return { chargebackId: id, dossierId: id }
}
