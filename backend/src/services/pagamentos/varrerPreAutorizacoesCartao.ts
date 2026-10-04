import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { redis } from '../../lib/redis'
import { incrWithTtl } from '../../lib/redisCounter'
import { withDeadline } from '../../lib/withDeadline'
import type { PagamentoPort, ResultadoConsultaPagamento } from '../../core/pagamentos/porta'
import { getPagamentoPort } from './pagamentoPortInstance'
import { ambienteDoIntentConfere } from './ambienteDoIntent'
import { cancelarPreAutorizacaoCartao } from './cancelarPreAutorizacaoCartao'
import { cancelamentoDeveEsperar } from './controleCancelamentoPreAuth'
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
/** Teto de páginas por rodada: intents que o freio (parada/backoff) pula não gastam o lote, mas a rodada nunca vira uma varredura infinita. */
const MAX_PAGINAS = 6
/** Reconsultas de um intent CREATED sem resposta definitiva antes de tratá-lo como autorização possivelmente VIVA e cancelar por precaução (além do limite de idade). */
export const MAX_TENTATIVAS_CREATED = 30
/** `returnCode` gravado quando a Cielo respondeu Status 1 SEM ReturnCode (a CHECK do banco exige não nulo em AUTHORIZED). */
export const RETURN_CODE_NAO_INFORMADO = 'NAO_INFORMADO'
const TTL_TENTATIVAS_SEG = 7 * 24 * 3600
const PRAZO_REDIS_MS = 3_000

export interface VarrerPreAutorizacoesCartaoResultado {
  canceladasAbandonadas: number
  resolvidasCreated: number
}

const chaveTentativasCreated = (intentId: string) => `card-preauth:created-sweeps:${intentId}`

/** Conta mais uma reconsulta deste intent CREATED. Redis fora => 1 (o limite de IDADE ainda vale; nunca bloqueia a varredura). */
async function contarTentativaCreated(intentId: string): Promise<number> {
  try {
    return await withDeadline(incrWithTtl(redis, chaveTentativasCreated(intentId), TTL_TENTATIVAS_SEG), PRAZO_REDIS_MS, 'contador do varredor B')
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), intentId }, '[varrerPreAutorizacoesCartao] sem Redis para contar tentativas — sigo só pelo limite de idade')
    return 1
  }
}

