import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { getPagamentoPort } from './pagamentoPortInstance'
import { cancelarPreAutorizacaoCartao } from './cancelarPreAutorizacaoCartao'

/**
 * Rede de segurança das pré-autorizações de cartão (F5.4, 2026-09-30) — sem
 * tabela de outbox, mesmo espírito de `varrerTopupsPixExpirados.ts`. Três
 * casos, todos limitados a um lote por rodada (evita segurar o worker numa
 * varredura gigante):
 *
 * A) AUTHORIZED sem `chargingSessionId` há mais de `CARD_PREAUTH_ABANDON_MINUTES`
 *    — `RemoteStartTransaction` nunca virou `StartTransaction` de verdade
 *    (carregador nunca confirmou, ou o motorista desistiu no meio do
 *    caminho). Cancela (VOIDED) via `cancelarPreAutorizacaoCartao`.
 * B) CREATED há mais de `CARD_PREAUTH_ABANDON_MINUTES` — `autorizar()` deu
 *    timeout/erro de rede na hora (`iniciarSessaoRemota.ts` já devolveu 503
 *    pro motorista, sem nunca emitir idTag). Reconsulta por `merchantOrderId`
 *    (= o próprio id do intent — API 3.0 sem chave de idempotência, NUNCA
 *    repetir o POST original às cegas): se a Cielo autorizou mesmo assim,
 *    ninguém pode consumir essa autorização (idTag nunca existiu) — cancela
 *    na hora. Se negou/falhou/cancelou, só espelha o status. Se a Cielo não
 *    tem registro nenhum, desiste (FAILED) depois de 3x o horizonte de
 *    abandono (dá tempo de mais reconsultas antes de desistir de vez).
 * C) CAPTURE_PENDING há mais de 24h — só ALERTA em log (não é erro
 *    automático: a Cielo pode levar até 5 dias úteis para capturar, mesma
 *    ressalva documentada na F5.2 para o Pix).
 */

const BATCH_SIZE = 50

export interface VarrerPreAutorizacoesCartaoResultado {
  canceladasAbandonadas: number
  resolvidasCreated: number
  alertasCapturePending: number
}

export async function varrerPreAutorizacoesCartao(pagamentoPort: PagamentoPort = getPagamentoPort()): Promise<VarrerPreAutorizacoesCartaoResultado> {
  const agora = new Date()
  const limiteAbandono = new Date(agora.getTime() - env.CARD_PREAUTH_ABANDON_MINUTES * 60_000)
  const limiteDesistencia = new Date(agora.getTime() - env.CARD_PREAUTH_ABANDON_MINUTES * 60_000 * 3)
  const limiteAlertaCapturePending = new Date(agora.getTime() - 24 * 60 * 60_000)

  let canceladasAbandonadas = 0
  let resolvidasCreated = 0

  // A) AUTHORIZED abandonada (sem sessão vinculada)
  const abandonadas = await prisma.paymentIntent.findMany({
    where: { purpose: 'SESSION_CARD_CAPTURE', status: 'AUTHORIZED', chargingSessionId: null, authorizedAt: { lt: limiteAbandono } },
    take: BATCH_SIZE,
  })
  for (const intent of abandonadas) {
    try {
      await cancelarPreAutorizacaoCartao(intent.id, pagamentoPort)
      canceladasAbandonadas++
    } catch (err) {
      logger.error({ err, intentId: intent.id }, '[varrerPreAutorizacoesCartao] falha ao cancelar pré-autorização abandonada — tentando de novo na próxima rodada')
    }
  }

  // B) CREATED nunca resolvidos (timeout/erro na chamada original de autorizar())
  const pendentesCriacao = await prisma.paymentIntent.findMany({
    where: { purpose: 'SESSION_CARD_CAPTURE', status: 'CREATED', createdAt: { lt: limiteAbandono } },
    take: BATCH_SIZE,
  })
  for (const intent of pendentesCriacao) {
    try {
      const consulta = await pagamentoPort.consultarPorPedido(intent.id)

      if (!consulta) {
        if (intent.createdAt < limiteDesistencia) {
          const atualizado = await prisma.paymentIntent.updateMany({
            where: { id: intent.id, status: 'CREATED' },
            data: { status: 'FAILED', failureReason: 'Sem resposta da Cielo após reconciliação — desistindo.' },
          })
          if (atualizado.count > 0) resolvidasCreated++
        }
        continue
      }

      if (consulta.status === 'AUTHORIZED') {
        // A Cielo autorizou, mas o nosso lado nunca chegou a criar o idTag
        // virtual (senão o intent já estaria AUTHORIZED, não CREATED) —
        // ninguém pode consumir esta pré-autorização. Reflete o
        // providerPaymentId ANTES de cancelar (senão cancelarPreAutorizacaoCartao
        // não encontra o que chamar na Cielo).
        const atualizado = await prisma.paymentIntent.updateMany({
          where: { id: intent.id, status: 'CREATED' },
          data: {
            status: 'AUTHORIZED',
            cieloPaymentId: consulta.providerPaymentId || null,
            returnCode: consulta.returnCode,
            amountAuthorizedCents: consulta.amountAuthorizedCents,
            authorizedAt: new Date(),
          },
        })
        if (atualizado.count > 0) {
          await cancelarPreAutorizacaoCartao(intent.id, pagamentoPort)
          resolvidasCreated++
        }
        continue
      }

      if (consulta.status === 'CAPTURED' || consulta.status === 'FAILED' || consulta.status === 'VOIDED') {
        const atualizado = await prisma.paymentIntent.updateMany({
          where: { id: intent.id, status: 'CREATED' },
          data: { status: consulta.status, cieloPaymentId: consulta.providerPaymentId || null, returnCode: consulta.returnCode },
        })
        if (atualizado.count > 0) resolvidasCreated++
      }
      // CREATED (a Cielo ainda não processou) — nada a fazer, tenta de novo na próxima rodada.
    } catch (err) {
      logger.error({ err, intentId: intent.id }, '[varrerPreAutorizacoesCartao] falha ao reconsultar intent CREATED — tentando de novo na próxima rodada')
    }
  }

  // C) CAPTURE_PENDING antigo demais — só alerta.
  const capturePendingAntigos = await prisma.paymentIntent.count({
    where: { purpose: 'SESSION_CARD_CAPTURE', status: 'CAPTURE_PENDING', updatedAt: { lt: limiteAlertaCapturePending } },
  })
  if (capturePendingAntigos > 0) {
    logger.warn({ capturePendingAntigos }, '[varrerPreAutorizacoesCartao] intents CAPTURE_PENDING há mais de 24h — investigar manualmente (Cielo pode levar até 5 dias úteis para capturar)')
  }

  if (canceladasAbandonadas > 0 || resolvidasCreated > 0 || capturePendingAntigos > 0) {
    logger.info({ canceladasAbandonadas, resolvidasCreated, alertasCapturePending: capturePendingAntigos }, '[varrerPreAutorizacoesCartao] rodada concluída')
  }

  return { canceladasAbandonadas, resolvidasCreated, alertasCapturePending: capturePendingAntigos }
}
