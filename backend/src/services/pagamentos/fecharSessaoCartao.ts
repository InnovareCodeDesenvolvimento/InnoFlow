import type { Prisma } from '@prisma/client'
import { logger } from '../../lib/logger'

/**
 * Decide o que fazer com a pré-autorização de cartão de uma sessão CARD ao
 * fechar (`finalizarSessao.ts`, dentro da MESMA `$transaction` que grava
 * `status='STOPPED'`/custos) — SEM chamar a Cielo aqui dentro (rede não
 * entra em transação de banco, mesmo espírito de `creditarTopupPix.ts`: a
 * chamada de verdade acontece DEPOIS do commit, fora do lock). Esta função só
 * decide a AÇÃO e, quando aplicável, já grava `CAPTURE_PENDING` +
 * `captureAmountCents` (puramente local, sem I/O externo) — `finalizarSessao`
 * executa a ação de fato (enfileirar captura ou cancelar) depois do commit.
 *
 * Idempotente: se o intent não estiver mais `AUTHORIZED` (já resolvido por
 * outro caminho — reconciliação concorrente, retry), não faz nada.
 */
export interface PrepararFechamentoCartaoResultado {
  action: 'CAPTURE' | 'VOID' | 'NONE'
  paymentIntentId: string | null
}

export async function prepararFechamentoCartao(tx: Prisma.TransactionClient, sessionId: string, totalCostCents: number): Promise<PrepararFechamentoCartaoResultado> {
  const intent = await tx.paymentIntent.findFirst({ where: { chargingSessionId: sessionId, purpose: 'SESSION_CARD_CAPTURE' } })
  if (!intent) {
    logger.error({ sessionId }, '[prepararFechamentoCartao] sessão CARD sem PaymentIntent vinculado — não deveria acontecer (bug de dados), nada a fazer')
    return { action: 'NONE', paymentIntentId: null }
  }
  if (intent.status !== 'AUTHORIZED') {
    // Idempotência: já finalizado/cancelado por outro caminho (varredor,
    // retry do StopTransaction, reconciliação de sessão órfã reprocessada).
    return { action: 'NONE', paymentIntentId: intent.id }
  }

  if (totalCostCents <= 0) {
    // Recarga que não consumiu nada (ex.: EV desconectado na hora) — nunca
    // chega a CAPTURE_PENDING, cancela a pré-auth direto (VOIDED, fora desta
    // transação — ver `finalizarSessao.ts`).
    return { action: 'VOID', paymentIntentId: intent.id }
  }

  // captureAmountCents = valor-ALVO que MANDAMOS cobrar — min(consumo real,
  // autorizado). Não existe captura incremental na Cielo, então nunca
  // tentamos cobrar mais do que foi pré-autorizado.
  const captureAmountCents = Math.min(totalCostCents, intent.amountAuthorizedCents ?? totalCostCents)
  await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'CAPTURE_PENDING', captureAmountCents } })
  return { action: 'CAPTURE', paymentIntentId: intent.id }
}