export async function varrerPreAutorizacoesCartao(pagamentoPortInjetado?: PagamentoPort): Promise<VarrerPreAutorizacoesCartaoResultado> {
  const pagamentoPort = pagamentoPortInjetado ?? (await getPagamentoPort())
  const agora = new Date()
  const limiteAbandono = new Date(agora.getTime() - env.CARD_PREAUTH_ABANDON_MINUTES * 60_000)
  const limiteDesistencia = new Date(agora.getTime() - env.CARD_PREAUTH_ABANDON_MINUTES * 60_000 * 3)

  let canceladasAbandonadas = 0
  let resolvidasCreated = 0

  // A) AUTHORIZED abandonada (sem sessão vinculada) OU "presa" (sessão vinculada já STOPPED, cancelamento pós-commit nunca confirmado — ver comentário do cabeçalho).
  // MAIS ANTIGAS PRIMEIRO, paginado por cursor (id > último): intents que o freio do cancelamento (parada/backoff — I-3) manda esperar NÃO gastam o lote, então um
  // acúmulo de presos não deixa os novos sem vez; o cursor (e não `skip`) evita pular linha válida quando o laço muda o filtro.
  let processadasA = 0
  let cursorA: string | undefined
  for (let pagina = 0; pagina < MAX_PAGINAS && processadasA < BATCH_SIZE; pagina++) {
    const abandonadas = await prisma.paymentIntent.findMany({
      where: {
        purpose: 'SESSION_CARD_CAPTURE',
        status: 'AUTHORIZED',
        authorizedAt: { lt: limiteAbandono },
        OR: [{ chargingSessionId: null }, { chargingSession: { status: 'STOPPED' } }],
        ...(cursorA ? { id: { gt: cursorA } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    })
    if (abandonadas.length === 0) break
    cursorA = abandonadas[abandonadas.length - 1].id
    for (const intent of abandonadas) {
      try {
        // F5.7 (M4d): intent de OUTRO ambiente => pula (nem chama a Cielo nem conta como cancelada).
        if (!(await ambienteDoIntentConfere(intent, 'varrerPreAutorizacoesCartao:abandonada'))) continue
        if (await cancelamentoDeveEsperar(intent.id)) continue // I-3: parado/backoff — não gasta o lote
        processadasA++
        // Só conta quando o intent realmente virou VOIDED nesta chamada (cancelamento em andamento/recusado/indefinido NÃO conta — segue AUTHORIZED).
        if (await cancelarPreAutorizacaoCartao(intent.id, pagamentoPort)) canceladasAbandonadas++
      } catch (err) {
        logger.error({ err, intentId: intent.id }, '[varrerPreAutorizacoesCartao] falha ao cancelar pré-autorização abandonada/presa — tentando de novo na próxima rodada')
      }
    }
    if (abandonadas.length < BATCH_SIZE) break
  }

  // B) CREATED nunca resolvidos (timeout/erro/resposta não definitiva na chamada original de autorizar()). MAIS ANTIGOS PRIMEIRO (cursor por createdAt+id).
  //  - com `cieloPaymentId` no intent (a Cielo respondeu, só não era definitivo): `consultar(PaymentId)`; sem ele: `consultarPorPedido` (lista os PaymentId e consulta cada um — I-1);
  //  - resposta definitiva => espelha (AUTHORIZED => cancela, ninguém pode usar a autorização; negada/cancelada => só espelha);
  //  - resposta NÃO definitiva (Status 0/12, Status 1 com ReturnCode ausente/fora das tabelas — I-2): reconsulta a cada rodada ATÉ esgotar (idade > 3x abandono OU `MAX_TENTATIVAS_CREATED`
  //    reconsultas). Esgotado, trata como autorização possivelmente VIVA: espelha AUTHORIZED e cancela (a consulta antes do void decide). Nunca fica em "nada a fazer" para sempre.
  //  - sem registro algum na Cielo: desiste (FAILED) só depois de 3x o horizonte de abandono.
  let cursorB: { createdAt: Date; id: string } | undefined
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const pendentesCriacao = await prisma.paymentIntent.findMany({
      where: {
        purpose: 'SESSION_CARD_CAPTURE',
        status: 'CREATED',
        createdAt: { lt: limiteAbandono },
        ...(cursorB ? { OR: [{ createdAt: { gt: cursorB.createdAt } }, { createdAt: cursorB.createdAt, id: { gt: cursorB.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
    })
    if (pendentesCriacao.length === 0) break
    const ultimo = pendentesCriacao[pendentesCriacao.length - 1]
    cursorB = { createdAt: ultimo.createdAt, id: ultimo.id }
    for (const intent of pendentesCriacao) {
      try {
        // F5.7 (M4d): intent de OUTRO ambiente => NÃO reconsulta (host errado) e NÃO desiste (FAILED por "sem resposta" seria decidir sobre um erro nosso).
        if (!(await ambienteDoIntentConfere(intent, 'varrerPreAutorizacoesCartao:created'))) continue
        if (await resolverCreated(intent, pagamentoPort, limiteDesistencia)) resolvidasCreated++
      } catch (err) {
        logger.error({ err, intentId: intent.id }, '[varrerPreAutorizacoesCartao] falha ao reconsultar intent CREATED — tentando de novo na próxima rodada')
      }
    }
    if (pendentesCriacao.length < BATCH_SIZE) break
  }

  if (canceladasAbandonadas > 0 || resolvidasCreated > 0) {
    logger.info({ canceladasAbandonadas, resolvidasCreated }, '[varrerPreAutorizacoesCartao] rodada concluída')
  }

  return { canceladasAbandonadas, resolvidasCreated }
}

type IntentCreated = Awaited<ReturnType<typeof prisma.paymentIntent.findMany>>[number]

/** Resolve (ou adia) um intent CREATED. `true` = saiu de CREATED nesta chamada. */
async function resolverCreated(intent: IntentCreated, pagamentoPort: PagamentoPort, limiteDesistencia: Date): Promise<boolean> {
  const tentativas = await contarTentativaCreated(intent.id)
  const esgotado = intent.createdAt < limiteDesistencia || tentativas >= MAX_TENTATIVAS_CREATED

  const consulta = intent.cieloPaymentId ? await pagamentoPort.consultar(intent.cieloPaymentId) : await pagamentoPort.consultarPorPedido(intent.id)

  if (!consulta) {
    if (!esgotado) return false
    const atualizado = await prisma.paymentIntent.updateMany({
      where: { id: intent.id, status: 'CREATED' },
      data: { status: 'FAILED', failureReason: 'Sem resposta da Cielo após reconciliação — desistindo.' },
    })
    return atualizado.count > 0
  }

  if (consulta.status === 'AUTHORIZED') {
    // A Cielo autorizou, mas o nosso lado nunca chegou a criar o idTag virtual (senão o intent já estaria AUTHORIZED, não CREATED) — ninguém pode consumir esta
    // pré-autorização. Reflete o providerPaymentId ANTES de cancelar (senão cancelarPreAutorizacaoCartao não encontra o que chamar na Cielo).
    return espelharComoAutorizadaECancelar(intent.id, consulta, pagamentoPort)
  }

  if (consulta.status === 'CAPTURED' || consulta.status === 'FAILED' || consulta.status === 'VOIDED') {
    const atualizado = await prisma.paymentIntent.updateMany({
      where: { id: intent.id, status: 'CREATED' },
      data: { status: consulta.status, cieloPaymentId: consulta.providerPaymentId || null, returnCode: consulta.returnCode, ...identificadoresParaGravar(consulta.identificadores) },
    })
    return atualizado.count > 0
  }

  // Resposta NÃO definitiva (CREATED: Status 0/12, ou Status 1/2 com ReturnCode ausente/fora das tabelas — I-2).
  if (!esgotado) return false
  logger.error(
    { alert: 'payment_authorization_stuck', paymentIntentId: intent.id, paymentId: consulta.providerPaymentId || intent.cieloPaymentId, statusBruto: consulta.statusBruto ?? null, returnCode: consulta.returnCode, tentativas },
    '[varrerPreAutorizacoesCartao] a Cielo não deu resposta definitiva à pré-autorização depois de várias reconsultas — tratando como autorização possivelmente VIVA: cancelo por precaução (a consulta antes do void decide)',
  )
  if (consulta.statusBruto === 1) {
    logger.error({ alert: 'payment_authorized_status_unlisted_returncode', paymentIntentId: intent.id, paymentId: consulta.providerPaymentId || intent.cieloPaymentId, returnCode: consulta.returnCode }, '[varrerPreAutorizacoesCartao] Status 1 (autorizada) com ReturnCode fora das tabelas — recusado por precaução e cancelamento tentado')
  }
  if (!consulta.providerPaymentId && !intent.cieloPaymentId) {
    // Sem PaymentId não há o que cancelar na Cielo.
    const atualizado = await prisma.paymentIntent.updateMany({ where: { id: intent.id, status: 'CREATED' }, data: { status: 'FAILED', failureReason: 'Resposta da Cielo sem resultado definitivo e sem PaymentId — desistindo.' } })
    return atualizado.count > 0
  }
  return espelharComoAutorizadaECancelar(intent.id, consulta, pagamentoPort)
}

async function espelharComoAutorizadaECancelar(intentId: string, consulta: ResultadoConsultaPagamento, pagamentoPort: PagamentoPort): Promise<boolean> {
  const atualizado = await prisma.paymentIntent.updateMany({
    where: { id: intentId, status: 'CREATED' },
    data: {
      status: 'AUTHORIZED',
      cieloPaymentId: consulta.providerPaymentId || null,
      // A CHECK `payment_intent_return_code_required` exige returnCode não nulo em AUTHORIZED. Status 1 com ReturnCode AUSENTE (I-2) é justamente o caso em que ele vem nulo: sem este
      // sentinela o UPDATE seria rejeitado e o intent voltaria a ficar em CREATED para sempre (o loop do relatório). O código real da Cielo, quando existe, é preservado.
      returnCode: consulta.returnCode ?? RETURN_CODE_NAO_INFORMADO,
      amountAuthorizedCents: consulta.amountAuthorizedCents,
      authorizedAt: new Date(),
      ...identificadoresParaGravar(consulta.identificadores),
    },
  })
  if (atualizado.count === 0) return false
  await cancelarPreAutorizacaoCartao(intentId, pagamentoPort) // se não confirmar, segue AUTHORIZED e o caso A repete — agora com freio e parada (I-3)
  return true
}
