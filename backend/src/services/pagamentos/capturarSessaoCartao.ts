import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { getPagamentoPort } from './pagamentoPortInstance'
import { createQueue, CAPTURAR_SESSAO_CARTAO_QUEUE_NAME, type CapturarSessaoCartaoJobData } from '../../worker/queues'

/**
 * Captura o valor-alvo (`captureAmountCents`, gravado por
 * `prepararFechamentoCartao` ao entrar em `CAPTURE_PENDING`) — chamada pelo
 * worker (`worker/jobs/capturarSessaoCartaoJob.ts`), nunca inline no
 * `StopTransaction`/`finalizarSessao` (rede não entra em transação de banco).
 *
 * ⚠️ A CONFIRMAR (sem sandbox real — mesma ressalva da F5.1/F5.2): a doc
 * consultada não confirma se `PUT /1/sales/{id}/capture` é seguro de
 * RETENTAR depois de já ter capturado (a Cielo documenta captura parcial
 * como "só pode acontecer uma vez", mas não é claro se um 2º PUT depois de
 * sucesso é idempotente ou dá erro). Por isso, ANTES de chamar `capturar()`,
 * sempre reconsultamos o status atual na Cielo (`consultar`) — se ela já diz
 * `CAPTURED`, usamos esse resultado direto e NUNCA chamamos `capturar()` de
 * novo. Isto cobre o cenário "nosso processo morreu entre o capturar() ter
 * sucesso e a transação local commitar, e o job foi reagendado".
 */
export interface CapturarSessaoCartaoResultado {
  paymentIntentId: string
  status: 'CAPTURED' | 'FAILED'
  amountCapturedCents: number
  debtId: string | null
  shortfallCents: number
}

/** A Cielo ainda não disse CAPTURED nem FAILED/VOIDED: lançar faz o job retentar sem decidir cobrança nenhuma (ver M1 abaixo). */
export class CapturaCartaoNaoDefinitivaError extends Error {
  constructor(
    readonly paymentIntentId: string,
    readonly statusCielo: string,
  ) {
    super(`captura do intent ${paymentIntentId} sem resultado definitivo (status ${statusCielo}) — reconsultar`)
    this.name = 'CapturaCartaoNaoDefinitivaError'
  }
}

