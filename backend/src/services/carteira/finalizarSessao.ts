import { Prisma, type StopReason } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { calcularCustoSessao, type CustoSessaoResultado, type TariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { liquidarSessao } from './liquidarSessao'
import { prepararFechamentoCartao } from '../pagamentos/fecharSessaoCartao'
import { cancelarPreAutorizacaoCartao } from '../pagamentos/cancelarPreAutorizacaoCartao'
import { enqueueCapturarSessaoCartao } from '../pagamentos/capturarSessaoCartao'
import { emitSessionStopped, emitWalletUpdated } from '../../realtime/emit'

const ZERO_CUSTOS: CustoSessaoResultado = {
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
}

/**
 * Núcleo de "fechar uma `ChargingSession` de verdade": calcula energia
 * entregue, ociosidade, custo (`calcularCustoSessao`) e debita a carteira
 * (`liquidarSessao`) — tudo dentro de UMA `$transaction` com lock pessimista
 * (`SELECT ... FOR UPDATE`), pra nunca correr com outra finalização
 * concorrente da MESMA sessão (ex.: `StopTransaction` real chegando ao mesmo
 * tempo que a reconciliação de sessão órfã no boot).
 *
 * Extraído de `stopTransaction.ts` (F5, 2026-09-17) para ser reaproveitado
 * por `bootNotification.ts` (reconciliação de sessão que ficou aberta porque
 * o carregador desconectou/reconectou sem completar o `StopTransaction`) —
 * MESMA regra de cálculo, MESMA idempotência, sem duplicar a lógica.
 *
 * Idempotente: se a sessão já estiver `STOPPED` quando o lock é obtido
 * (corrida com outra chamada concorrente), não faz nada.
 *
 * Blindada contra falha de CÁLCULO (`calcularCustoSessao` só lança para
 * inconsistência estrutural, capturado aqui com fallback de custo zerado —
 * nunca deixa uma tarifa/medição incomum impedir o fechamento da sessão).
 * Falha de INFRAESTRUTURA (conexão/deadlock na `$transaction`) ainda
 * propaga — é responsabilidade de quem chama decidir o que fazer (o
 * `StopTransaction` real responde `Accepted` mesmo assim e enfileira retry
 * via `enqueueLiquidarSessaoRetry`; a reconciliação de boot loga e segue para
 * a próxima sessão órfã, sem travar o processamento do `BootNotification`).
 *
 * F5.4 (2026-09-30): sessão `paymentMode === 'CARD'` NÃO passa por
 * `liquidarSessao` (isso é só WALLET) — em vez disso, `prepararFechamentoCartao`
 * decide (dentro da MESMA transação, sem I/O de rede) se a pré-autorização
 * deve ser capturada (`CAPTURE_PENDING`) ou cancelada (sessão sem consumo,
 * `totalCostCents <= 0`). A chamada de rede de verdade (capturar/cancelar na
 * Cielo) acontece DEPOIS do commit — rede nunca entra em transação de banco.
 */
export async function finalizarSessao(sessionId: string, final: FinalizarSessaoInput): Promise<void> {
  const resultado = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ChargingSession" WHERE id = ${sessionId} FOR UPDATE`)

    const session = await tx.chargingSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
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

    if (session.status === 'STOPPED') return null // corrida: outra chamada já finalizou entre o read e o lock

    const tariffSnapshot = session.tariffSnapshot as unknown as TariffSnapshot

    let energyDeliveredWh = final.meterStopWh - session.meterStartWh
    let stopReason = final.stopReason
    if (energyDeliveredWh < 0) {
      logger.warn(
        { sessionId: session.id, meterStopWh: final.meterStopWh, meterStartWh: session.meterStartWh },
        '[finalizarSessao] energyDeliveredWh negativo — clampado em 0',
      )
      energyDeliveredWh = 0
      stopReason = 'OTHER'
    }

    // Janela de ociosidade: [chargingEndedAt + carência, stoppedAt) — mesma
    // fórmula documentada no schema (`ChargingSession.idleSeconds`).
    let idleSeconds: number | null = null
    if (session.chargingEndedAt) {
      const idleStartMs = session.chargingEndedAt.getTime() + tariffSnapshot.idleGracePeriodSeconds * 1000
      idleSeconds = Math.max(0, Math.round((final.timestamp.getTime() - idleStartMs) / 1000))
    }

    // NUNCA pode lançar daqui pra fora — ver contrato documentado no
    // cabeçalho da função. `calcularCustoSessao` só lança para
    // inconsistência estrutural (datas fora de ordem), que os clamps acima
    // já deveriam prevenir — mesmo assim blindamos com fallback de custo
    // zerado em vez de propagar.
    let custos: CustoSessaoResultado = ZERO_CUSTOS
    try {
      custos = calcularCustoSessao(tariffSnapshot, {
        energyDeliveredWh,
        startedAt: session.startedAt,
        chargingEndedAt: session.chargingEndedAt,
        stoppedAt: final.timestamp,
        timezone: session.site.timezone,
      })
    } catch (err) {
      logger.error({ err, sessionId: session.id }, '[finalizarSessao] calcularCustoSessao lançou — usando custo zerado (nunca bloqueia o chamador)')
    }

    await tx.chargingSession.update({
      where: { id: session.id },
      data: {
        status: 'STOPPED',
        meterStopWh: final.meterStopWh,
        energyDeliveredWh,
        stoppedAt: final.timestamp,
        stopReason,
        idleSeconds,
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
  // não existe seria o pior cenário). `resultado === null` = corrida
  // detectada (sessão já estava STOPPED), nada novo a publicar.
  if (!resultado) return

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
    await enqueueCapturarSessaoCartao(resultado.cardResultado.paymentIntentId).catch((err) =>
      logger.error({ err, sessionId, paymentIntentId: resultado.cardResultado?.paymentIntentId }, '[finalizarSessao] falha ao enfileirar captura de sessão CARD (não bloqueante — o varredor não cobre CAPTURE_PENDING nunca criado; reavaliar se isto acontecer na prática)'),
    )
  } else if (resultado.cardResultado?.action === 'VOID' && resultado.cardResultado.paymentIntentId) {
    await cancelarPreAutorizacaoCartao(resultado.cardResultado.paymentIntentId).catch((err) =>
      logger.error({ err, sessionId, paymentIntentId: resultado.cardResultado?.paymentIntentId }, '[finalizarSessao] falha ao cancelar pré-autorização de sessão sem consumo (não bloqueante — varredor não cobre AUTHORIZED com sessão vinculada; reavaliar se isto acontecer na prática)'),
    )
  }
}
