import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { alocarQuitacaoDividas } from '../../core/pagamentos/alocarQuitacaoDividas'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { SYSTEM_ACTOR } from '../../core/auditoria/systemActor'
import { cacheTopupDebtSettledCents } from './topupEphemeralCache'
import { getPagamentoPort } from './pagamentoPortInstance'
import { ambienteDoIntentConfere } from './ambienteDoIntent'
import { notificarRecargaDeSaldoCreditada } from '../notificacoes/gatilhos'

/**
 * Crédito de recarga Pix — o coração da F5.2. Chamado por DOIS caminhos (o
 * worker do webhook e o varredor de expiração), sempre com o MESMO
 * contrato: idempotente, nunca confia em quem chamou, sempre RECONSULTA a
 * Cielo antes de mexer em dinheiro (decisão §3 da Nova — webhook é dica,
 * nunca verdade).
 *
 * Ordem das operações (fora -> dentro da transação) É proposital:
 * 1. Reconsulta a Cielo FORA da transação (é uma chamada de rede — manter o
 *    `FOR UPDATE` da `Wallet` preso esperando a Cielo responder prenderia a
 *    carteira do motorista para QUALQUER outra escrita concorrente por
 *    segundos).
 * 2. Só abre a transação (e os locks) se a Cielo já confirmou `PAID`.
 * 3. Dentro da transação, RELÊ o `PaymentIntent` com `FOR UPDATE` e confere
 *    de novo se ainda não foi creditado — cobre a corrida entre dois
 *    disparos concorrentes deste mesmo função (webhook chegou 2x, ou
 *    webhook + varredor quase ao mesmo tempo).
 */

export interface CreditarTopupPixResultado {
  paymentIntentId: string
  userId: string
  balanceAfterCents: number
  debtSettledCents: number
  totalCreditedCents: number
  status: 'PAID'
}

