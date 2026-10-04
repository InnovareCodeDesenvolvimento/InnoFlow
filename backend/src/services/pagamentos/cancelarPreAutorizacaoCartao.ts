import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { getPagamentoPort } from './pagamentoPortInstance'
import { ambienteDoIntentConfere } from './ambienteDoIntent'

/**
 * Cancela (VOID) uma pré-autorização de cartão que nunca vai virar cobrança
 * de verdade — três chamadores (F5.4, 2026-09-30):
 *   1. `iniciarSessaoRemota.ts` — `RemoteStartTransaction` rejeitado/falhou
 *      pelo carregador, na hora.
 *   2. `finalizarSessao.ts` (via `prepararFechamentoCartao`) — sessão que
 *      fechou sem consumir nada (`totalCostCents <= 0`).
 *   3. `varrerPreAutorizacoesCartao.ts` caso A — pré-auth AUTHORIZED sem
 *      sessão vinculada (RemoteStart nunca confirmado) OU com sessão
 *      vinculada mas já STOPPED (chamador 2 rodou, mas a chamada de rede
 *      pós-commit falhou — GAP B do handoff F5.4, Íris 2026-09-30: antes só
 *      o primeiro caso era coberto, um intent "preso" `AUTHORIZED` com
 *      `chargingSessionId` preenchido nunca era resolvido).
 *
 * Idempotente: se o intent já não estiver mais `AUTHORIZED` (resolvido por
 * outro caminho concorrente), não faz nada. A chamada de rede acontece FORA
 * de qualquer transação de banco (mesmo espírito de `creditarTopupPix.ts`);
 * só o resultado é gravado dentro de uma transação curta, com lock.
 */
