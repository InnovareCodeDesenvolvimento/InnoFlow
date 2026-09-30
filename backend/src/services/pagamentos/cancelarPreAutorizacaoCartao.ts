import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { getPagamentoPort } from './pagamentoPortInstance'

/**
 * Cancela (VOID) uma pré-autorização de cartão que nunca vai virar cobrança
 * de verdade — três chamadores (F5.4, 2026-09-30):
 *   1. `iniciarSessaoRemota.ts` — `RemoteStartTransaction` rejeitado/falhou
 *      pelo carregador, na hora.
 *   2. `finalizarSessao.ts` (via `prepararFechamentoCartao`) — sessão que
 *      fechou sem consumir nada (`totalCostCents <= 0`).
 *   3. `varrerPreAutorizacoesCartao.ts` — pré-auth AUTHORIZED sem sessão
 *      vinculada há mais de `CARD_PREAUTH_ABANDON_MINUTES` (rede de
 *      segurança: nenhum StartTransaction nunca chegou).
 *
 * Idempotente: se o intent já não estiver mais `AUTHORIZED` (resolvido por
 * outro caminho concorrente), não faz nada. A chamada de rede acontece FORA
 * de qualquer transação de banco (mesmo espírito de `creditarTopupPix.ts`);
 * só o resultado é gravado dentro de uma transação curta, com lock.
 */
export async function cancelarPreAutorizacaoCartao(paymentIntentId: string, pagamentoPort: PagamentoPort = getPagamentoPort()): Promise<void> {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: paymentIntentId } })
  if (!intent) {
    logger.error({ paymentIntentId }, '[cancelarPreAutorizacaoCartao] PaymentIntent não encontrado — nada a cancelar')
    return
  }
  if (intent.status !== 'AUTHORIZED') {
    return // idempotente — já resolvido por outro caminho
  }
  if (!intent.cieloPaymentId) {
    logger.error({ paymentIntentId }, '[cancelarPreAutorizacaoCartao] intent AUTHORIZED sem cieloPaymentId — não deveria acontecer')
    return
  }

  let resultado
  try {
    resultado = await pagamentoPort.cancelar(intent.cieloPaymentId)
  } catch (err) {
    // Não muda nada local — o varredor periódico (`varrerPreAutorizacoesCartao`)
    // tenta de novo na próxima rodada. Nunca repete a chamada às cegas fora
    // do fluxo do varredor (API 3.0 sem chave de idempotência).
    logger.error({ err, paymentIntentId }, '[cancelarPreAutorizacaoCartao] falha ao cancelar na Cielo — tentando de novo na próxima varredura')
    return
  }

  await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string; status: string; authTokenId: string | null }[]>(
      Prisma.sql`SELECT id, status, "authTokenId" FROM "PaymentIntent" WHERE id = ${paymentIntentId} FOR UPDATE`,
    )
    const locked = lockedRows[0]
    if (!locked || locked.status !== 'AUTHORIZED') return // corrida: outro caminho já resolveu entre a checagem de fora e este lock

    await tx.paymentIntent.update({ where: { id: paymentIntentId }, data: { status: 'VOIDED', returnCode: resultado.returnCode, cancelledAt: new Date() } })
    if (locked.authTokenId) {
      // idTag virtual não pode mais ser usado para abrir uma sessão (a
      // pré-autorização que o sustentava não existe mais) — mesma semântica
      // de `AuthTokenStatus.EXPIRED` já usada no resto do projeto.
      await tx.authToken.update({ where: { id: locked.authTokenId }, data: { status: 'EXPIRED' } })
    }
  })

  logger.info({ paymentIntentId }, '[cancelarPreAutorizacaoCartao] pré-autorização cancelada (VOIDED)')
}
