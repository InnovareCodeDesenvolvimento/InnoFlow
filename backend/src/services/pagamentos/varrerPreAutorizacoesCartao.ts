import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { getPagamentoPort } from './pagamentoPortInstance'
import { ambienteDoIntentConfere } from './ambienteDoIntent'
import { cancelarPreAutorizacaoCartao } from './cancelarPreAutorizacaoCartao'
import { identificadoresParaGravar } from '../../core/pagamentos/identificadoresAdquirente'

/**
 * Rede de segurança das pré-autorizações de cartão (F5.4, 2026-09-30) — sem
 * tabela de outbox, mesmo espírito de `varrerTopupsPixExpirados.ts`. Três
 * casos, todos limitados a um lote por rodada (evita segurar o worker numa
 * varredura gigante):
 *
 * A) AUTHORIZED há mais de `CARD_PREAUTH_ABANDON_MINUTES` E (sem
 *    `chargingSessionId` OU a sessão vinculada já está STOPPED). Dois
 *    sub-cenários cobertos pela MESMA query (GAP B do handoff de QA da
 *    Íris, 2026-09-30, unificado aqui em vez de virar um caso D separado):
 *      - `chargingSessionId IS NULL` — `RemoteStartTransaction` nunca virou
 *        `StartTransaction` de verdade (carregador nunca confirmou, ou o
 *        motorista desistiu no meio do caminho).
 *      - sessão vinculada já `STOPPED` — só acontece na prática quando a
 *        sessão fechou SEM consumo (`totalCostCents <= 0` -> ação VOID em
 *        `prepararFechamentoCartao`, que não muda o status do intent
 *        dentro da transação — ver `fecharSessaoCartao.ts`) e a chamada de
 *        rede pós-commit (`cancelarPreAutorizacaoCartao`, disparada por
 *        `finalizarSessao.ts` logo depois do commit) falhou (ex.: Cielo
 *        instável naquele instante). Sem este ramo, o intent ficava preso
 *        `AUTHORIZED` para sempre, sem rede de segurança nenhuma — o caso A
 *        original só olhava `chargingSessionId IS NULL`.
 *      SEM falso positivo: uma sessão CARD com intent AUTHORIZED e
 *      `chargingSessionId` preenchido cuja sessão ainda está EM ANDAMENTO
 *      (não STOPPED) é o caso NORMAL (carregando há mais de
 *      `CARD_PREAUTH_ABANDON_MINUTES`) — o filtro `chargingSession.status
 *      = 'STOPPED'` exclui esse caso explicitamente. E se a sessão
 *      consumiu algo (`totalCostCents > 0`), o intent já teria virado
 *      `CAPTURE_PENDING` na MESMA transação que marcou a sessão STOPPED —
 *      nunca fica `AUTHORIZED` nesse caminho, então este ramo só alcança
 *      exatamente o cenário VOID travado.
 *    Cancela (VOIDED) via `cancelarPreAutorizacaoCartao` nos dois casos.
 * B) CREATED há mais de `CARD_PREAUTH_ABANDON_MINUTES` — `autorizar()` deu
 *    timeout/erro de rede na hora (`iniciarSessaoRemota.ts` já devolveu 503
 *    pro motorista, sem nunca emitir idTag). Reconsulta por `merchantOrderId`
 *    (= o próprio id do intent — API 3.0 sem chave de idempotência, NUNCA
 *    repetir o POST original às cegas): se a Cielo autorizou mesmo assim,
 *    ninguém pode consumir essa autorização (idTag nunca existiu) — cancela
 *    na hora. Se negou/falhou/cancelou, só espelha o status. Se a Cielo não
 *    tem registro nenhum, desiste (FAILED) depois de 3x o horizonte de
 *    abandono (dá tempo de mais reconsultas antes de desistir de vez).
 * C) (REMOVIDO na F5.7) CAPTURE_PENDING antigo — antes só ALERTAVA após 24h, o que deixava a captura sem rede de
 *    segurança. Agora é `reenfileirarCapturasPendentes.ts` (reenfileira + alerta escalonado), chamado pelo MESMO job
 *    periódico (`worker/jobs/varrerPreAutorizacoesCartaoJob.ts`) — separado daqui porque precisa rodar MESMO com o gateway
 *    indisponível (só para alertar), enquanto os casos A/B precisam da Cielo.
 */