export async function cancelarPreAutorizacaoCartao(paymentIntentId: string, pagamentoPortInjetado?: PagamentoPort): Promise<boolean> {
  const pagamentoPort = pagamentoPortInjetado ?? (await getPagamentoPort())
  const intent = await prisma.paymentIntent.findUnique({ where: { id: paymentIntentId } })
  if (!intent) {
    logger.error({ paymentIntentId }, '[cancelarPreAutorizacaoCartao] PaymentIntent não encontrado — nada a cancelar')
    return false
  }
  if (intent.status !== 'AUTHORIZED') {
    return false // idempotente — já resolvido por outro caminho
  }
  if (!intent.cieloPaymentId) {
    logger.error({ paymentIntentId }, '[cancelarPreAutorizacaoCartao] intent AUTHORIZED sem cieloPaymentId — não deveria acontecer')
    return false
  }

  // F5.7 (M4d): intent de OUTRO ambiente que o gateway efetivo => NÃO chama a Cielo (host errado) e NÃO muda nada local; o alerta já foi logado.
  // Fica AUTHORIZED até o ambiente voltar (o varredor tenta de novo e cai aqui de novo, em silêncio — o alerta é limitado a 1 por 10 min por intent).
  if (!(await ambienteDoIntentConfere(intent, 'cancelarPreAutorizacaoCartao'))) return false

  // F20/F19 (C2.2/C2.3): a Cielo não tem chave de idempotência e um void repetido sobre uma venda já cancelada volta como RECUSA ("status não permite"). Por isso
  // CONSULTA antes de cancelar: (a) já VOIDED lá (o void anterior pegou e a resposta/commit se perdeu) => só espelha, sem nova chamada; (b) CAPTURED lá => NUNCA
  // cancelar (seria estornar dinheiro que a captura já cobrou) — alerta e deixa para revisão manual. Consulta que falha => nada muda, o varredor repete.
  let remoto
  try {
    remoto = await pagamentoPort.consultar(intent.cieloPaymentId)
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), paymentIntentId }, '[cancelarPreAutorizacaoCartao] falha ao consultar a venda na Cielo antes de cancelar — tentando de novo na próxima varredura')
    return false
  }
  if (remoto.status === 'CAPTURED') {
    logger.error({ alert: 'payment_void_skipped_already_captured', paymentIntentId }, '[cancelarPreAutorizacaoCartao] a Cielo diz que esta venda já foi CAPTURADA — NÃO cancelo (seria estorno do que foi cobrado); conferir à mão')
    return false
  }

  let returnCode: string | null
  if (remoto.status === 'VOIDED') {
    returnCode = remoto.returnCode // já cancelada/estornada lá: só espelha o nosso lado
  } else {
    let resultado
    try {
      resultado = await pagamentoPort.cancelar(intent.cieloPaymentId)
    } catch (err) {
      // Não muda nada local — o varredor periódico (`varrerPreAutorizacoesCartao`) tenta de novo na próxima rodada (e a consulta acima evita repetir um void que já pegou).
      logger.error({ err, paymentIntentId }, '[cancelarPreAutorizacaoCartao] falha ao cancelar na Cielo — tentando de novo na próxima varredura')
      return false
    }

    // F19: só um cancelamento CONFIRMADO (ReturnCode 0/00/9 E Status 10/11) muda o intent para VOIDED. Os demais desfechos NÃO provam nada: o intent segue
    // AUTHORIZED (coberto pelo varredor) e o plantão é avisado — antes, QUALQUER resposta HTTP 200 do void virava VOIDED e liberava o idTag.
    if (resultado.desfecho !== 'CONFIRMADO') {
      const campos = { paymentIntentId, returnCode: resultado.returnCode, desfecho: resultado.desfecho }
      if (resultado.desfecho === 'RECUSADO') {
        logger.error({ alert: 'payment_void_refused', ...campos }, '[cancelarPreAutorizacaoCartao] a Cielo RECUSOU o cancelamento em definitivo — não vou repetir às cegas; conferir/estornar à mão')
        if (resultado.restricaoCadastral) {
          logger.error({ alert: 'payment_gateway_account_restriction', paymentIntentId, returnCode: resultado.returnCode }, '[cielo] restrição CADASTRAL da conta (ReturnCode 103–107): problema do estabelecimento, falar com o suporte da Cielo')
        }
      } else if (resultado.desfecho === 'EM_ANDAMENTO') {
        logger.warn({ alert: 'payment_void_in_progress', ...campos }, '[cancelarPreAutorizacaoCartao] já existe um cancelamento em andamento na Cielo — nada gravado, a próxima varredura reconsulta')
      } else {
        logger.warn({ alert: 'payment_void_unconfirmed', ...campos }, '[cancelarPreAutorizacaoCartao] resposta do cancelamento sem os dois sinais de confirmação — nada gravado, a próxima varredura reconsulta')
      }
      return false
    }
    returnCode = resultado.returnCode
    logger.info({ paymentIntentId, reversao: resultado.reversao }, '[cancelarPreAutorizacaoCartao] cancelamento confirmado pela Cielo')
  }

  let atualizado = false
  await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string; status: string; authTokenId: string | null }[]>(
      Prisma.sql`SELECT id, status, "authTokenId" FROM "PaymentIntent" WHERE id = ${paymentIntentId} FOR UPDATE`,
    )
    const locked = lockedRows[0]
    if (!locked || locked.status !== 'AUTHORIZED') return // corrida: outro caminho já resolveu entre a checagem de fora e este lock

    await tx.paymentIntent.update({ where: { id: paymentIntentId }, data: { status: 'VOIDED', returnCode, cancelledAt: new Date() } })
    if (locked.authTokenId) {
      // idTag virtual não pode mais ser usado para abrir uma sessão (a
      // pré-autorização que o sustentava não existe mais) — mesma semântica
      // de `AuthTokenStatus.EXPIRED` já usada no resto do projeto.
      await tx.authToken.update({ where: { id: locked.authTokenId }, data: { status: 'EXPIRED' } })
    }
    atualizado = true
  })

  if (atualizado) logger.info({ paymentIntentId }, '[cancelarPreAutorizacaoCartao] pré-autorização cancelada (VOIDED)')
  return atualizado
}