export async function capturarSessaoCartao(paymentIntentId: string, pagamentoPortInjetado?: PagamentoPort): Promise<CapturarSessaoCartaoResultado | null> {
  const pagamentoPort = pagamentoPortInjetado ?? (await getPagamentoPort())
  const intent = await prisma.paymentIntent.findUnique({ where: { id: paymentIntentId } })
  if (!intent) {
    logger.error({ paymentIntentId }, '[capturarSessaoCartao] PaymentIntent não encontrado — nada a capturar')
    return null
  }
  if (intent.purpose !== 'SESSION_CARD_CAPTURE') {
    logger.error({ paymentIntentId, purpose: intent.purpose }, '[capturarSessaoCartao] PaymentIntent não é SESSION_CARD_CAPTURE — bug de programação de quem enfileirou este job')
    return null
  }
  if (intent.status === 'CAPTURED' || intent.status === 'FAILED') {
    return null // já processado (idempotência de alto nível — job reentregue)
  }
  if (intent.status !== 'CAPTURE_PENDING') {
    logger.warn({ paymentIntentId, status: intent.status }, '[capturarSessaoCartao] intent não está CAPTURE_PENDING — nada a fazer neste estado')
    return null
  }
  if (!intent.cieloPaymentId || intent.captureAmountCents == null || !intent.chargingSessionId) {
    logger.error({ paymentIntentId }, '[capturarSessaoCartao] invariantes quebradas (cieloPaymentId/captureAmountCents/chargingSessionId ausentes) — bug de dados anterior')
    return null
  }

  // Reconsulta ANTES de capturar (ver ressalva "a confirmar" acima) — nunca
  // chama capturar() se a Cielo já diz CAPTURED.
  const consultaAtual = await pagamentoPort.consultar(intent.cieloPaymentId)
  const resultadoCaptura =
    consultaAtual.status === 'CAPTURED'
      ? { status: 'CAPTURED' as const, returnCode: consultaAtual.returnCode, amountCapturedCents: consultaAtual.amountCapturedCents }
      : consultaAtual.status === 'AUTHORIZED'
        ? await pagamentoPort.capturar(intent.cieloPaymentId, intent.captureAmountCents)
        : { status: consultaAtual.status, returnCode: consultaAtual.returnCode, amountCapturedCents: consultaAtual.amountCapturedCents }

  // F5.7 (M1, achado do Órion): SÓ um resultado DEFINITIVO decide a cobrança. CAPTURED = cobrou; FAILED/VOIDED =
  // a Cielo disse que NÃO cobrou e não vai cobrar (negado, cancelado/expirado) — único caso que vira dívida.
  // QUALQUER outro status (CREATED = o `PENDING` da Cielo mapeado pelo adaptador, AUTHORIZED = a captura ainda
  // não pegou, CAPTURE_PENDING, ou um valor que não conhecemos) é TRANSITÓRIO: a captura pode concluir DEPOIS.
  // Antes isto caía no ramo "falhou": FAILED + dívida de 100%, e quando a Cielo concluía a captura o motorista
  // pagava duas vezes (cartão + dívida). Agora LANÇA: o intent segue CAPTURE_PENDING, o job retenta (e o varredor
  // reenfileira), e a próxima volta RECONSULTA antes de qualquer decisão.
  if (resultadoCaptura.status !== 'CAPTURED' && resultadoCaptura.status !== 'FAILED' && resultadoCaptura.status !== 'VOIDED') {
    logger.warn(
      { paymentIntentId, statusCielo: resultadoCaptura.status, returnCode: resultadoCaptura.returnCode },
      '[capturarSessaoCartao] Cielo devolveu status NÃO definitivo para a captura — nada gravado, será reconsultado',
    )
    throw new CapturaCartaoNaoDefinitivaError(paymentIntentId, resultadoCaptura.status)
  }

  return prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string; status: string; chargingSessionId: string | null }[]>(
      Prisma.sql`SELECT id, status, "chargingSessionId" FROM "PaymentIntent" WHERE id = ${paymentIntentId} FOR UPDATE`,
    )
    const locked = lockedRows[0]
    if (!locked || locked.status !== 'CAPTURE_PENDING' || !locked.chargingSessionId) return null // corrida: outro disparo já processou

    const session = await tx.chargingSession.findUniqueOrThrow({
      where: { id: locked.chargingSessionId },
      select: { id: true, userId: true, operatorId: true, totalCostCents: true },
    })
    const totalCostCents = session.totalCostCents ?? 0

    if (resultadoCaptura.status === 'CAPTURED') {
      const amountCapturedCents = resultadoCaptura.amountCapturedCents ?? intent.captureAmountCents!
      await tx.paymentIntent.update({
        where: { id: paymentIntentId },
        data: { status: 'CAPTURED', amountCapturedCents, returnCode: resultadoCaptura.returnCode, capturedAt: new Date() },
      })

      const shortfallCents = Math.max(0, totalCostCents - amountCapturedCents)
      let debtId: string | null = null
      if (shortfallCents > 0) {
        // Captura parcial (autorizado cobria menos que o consumo final, ou a
        // Cielo confirmou menos do que pedimos) — mesma regra de dívida que
        // WALLET já usa quando o saldo não cobre tudo (`walletLedger.ts`).
        const debt = await tx.debt.create({
          data: { userId: session.userId, operatorId: session.operatorId, chargingSessionId: session.id, paymentIntentId, amountCents: shortfallCents, status: 'OPEN', reason: 'CARD_CAPTURE_SHORTFALL' },
        })
        debtId = debt.id
      }
      logger.info({ paymentIntentId, amountCapturedCents, shortfallCents, debtId }, '[capturarSessaoCartao] captura confirmada')
      return { paymentIntentId, status: 'CAPTURED' as const, amountCapturedCents, debtId, shortfallCents }
    }

    // Falha/negação/voided na captura — nada foi cobrado, tudo vira dívida.
    await tx.paymentIntent.update({
      where: { id: paymentIntentId },
      data: { status: 'FAILED', returnCode: resultadoCaptura.returnCode, failureReason: 'Falha ao capturar o valor autorizado no cartão.' },
    })
    let debtId: string | null = null
    if (totalCostCents > 0) {
      const debt = await tx.debt.create({
        data: { userId: session.userId, operatorId: session.operatorId, chargingSessionId: session.id, paymentIntentId, amountCents: totalCostCents, status: 'OPEN', reason: 'CARD_CAPTURE_FAILED' },
      })
      debtId = debt.id
    }
    logger.warn({ paymentIntentId, totalCostCents, debtId }, '[capturarSessaoCartao] captura falhou — dívida integral criada')
    return { paymentIntentId, status: 'FAILED' as const, amountCapturedCents: 0, debtId, shortfallCents: totalCostCents }
  })
}

/** Enfileira a captura — chamado por `finalizarSessao.ts` DEPOIS do commit (mesmo padrão de `enqueueLiquidarSessaoRetry`). */
export async function enqueueCapturarSessaoCartao(paymentIntentId: string): Promise<void> {
  const queue = createQueue(CAPTURAR_SESSAO_CARTAO_QUEUE_NAME)
  try {
    const jobData: CapturarSessaoCartaoJobData = { paymentIntentId }
    await queue.add('capturar', jobData, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    })
  } finally {
    await queue.close()
  }
}
