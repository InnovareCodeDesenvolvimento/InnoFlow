import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import type { PagamentoPort, ResultadoCancelamento } from '../../core/pagamentos/porta'
import { getPagamentoPort } from './pagamentoPortInstance'
import { ambienteDoIntentConfere } from './ambienteDoIntent'
import {
  MAX_INDEFINIDOS_ATE_REVISAO,
  adquirirLockCancelamento,
  backoffSegundos,
  cancelamentoDeveEsperar,
  contarDesfechoNaoConfirmado,
  liberarLockCancelamento,
  pausarCancelamento,
  pararCancelamento,
  podeAlertar,
} from './controleCancelamentoPreAuth'

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

  // I-3: parada definitiva / backoff em curso => nem lock, nem Cielo. Evita a rajada de 1 consulta + 1 void por minuto por intent para sempre.
  const espera = await cancelamentoDeveEsperar(paymentIntentId)
  if (espera) {
    logger.debug({ paymentIntentId, espera }, '[cancelarPreAutorizacaoCartao] cancelamento em pausa — não chamo a Cielo agora')
    return false
  }

  // I-3: lock por intent (como a captura) — o varredor A e o `finalizarSessao` não cancelam o mesmo intent ao mesmo tempo. Redis fora => não cancela (o varredor repete).
  let tokenLock: string | null
  try {
    tokenLock = await adquirirLockCancelamento(paymentIntentId)
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), paymentIntentId }, '[cancelarPreAutorizacaoCartao] sem Redis para o lock do cancelamento — nada feito, o varredor repete')
    return false
  }
  if (tokenLock === null) {
    logger.info({ paymentIntentId }, '[cancelarPreAutorizacaoCartao] outro executor já está cancelando este intent — nada a fazer')
    return false
  }
  try {
    return await cancelarSobLock(paymentIntentId, intent.cieloPaymentId, pagamentoPort)
  } finally {
    await liberarLockCancelamento(paymentIntentId, tokenLock)
  }
}

async function cancelarSobLock(paymentIntentId: string, paymentId: string, pagamentoPort: PagamentoPort): Promise<boolean> {

  // F20/F19 (C2.2/C2.3): a Cielo não tem chave de idempotência e um void repetido sobre uma venda já cancelada volta como RECUSA ("status não permite"). Por isso
  // CONSULTA antes de cancelar: (a) já VOIDED lá (o void anterior pegou e a resposta/commit se perdeu) => só espelha, sem nova chamada; (b) CAPTURED lá => NUNCA
  // cancelar (seria estornar dinheiro que a captura já cobrou) — alerta e deixa para revisão manual; (c) FAILED lá (negada/abortada: não há autorização viva) => NÃO tenta void,
  // só espelha o estado (I-3). Consulta que falha => nada muda, o varredor repete.
  let remoto
  try {
    remoto = await pagamentoPort.consultar(paymentId)
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), paymentIntentId }, '[cancelarPreAutorizacaoCartao] falha ao consultar a venda na Cielo antes de cancelar — tentando de novo na próxima varredura')
    return false
  }
  if (remoto.status === 'CAPTURED') {
    logger.error({ alert: 'payment_void_skipped_already_captured', paymentIntentId, paymentId }, '[cancelarPreAutorizacaoCartao] a Cielo diz que esta venda já foi CAPTURADA — NÃO cancelo (seria estorno do que foi cobrado); conferir à mão')
    return false
  }
  if (remoto.status === 'FAILED') {
    const espelhou = await encerrarIntent(paymentIntentId, 'FAILED', remoto.returnCode, 'A Cielo informa que a venda não está autorizada (negada/abortada) — nada a cancelar.')
    if (espelhou) logger.warn({ paymentIntentId, paymentId, returnCode: remoto.returnCode }, '[cancelarPreAutorizacaoCartao] a Cielo informa venda negada/abortada — intent espelhado como FAILED, sem tentar void')
    return false
  }

  let returnCode: string | null
  if (remoto.status === 'VOIDED') {
    returnCode = remoto.returnCode // já cancelada/estornada lá: só espelha o nosso lado
  } else {
    let resultado
    try {
      resultado = await pagamentoPort.cancelar(paymentId)
    } catch (err) {
      // Não muda nada local — o varredor periódico (`varrerPreAutorizacoesCartao`) tenta de novo na próxima rodada (e a consulta acima evita repetir um void que já pegou).
      logger.error({ err, paymentIntentId }, '[cancelarPreAutorizacaoCartao] falha ao cancelar na Cielo — tentando de novo na próxima varredura')
      return false
    }

    // F19: só um cancelamento CONFIRMADO (ReturnCode 0/00/9 E Status 10/11) muda o intent para VOIDED. Os demais desfechos NÃO provam nada: o intent segue
    // AUTHORIZED (coberto pelo varredor, agora COM freio — I-3) e o plantão é avisado.
    if (resultado.desfecho !== 'CONFIRMADO') {
      await tratarDesfechoNaoConfirmado(paymentIntentId, paymentId, resultado)
      return false
    }
    returnCode = resultado.returnCode
    logger.info({ paymentIntentId, reversao: resultado.reversao }, '[cancelarPreAutorizacaoCartao] cancelamento confirmado pela Cielo')
  }

  const virou = await encerrarIntent(paymentIntentId, 'VOIDED', returnCode, null)
  if (virou) logger.info({ paymentIntentId }, '[cancelarPreAutorizacaoCartao] pré-autorização cancelada (VOIDED)')
  return virou
}