export async function creditarTopupPix(paymentIntentId: string, pagamentoPortInjetado?: PagamentoPort): Promise<CreditarTopupPixResultado | null> {
  const pagamentoPort = pagamentoPortInjetado ?? (await getPagamentoPort())
  const intent = await prisma.paymentIntent.findUnique({ where: { id: paymentIntentId } })
  if (!intent) {
    logger.error({ paymentIntentId }, '[creditarTopupPix] PaymentIntent não encontrado — nada a creditar')
    return null
  }
  if (intent.purpose !== 'WALLET_TOPUP_PIX') {
    logger.error({ paymentIntentId, purpose: intent.purpose }, '[creditarTopupPix] PaymentIntent não é WALLET_TOPUP_PIX — bug de programação de quem enfileirou este job')
    return null
  }
  if (intent.status === 'PAID') {
    return null // já creditado (idempotência de alto nível — evita a chamada à Cielo à toa)
  }
  if (!intent.cieloPaymentId) {
    logger.warn({ paymentIntentId }, '[creditarTopupPix] intent sem cieloPaymentId ainda — nada a reconsultar')
    return null
  }

  // F5.7 (M4d): intent de OUTRO ambiente que o gateway efetivo => NÃO consulta a Cielo (host errado) e NÃO decide nada (o Pix segue PENDING, o varredor
  // de expiração também pula). O alerta `payment_intent_environment_mismatch` já foi logado.
  if (!(await ambienteDoIntentConfere(intent, 'creditarTopupPix'))) return null

  // NUNCA confia no webhook — reconsulta antes de creditar (decisão §3 da Nova).
  const consulta = await pagamentoPort.consultarPix(intent.cieloPaymentId)
  if (consulta.status !== 'PAID') {
    logger.info({ paymentIntentId, statusCielo: consulta.status }, '[creditarTopupPix] Cielo ainda não confirma PAID — nada a creditar agora')
    return null
  }

  // I-6: o crédito confere IDENTIDADE e VALOR da venda consultada com o intent. O `PaymentId` vem do nosso próprio POST, então o risco real é baixo, mas é a última barreira antes de
  // mexer no saldo: venda de OUTRO pedido, ou valor pago diferente do pedido, NÃO credita (alerta com os dois lados, sem dado do pagador) e fica para conferência manual.
  if (consulta.merchantOrderId && consulta.merchantOrderId !== intent.id) {
    logger.error({ alert: 'payment_pix_credit_divergence', motivo: 'merchant_order_id', paymentIntentId, paymentId: intent.cieloPaymentId }, '[creditarTopupPix] a venda consultada pertence a OUTRO MerchantOrderId — NÃO credito; conferir à mão')
    return null
  }
  if (consulta.amountCents !== null && consulta.amountCents !== intent.amountRequestedCents) {
    logger.error({ alert: 'payment_pix_credit_divergence', motivo: 'amount', paymentIntentId, paymentId: intent.cieloPaymentId, esperadoCents: intent.amountRequestedCents, pagoCents: consulta.amountCents }, '[creditarTopupPix] o valor da venda na Cielo difere do valor do pedido — NÃO credito; conferir à mão')
    return null
  }
  const totalCents = consulta.amountCents ?? intent.amountRequestedCents

  const resultado = await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string; status: string; userId: string }[]>(
      Prisma.sql`SELECT id, status, "userId" FROM "PaymentIntent" WHERE id = ${paymentIntentId} FOR UPDATE`,
    )
    const locked = lockedRows[0]
    if (!locked) return null
    if (locked.status === 'PAID') return null // corrida: outro disparo já creditou entre a checagem de fora e este lock

    const walletRows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Wallet" WHERE "userId" = ${locked.userId} FOR UPDATE`)
    let walletId = walletRows[0]?.id
    if (!walletId) {
      const wallet = await tx.wallet.create({ data: { userId: locked.userId } })
      walletId = wallet.id
    }

    const lastEntry = await tx.walletEntry.findFirst({ where: { walletId }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
    const saldoAtual = lastEntry?.balanceAfterCents ?? 0

    // Idempotência de EFEITO (rede de segurança sob a checagem de status
    // acima — `ux_wallet_entry_topup_once` garante isto no banco mesmo se a
    // checagem de status escapar por algum caminho não previsto).
    const jaCreditado = await tx.walletEntry.findFirst({ where: { type: 'TOPUP_PIX', referenceType: 'PAYMENT_INTENT', referenceId: paymentIntentId } })
    if (jaCreditado) return null

    const topupEntry = await tx.walletEntry.create({
      data: {
        walletId,
        type: 'TOPUP_PIX',
        amountCents: totalCents,
        balanceAfterCents: saldoAtual + totalCents,
        referenceType: 'PAYMENT_INTENT',
        referenceId: paymentIntentId,
        description: `Recarga Pix ${paymentIntentId}`,
      },
    })

    let saldoRodando = saldoAtual + totalCents

    // Quitação automática de dívida — mais antiga primeiro (decisão §6 da
    // Nova). `alocarQuitacaoDividas` (núcleo puro) decide QUANTO alocar;
    // esta função só grava.
    const dividasAbertas = await tx.debt.findMany({ where: { userId: locked.userId, status: 'OPEN' }, orderBy: { createdAt: 'asc' } })
    const { alocacoes, totalAlocadoCents } = alocarQuitacaoDividas(
      totalCents,
      dividasAbertas.map((d) => ({ id: d.id, amountCents: d.amountCents })),
    )

    for (const alocacao of alocacoes) {
      const settlementEntry = await tx.walletEntry.create({
        data: {
          walletId,
          type: 'DEBT_SETTLEMENT',
          amountCents: -alocacao.amountCents,
          balanceAfterCents: saldoRodando - alocacao.amountCents,
          referenceType: 'DEBT',
          referenceId: alocacao.debtId,
          description: `Quitação automática da dívida ${alocacao.debtId} — recarga Pix ${paymentIntentId}`,
        },
      })
      await tx.debt.update({
        where: { id: alocacao.debtId },
        data: { status: 'SETTLED', settledAt: new Date(), settledByWalletEntryId: settlementEntry.id },
      })
      saldoRodando -= alocacao.amountCents
    }

    await tx.paymentIntent.update({
      where: { id: paymentIntentId },
      data: { status: 'PAID', amountCapturedCents: totalCents, capturedAt: new Date(), returnCode: consulta.returnCode },
    })

    // FAIL-CLOSED (Órion, recomendação 4 — mesma regra do ajuste manual de
    // saldo em `walletLedger.ts`): se a auditoria não gravar, a transação
    // INTEIRA desfaz e nada é creditado. Dinheiro sem rastro não é aceitável
    // mesmo vindo de um processo automático.
    await writeAuditLog(
      {
        actorUserId: SYSTEM_ACTOR.userId,
        actorRole: 'SYSTEM',
        actorEmail: SYSTEM_ACTOR.email,
        actorName: SYSTEM_ACTOR.name,
        actorOperatorId: null,
        action: 'PAYMENT_CREDIT',
        actionDetail: `Recarga Pix confirmada — ${topupEntry.id}`,
        outcome: 'SUCCESS',
        entityType: 'PaymentIntent',
        entityId: paymentIntentId,
        targetOperatorId: intent.operatorId ?? null,
        changes: { amountCents: { to: totalCents }, debtSettledCents: { to: totalAlocadoCents } },
      },
      tx,
    )

    return {
      paymentIntentId,
      userId: locked.userId,
      balanceAfterCents: saldoRodando,
      debtSettledCents: totalAlocadoCents,
      totalCreditedCents: totalCents,
      status: 'PAID' as const,
    }
  })

  if (resultado) {
    logger.info({ ...resultado }, '[creditarTopupPix] recarga Pix creditada')
    // L1.6 — comprovante por e-mail, DEPOIS do commit e fire-and-forget (idempotente por intent: webhook duplicado, polling e varredor nunca mandam 2).
    notificarRecargaDeSaldoCreditada({ userId: resultado.userId, paymentIntentId: resultado.paymentIntentId, creditadoCents: resultado.totalCreditedCents, quitouDividaCents: resultado.debtSettledCents, saldoCents: resultado.balanceAfterCents })
    await cacheTopupDebtSettledCents(paymentIntentId, resultado.debtSettledCents).catch((err) =>
      logger.error({ err, paymentIntentId }, '[creditarTopupPix] falha ao cachear debtSettledCents (não bloqueante)'),
    )
  }

  return resultado
}