const BATCH_SIZE = 50

export interface VarrerPreAutorizacoesCartaoResultado {
  canceladasAbandonadas: number
  resolvidasCreated: number
}

export async function varrerPreAutorizacoesCartao(pagamentoPortInjetado?: PagamentoPort): Promise<VarrerPreAutorizacoesCartaoResultado> {
  const pagamentoPort = pagamentoPortInjetado ?? (await getPagamentoPort())
  const agora = new Date()
  const limiteAbandono = new Date(agora.getTime() - env.CARD_PREAUTH_ABANDON_MINUTES * 60_000)
  const limiteDesistencia = new Date(agora.getTime() - env.CARD_PREAUTH_ABANDON_MINUTES * 60_000 * 3)

  let canceladasAbandonadas = 0
  let resolvidasCreated = 0

  // A) AUTHORIZED abandonada (sem sessão vinculada) OU "presa" (sessão
  // vinculada já STOPPED, cancelamento pós-commit nunca confirmado — ver
  // comentário do cabeçalho).
  const abandonadas = await prisma.paymentIntent.findMany({
    where: {
      purpose: 'SESSION_CARD_CAPTURE',
      status: 'AUTHORIZED',
      authorizedAt: { lt: limiteAbandono },
      OR: [{ chargingSessionId: null }, { chargingSession: { status: 'STOPPED' } }],
    },
    take: BATCH_SIZE,
  })
  for (const intent of abandonadas) {
    try {
      // F5.7 (M4d): intent de OUTRO ambiente => pula (nem chama a Cielo nem conta como cancelada).
      if (!(await ambienteDoIntentConfere(intent, 'varrerPreAutorizacoesCartao:abandonada'))) continue
      // Só conta quando o intent realmente virou VOIDED nesta chamada (cancelamento em andamento/recusado/indefinido NÃO conta — segue AUTHORIZED).
      if (await cancelarPreAutorizacaoCartao(intent.id, pagamentoPort)) canceladasAbandonadas++
    } catch (err) {
      logger.error({ err, intentId: intent.id }, '[varrerPreAutorizacoesCartao] falha ao cancelar pré-autorização abandonada/presa — tentando de novo na próxima rodada')
    }
  }

  // B) CREATED nunca resolvidos (timeout/erro na chamada original de autorizar())
  const pendentesCriacao = await prisma.paymentIntent.findMany({
    where: { purpose: 'SESSION_CARD_CAPTURE', status: 'CREATED', createdAt: { lt: limiteAbandono } },
    take: BATCH_SIZE,
  })
  for (const intent of pendentesCriacao) {
    try {
      // F5.7 (M4d): intent de OUTRO ambiente => NÃO reconsulta (host errado) e NÃO desiste (FAILED por "sem resposta" seria decidir sobre um erro nosso).
      if (!(await ambienteDoIntentConfere(intent, 'varrerPreAutorizacoesCartao:created'))) continue

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
            ...identificadoresParaGravar(consulta.identificadores),
          },
        })
        if (atualizado.count > 0) {
          await cancelarPreAutorizacaoCartao(intent.id, pagamentoPort)
          resolvidasCreated++ // espelhado AUTHORIZED; se o cancelamento não pegou, o caso A cancela nas próximas rodadas
        }
        continue
      }

      if (consulta.status === 'CAPTURED' || consulta.status === 'FAILED' || consulta.status === 'VOIDED') {
        const atualizado = await prisma.paymentIntent.updateMany({
          where: { id: intent.id, status: 'CREATED' },
          data: { status: consulta.status, cieloPaymentId: consulta.providerPaymentId || null, returnCode: consulta.returnCode, ...identificadoresParaGravar(consulta.identificadores) },
        })
        if (atualizado.count > 0) resolvidasCreated++
      }
      // CREATED (a Cielo ainda não processou) — nada a fazer, tenta de novo na próxima rodada.
    } catch (err) {
      logger.error({ err, intentId: intent.id }, '[varrerPreAutorizacoesCartao] falha ao reconsultar intent CREATED — tentando de novo na próxima rodada')
    }
  }

  if (canceladasAbandonadas > 0 || resolvidasCreated > 0) {
    logger.info({ canceladasAbandonadas, resolvidasCreated }, '[varrerPreAutorizacoesCartao] rodada concluída')
  }

  return { canceladasAbandonadas, resolvidasCreated }
}