/**
 * I-3 — o que fazer com um void que a Cielo NÃO confirmou. Sem estado novo no banco: contador, backoff e parada em Redis (`controleCancelamentoPreAuth.ts`).
 *  - RECUSADO (40, 41, 53, 101, 103–107): definitivo. Alerta `payment_void_refused` (1x/h) + `payment_void_manual_review` (uma vez) e PARA de repetir. O intent fica `AUTHORIZED`
 *    — um estado `VOID_FAILED` exigiria enum novo (Cronos); a parada em Redis dura 30 dias e o alerta de revisão manual diz o PaymentId.
 *  - EM_ANDAMENTO (10, 223, 476): já existe um cancelamento andando; backoff crescente (1, 2, 4... até 60 min) e a próxima rodada CONSULTA (que verá VOIDED quando concluir).
 *  - INDEFINIDO: backoff igual; depois de `MAX_INDEFINIDOS_ATE_REVISAO` seguidos vira revisão manual e para.
 */
async function tratarDesfechoNaoConfirmado(paymentIntentId: string, paymentId: string, resultado: ResultadoCancelamento): Promise<void> {
  const tentativas = await contarDesfechoNaoConfirmado(paymentIntentId)
  const campos = { paymentIntentId, paymentId, returnCode: resultado.returnCode, desfecho: resultado.desfecho, tentativas }

  if (resultado.desfecho === 'RECUSADO') {
    if (await podeAlertar(paymentIntentId, 'refused')) {
      logger.error({ alert: 'payment_void_refused', ...campos }, '[cancelarPreAutorizacaoCartao] a Cielo RECUSOU o cancelamento em definitivo — parei de repetir; conferir/estornar à mão')
    }
    if (resultado.restricaoCadastral && (await podeAlertar(paymentIntentId, 'account_restriction'))) {
      logger.error({ alert: 'payment_gateway_account_restriction', paymentIntentId, paymentId, returnCode: resultado.returnCode }, '[cielo] restrição CADASTRAL da conta (ReturnCode 103–107): problema do estabelecimento, falar com o suporte da Cielo')
    }
    await pedirRevisaoManual(paymentIntentId, paymentId, resultado.returnCode, 'recusa definitiva do cancelamento')
    return
  }

  if (resultado.desfecho === 'INDEFINIDO' && tentativas >= MAX_INDEFINIDOS_ATE_REVISAO) {
    if (await podeAlertar(paymentIntentId, 'refused')) {
      logger.error({ alert: 'payment_void_refused', ...campos }, '[cancelarPreAutorizacaoCartao] o cancelamento segue sem confirmação depois de várias tentativas — parei de repetir; conferir à mão')
    }
    await pedirRevisaoManual(paymentIntentId, paymentId, resultado.returnCode, 'cancelamento indefinido repetido')
    return
  }

  const pausa = backoffSegundos(tentativas)
  await pausarCancelamento(paymentIntentId, pausa)
  const alerta = resultado.desfecho === 'EM_ANDAMENTO' ? 'payment_void_in_progress' : 'payment_void_unconfirmed'
  if (await podeAlertar(paymentIntentId, resultado.desfecho)) {
    const nivel = resultado.desfecho === 'EM_ANDAMENTO' ? 'já existe um cancelamento em andamento na Cielo' : 'resposta do cancelamento sem os dois sinais de confirmação'
    logger.warn({ alert: alerta, ...campos, proximaTentativaEmSegundos: pausa }, `[cancelarPreAutorizacaoCartao] ${nivel} — nada gravado, reconsulto depois do backoff`)
  }
}

async function pedirRevisaoManual(paymentIntentId: string, paymentId: string, returnCode: string | null, motivo: string): Promise<void> {
  await pararCancelamento(paymentIntentId)
  if (await podeAlertar(paymentIntentId, 'manual_review', 30 * 24 * 3600)) {
    logger.error({ alert: 'payment_void_manual_review', paymentIntentId, paymentId, returnCode, motivo }, '[cancelarPreAutorizacaoCartao] REVISÃO MANUAL: pré-autorização que não consigo cancelar — o intent segue AUTHORIZED e o varredor parou de tentar (conferir a venda no Site Cielo)')
  }
}

/** Fecha o intent no nosso lado (AUTHORIZED -> `novoStatus`) sob lock de linha e expira o idTag virtual. `false` se outro caminho já o resolveu. */
async function encerrarIntent(paymentIntentId: string, novoStatus: 'VOIDED' | 'FAILED', returnCode: string | null, failureReason: string | null): Promise<boolean> {
  let atualizado = false
  await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string; status: string; authTokenId: string | null }[]>(
      Prisma.sql`SELECT id, status, "authTokenId" FROM "PaymentIntent" WHERE id = ${paymentIntentId} FOR UPDATE`,
    )
    const locked = lockedRows[0]
    if (!locked || locked.status !== 'AUTHORIZED') return // corrida: outro caminho já resolveu entre a checagem de fora e este lock

    await tx.paymentIntent.update({
      where: { id: paymentIntentId },
      data: novoStatus === 'VOIDED' ? { status: 'VOIDED', returnCode, cancelledAt: new Date() } : { status: 'FAILED', returnCode, failureReason },
    })
    if (locked.authTokenId) {
      // idTag virtual não pode mais ser usado para abrir uma sessão (a pré-autorização que o sustentava não existe mais) — mesma semântica de
      // `AuthTokenStatus.EXPIRED` já usada no resto do projeto.
      await tx.authToken.update({ where: { id: locked.authTokenId }, data: { status: 'EXPIRED' } })
    }
    atualizado = true
  })
  return atualizado
}
