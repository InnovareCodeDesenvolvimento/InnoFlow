import type { ChargingSessionStatus, MeterStopSource, Prisma, SessionClosureSource, StopReason } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { withDeadline } from '../../lib/withDeadline'
import { calcularCustoSessao, type CustoSessaoResultado, type TariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { normalizarJanelaDeCobranca } from '../../core/tarifacao/janelaDeCobranca'
import { alertarSessaoLimitado } from '../sessao/alertasSessao'
import { liquidarSessao } from './liquidarSessao'
import { prepararFechamentoCartao } from '../pagamentos/fecharSessaoCartao'
import { cancelarPreAutorizacaoCartao } from '../pagamentos/cancelarPreAutorizacaoCartao'
import { enqueueCapturarSessaoCartao } from '../pagamentos/capturarSessaoCartao'
import { travarSessao, fotoAindaVale, type FotoDaSessao, type SessaoTravada } from '../sessao/travarSessao'
import { emitSessionStopped, emitWalletUpdated } from '../../realtime/emit'

export const ZERO_CUSTOS: CustoSessaoResultado = {
  energyCostCents: 0,
  timeCostCents: 0,
  idleFeeCents: 0,
  sessionFeeCents: 0,
  minChargeAdjustmentCents: 0,
  totalCostCents: 0,
}

export interface FinalizarSessaoInput {
  /** Leitura final do medidor, em Wh. */
  meterStopWh: number
  /** Instante em que a sessão terminou de verdade (nunca `now()` — vem da fonte da medição). */
  timestamp: Date
  stopReason: StopReason | null
  /** Quem fecha (F5.9). Default `CHARGER` — o StopTransaction real. O servidor (watchdog) passa `SERVER`. */
  closureSource?: SessionClosureSource
  /** De onde veio a leitura (F5.9). Default `STOP_TRANSACTION`. */
  meterStopSource?: MeterStopSource
  /** Decisão D2 do dono (`NO_CHARGE` + `NO_READING`): grava custo ZERO (nem taxa fixa nem mínimo). Default `false` — fórmula normal. */
  zerarCusto?: boolean
}

/**
 * Forma "preguiçosa" da leitura final: calculada DENTRO do lock da sessão, com a linha já relida. Existe para o encerramento pelo
 * servidor (F5.9) ver, sob o lock, um StopTransaction que acabou de ser logado, e poder desistir (`null`) se a realidade mudou.
 */
export type ResolverFinalSessao = (tx: Prisma.TransactionClient, sessao: SessaoTravada) => Promise<FinalizarSessaoInput | null>

export interface FinalizarSessaoOpcoes {
  /** Se informado, só fecha a sessão se o status ATUAL (sob o lock) estiver aqui. O watchdog usa `['STOP_UNCONFIRMED']`. */
  statusPermitidos?: readonly ChargingSessionStatus[]
  /** Se informado, só fecha se a foto em que a decisão foi tomada ainda vale sob o lock (compare-and-swap). */
  fotoEsperada?: FotoDaSessao
}

export type FinalizarSessaoResultado =
  | { finalizada: true }
  /** `JA_ENCERRADA`: outra chamada fechou antes (corrida) — o StopTransaction tardio cai aqui e vira `registrarStopTardio`. */
  | { finalizada: false; motivo: 'JA_ENCERRADA' | 'STATUS_NAO_PERMITIDO' | 'FOTO_MUDOU' | 'ABORTADA'; causa?: 'CUSTO_NAO_CALCULADO' }

/** Prazo para ENFILEIRAR a captura (ver comentário no ponto de uso): o Stop não pode esperar o Redis voltar. */
const ENQUEUE_CAPTURA_PRAZO_MS = 5_000

export interface SessaoParaCalcularFechamento {
  id: string
  meterStartWh: number
  startedAt: Date
  chargingEndedAt: Date | null
  tariffSnapshot: Prisma.JsonValue
  site: { timezone: string }
}

export interface FechamentoCalculado {
  energyDeliveredWh: number
  stopReason: StopReason | null
  idleSeconds: number | null
  custos: CustoSessaoResultado
  /** Instante final EFETIVO da cobrança (já normalizado: nunca antes de `startedAt`). É este que vai para `stoppedAt`. */
  stoppedAt: Date
  /** `true` se a janela precisou ser corrigida (RTC resetado, `chargingEndedAt` depois do fim...) — o chamador loga. */
  janelaAjustada: boolean
}

/**
 * `calcularCustoSessao` lançou mesmo com a janela normalizada. NUNCA vira custo zero (ALTO-1 do Órion): o cálculo de dinheiro que falha é um bug a
 * corrigir, não receita a perder. Quem fecha aborta (`ABORTADA`) e a sessão fica como estava para revisão manual; quem só informa (custo provisório,
 * diferença do stop tardio) grava `null`/alerta.
 */
export class CustoNaoCalculadoError extends Error {
  constructor(readonly sessionId: string, causa: unknown) {
    super(`cálculo de custo falhou para a sessão ${sessionId}`)
    this.name = 'CustoNaoCalculadoError'
    this.cause = causa
  }
}

/**
 * Cálculo de fechamento (energia, ociosidade, custo) — SEM efeitos. Extraído de `finalizarSessao` para o custo PROVISÓRIO de
 * `marcarSessaoNaoConfirmada` e o `unbilledCostCents` do stop tardio usarem EXATAMENTE a mesma conta que o fechamento real (duas
 * fórmulas = o provisório diverge do cobrado e ninguém percebe).
 *
 * ALTO-1 (Órion): a janela é NORMALIZADA antes da conta (`normalizarJanelaDeCobranca`) e, se ainda assim `calcularCustoSessao` lançar, lança
 * `CustoNaoCalculadoError` — antes isto caía em custo ZERO silencioso e a sessão fechava de graça (no cartão, a pré-autorização era cancelada).
 */
export function calcularFechamentoSessao(session: SessaoParaCalcularFechamento, final: Pick<FinalizarSessaoInput, 'meterStopWh' | 'timestamp' | 'stopReason' | 'zerarCusto'>): FechamentoCalculado {
  const tariffSnapshot = session.tariffSnapshot as unknown as TariffSnapshot

  let energyDeliveredWh = final.meterStopWh - session.meterStartWh
  let stopReason = final.stopReason
  if (energyDeliveredWh < 0) {
    logger.warn({ sessionId: session.id, meterStopWh: final.meterStopWh, meterStartWh: session.meterStartWh }, '[finalizarSessao] energyDeliveredWh negativo — clampado em 0')
    energyDeliveredWh = 0
    stopReason = 'OTHER'
  }

  const janela = normalizarJanelaDeCobranca({ startedAt: session.startedAt, chargingEndedAt: session.chargingEndedAt, stoppedAt: final.timestamp })
  if (janela.ajustada) {
    logger.warn(
      { sessionId: session.id, startedAt: session.startedAt, chargingEndedAt: session.chargingEndedAt, stoppedAtInformado: final.timestamp, stoppedAtEfetivo: janela.stoppedAt },
      '[finalizarSessao] janela de cobrança fora de ordem (relógio do carregador?) — normalizada antes de calcular o custo',
    )
  }

  // Janela de ociosidade: [chargingEndedAt + carência, stoppedAt) — mesma
  // fórmula documentada no schema (`ChargingSession.idleSeconds`).
  let idleSeconds: number | null = null
  if (janela.chargingEndedAt) {
    const idleStartMs = janela.chargingEndedAt.getTime() + tariffSnapshot.idleGracePeriodSeconds * 1000
    idleSeconds = Math.max(0, Math.round((janela.stoppedAt.getTime() - idleStartMs) / 1000))
  }

  // `ZERO_CUSTOS` SÓ por decisão explícita (D2 NO_CHARGE + NO_READING). Falha de cálculo NUNCA vira zero: ver `CustoNaoCalculadoError`.
  let custos: CustoSessaoResultado = ZERO_CUSTOS
  if (!final.zerarCusto) {
    try {
      custos = calcularCustoSessao(tariffSnapshot, {
        energyDeliveredWh,
        startedAt: janela.startedAt,
        chargingEndedAt: janela.chargingEndedAt,
        stoppedAt: janela.stoppedAt,
        timezone: session.site.timezone,
      })
    } catch (err) {
      throw new CustoNaoCalculadoError(session.id, err)
    }
  }

  return { energyDeliveredWh, stopReason, idleSeconds, custos, stoppedAt: janela.stoppedAt, janelaAjustada: janela.ajustada }
}

/**
 * Núcleo de "fechar uma `ChargingSession` de verdade": calcula energia
 * entregue, ociosidade, custo (`calcularCustoSessao`) e debita a carteira
 * (`liquidarSessao`) — tudo dentro de UMA `$transaction` com lock pessimista
 * (`SELECT ... FOR UPDATE`), pra nunca correr com outra finalização
 * concorrente da MESMA sessão (ex.: `StopTransaction` real chegando ao mesmo
 * tempo que o encerramento pelo servidor do watchdog).
 *
 * Extraído de `stopTransaction.ts` (F5, 2026-09-17) para ser reaproveitado
 * pela reconciliação de sessão órfã — hoje `encerrarSessaoPeloServidor` (F5.9,
 * que substituiu `reconciliarSessaoOrfa`) — MESMA regra de cálculo, MESMA
 * idempotência, sem duplicar a lógica.
 *
 * Idempotente: se a sessão já estiver `STOPPED` quando o lock é obtido
 * (corrida com outra chamada concorrente), não faz nada e devolve
 * `{ finalizada: false, motivo: 'JA_ENCERRADA' }`.
 *
 * Blindada contra falha de CÁLCULO (ver `calcularFechamentoSessao`). Falha de
 * INFRAESTRUTURA (conexão/deadlock na `$transaction`) ainda propaga — é
 * responsabilidade de quem chama decidir o que fazer (o `StopTransaction` real
 * responde `Accepted` mesmo assim e enfileira retry via
 * `enqueueLiquidarSessaoRetry`; o watchdog loga e tenta no ciclo seguinte).
 *
 * F5.4 (2026-09-30): sessão `paymentMode === 'CARD'` NÃO passa por
 * `liquidarSessao` (isso é só WALLET) — em vez disso, `prepararFechamentoCartao`
 * decide (dentro da MESMA transação, sem I/O de rede) se a pré-autorização
 * deve ser capturada (`CAPTURE_PENDING`) ou cancelada (sessão sem consumo,
 * `totalCostCents <= 0`). A chamada de rede de verdade (capturar/cancelar na
 * Cielo) acontece DEPOIS do commit — rede nunca entra em transação de banco.
 *
 * F5.9 (2026-10-03): grava `closureSource`/`meterStopSource` (quem fechou e com que prova) e aceita fechar uma sessão
 * `STOP_UNCONFIRMED` (o StopTransaction do carregador que chega durante a janela de confirmação fecha normalmente). O encerramento
 * pelo servidor usa as `opcoes` para reconferir, SOB o lock, que a sessão continua exatamente como o watchdog a viu.
 */
export async function finalizarSessao(sessionId: string, final: FinalizarSessaoInput | ResolverFinalSessao, opcoes: FinalizarSessaoOpcoes = {}): Promise<FinalizarSessaoResultado> {
  type Aborto = { abortado: Extract<FinalizarSessaoResultado, { finalizada: false }>['motivo']; causa?: 'CUSTO_NAO_CALCULADO'; chargePointId?: string }
  const resultado = await prisma.$transaction(async (tx): Promise<Aborto | { userId: string; chargePointId: string; operatorId: string; walletResultado: Awaited<ReturnType<typeof liquidarSessao>> | null; cardResultado: Awaited<ReturnType<typeof prepararFechamentoCartao>> | null }> => {
    const travada = await travarSessao(tx, sessionId)

    if (travada.status === 'STOPPED') return { abortado: 'JA_ENCERRADA' } // corrida: outra chamada já finalizou entre o read e o lock
    if (opcoes.statusPermitidos && !opcoes.statusPermitidos.includes(travada.status)) return { abortado: 'STATUS_NAO_PERMITIDO' }
    if (opcoes.fotoEsperada && !fotoAindaVale(travada, opcoes.fotoEsperada)) return { abortado: 'FOTO_MUDOU' }

    const entrada = typeof final === 'function' ? await final(tx, travada) : final
    if (!entrada) return { abortado: 'ABORTADA' }

    const session = await tx.chargingSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        chargePointId: true,
        operatorId: true,
        meterStartWh: true,
        startedAt: true,
        chargingEndedAt: true,
        tariffSnapshot: true,
        paymentMode: true,
        site: { select: { timezone: true } },
      },
    })

    let fechamento: FechamentoCalculado
    try {
      fechamento = calcularFechamentoSessao(session, entrada)
    } catch (err) {
      // ALTO-1: NÃO fecha com custo zero. A transação é desfeita sem escrever nada; a sessão fica como estava (STOP_UNCONFIRMED -> revisão manual).
      if (err instanceof CustoNaoCalculadoError) {
        logger.error({ err, sessionId, cause: err.cause instanceof Error ? err.cause.message : String(err.cause) }, '[finalizarSessao] cálculo de custo falhou — fechamento ABORTADO (nunca fecha com custo zero)')
        return { abortado: 'ABORTADA', causa: 'CUSTO_NAO_CALCULADO', chargePointId: session.chargePointId }
      }
      throw err
    }
    const { energyDeliveredWh, stopReason, idleSeconds, custos } = fechamento

    await tx.chargingSession.update({
      where: { id: session.id },
      data: {
        status: 'STOPPED',
        meterStopWh: entrada.meterStopWh,
        energyDeliveredWh,
        stoppedAt: fechamento.stoppedAt,
        stopReason,
        idleSeconds,
        closureSource: entrada.closureSource ?? 'CHARGER',
        meterStopSource: entrada.meterStopSource ?? 'STOP_TRANSACTION',
        ...custos,
      },
    })

    // WALLET: débito atômico da carteira — MESMA função usada pelo job de
    // retry (`liquidarSessao`), aqui reaproveitando a transação já aberta
    // (nunca abre uma transação aninhada). NÃO publica aqui dentro — `tx`
    // fornecido faz `liquidarSessao` só retornar o resultado, sem publicar (a
    // transação desta função ainda não commitou).
    //
    // CARD: `prepararFechamentoCartao` só decide a ação (CAPTURE/VOID/NONE) e
    // grava CAPTURE_PENDING quando aplicável — sem chamar a Cielo daqui
    // dentro (ver nota F5.4 no cabeçalho).
    const walletResultado = session.paymentMode === 'CARD' ? null : await liquidarSessao(session.id, tx)
    const cardResultado = session.paymentMode === 'CARD' ? await prepararFechamentoCartao(tx, session.id, custos.totalCostCents) : null

    return { userId: session.userId, chargePointId: session.chargePointId, operatorId: session.operatorId, walletResultado, cardResultado }
  })

  // Publicado DEPOIS do `$transaction` acima ter resolvido (= commit real) —
  // nunca de dentro dela (decisão 5 da Nova: rollback publicando saldo que
  // não existe seria o pior cenário). `abortado` = corrida/condição que mudou,
  // nada novo a publicar.
  if ('abortado' in resultado) {
    if (resultado.causa === 'CUSTO_NAO_CALCULADO') {
      // Alerta de ERRO sem dado pessoal; limitado a 1x/h por sessão (o watchdog tenta de novo a cada ciclo e repetiria o alerta por minuto).
      void alertarSessaoLimitado('session_cost_calculation_failed', { sessionId, chargePointId: resultado.chargePointId }, 'o cálculo do custo falhou — a sessão NÃO foi fechada (nem de graça): revisão manual').catch(() => undefined)
      return { finalizada: false, motivo: 'ABORTADA', causa: 'CUSTO_NAO_CALCULADO' }
    }
    return { finalizada: false, motivo: resultado.abortado }
  }

  await emitSessionStopped({ operatorId: resultado.operatorId, userId: resultado.userId, sessionId, chargePointId: resultado.chargePointId }).catch((err) =>
    logger.error({ err, sessionId }, '[realtime] falha ao publicar session.stopped (não bloqueante)'),
  )

  if (resultado.walletResultado?.debited) {
    await emitWalletUpdated(resultado.walletResultado.userId, resultado.walletResultado.balanceAfterCents).catch((err) =>
      logger.error({ err, sessionId }, '[realtime] falha ao publicar wallet.updated (não bloqueante)'),
    )
  }

  // CARD: a chamada de rede de verdade acontece só AGORA (depois do commit) —
  // nunca bloqueia o ack ao carregador (o `StopTransaction` já respondeu
  // `Accepted` antes disto — ver `stopTransaction.ts`) nem prende o lock da
  // sessão durante a chamada à Cielo.
  if (resultado.cardResultado?.action === 'CAPTURE' && resultado.cardResultado.paymentIntentId) {
    // Com prazo: com o Redis FORA o ioredis (maxRetriesPerRequest: null, exigência do BullMQ) não rejeita — o `add` ficaria
    // pendurado e seguraria o handler do StopTransaction. Estourado o prazo, o intent já está CAPTURE_PENDING no banco e o
    // varredor (reenfileirarCapturasPendentes) assume; o `add` abandonado conclui sozinho se o Redis voltar (jobId idempotente).
    await withDeadline(enqueueCapturarSessaoCartao(resultado.cardResultado.paymentIntentId), ENQUEUE_CAPTURA_PRAZO_MS, 'enfileirar captura de cartão').catch((err) =>
      logger.error({ err, sessionId, paymentIntentId: resultado.cardResultado?.paymentIntentId }, '[finalizarSessao] falha ao enfileirar captura de sessão CARD (não bloqueante — o intent já está CAPTURE_PENDING no banco e o varredor periódico (reenfileirarCapturasPendentes, F5.7) o reenfileira em CARD_CAPTURE_RETRY_AFTER_MINUTES)'),
    )
  } else if (resultado.cardResultado?.action === 'VOID' && resultado.cardResultado.paymentIntentId) {
    await cancelarPreAutorizacaoCartao(resultado.cardResultado.paymentIntentId).catch((err) =>
      logger.error({ err, sessionId, paymentIntentId: resultado.cardResultado?.paymentIntentId }, '[finalizarSessao] falha ao cancelar pré-autorização de sessão sem consumo (não bloqueante — varredor não cobre AUTHORIZED com sessão vinculada; reavaliar se isto acontecer na prática)'),
    )
  }

  return { finalizada: true }
}
