import type { ChargingSessionPaymentMode, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { redis } from '../../lib/redis'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { calcularCustoSessao, type TariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { normalizarJanelaDeCobranca } from '../../core/tarifacao/janelaDeCobranca'
import { alertarSessaoLimitado } from './alertasSessao'
import { calcularTetoReserva } from '../../core/carteira/calcularTetoReserva'
import { carregarSessoesNaoConfirmadas } from '../carteira/saldoComprometido'
import { pedirParadaSessao } from './pedirParadaSessao'
import { buscarUltimaAmostra } from './resolverLeituraFinal'

/**
 * Guarda de saldo/teto (extraída de `ocpp/handlers/meterValues.ts` na F5.9 para o WATCHDOG também chamá-la — regra R6).
 *
 * Antes só rodava quando chegava um MeterValues com energia: tarifa de TEMPO/ociosidade continuava crescendo sem amostra e o saldo
 * podia estourar sem ninguém olhar (defeito D-C). Agora o watchdog a reavalia com a última energia conhecida.
 *
 * Se o custo parcial (energia medida + tempo decorrido até AGORA) atingir o limite disponível, pede a parada por
 * `pedirParadaSessao` (único ponto de RemoteStop; `stopRequestedBy=GUARD`), marcando a sessão numa chave Redis com TTL para não
 * redisparar a cada amostra enquanto o carregador ainda não obedeceu.
 *
 * F5.4 (2026-09-30): o LIMITE depende do `paymentMode`. WALLET: `min(saldo disponível, teto calculado)` — nunca reservado/debitado
 * antecipadamente. CARD: `PaymentIntent.amountAuthorizedCents` direto (não existe autorização incremental na Cielo). Sem intent
 * AUTHORIZED vinculado: falha FECHADO (limite 0).
 */

const AUTOSTOP_DEDUPE_TTL_SECONDS = 300

export interface SessaoParaGuarda {
  id: string
  userId: string
  connectorId: string
  chargePointId: string
  meterStartWh: number
  startedAt: Date
  chargingEndedAt: Date | null
  tariffSnapshot: Prisma.JsonValue
  paymentMode: ChargingSessionPaymentMode
  site: { timezone: string }
}

export type ResultadoGuardaDeSaldo = 'DISPARADA' | 'ABAIXO_DO_LIMITE' | 'JA_DISPARADA' | 'CUSTO_NAO_CALCULADO'

export interface OpcoesGuardaDeSaldo {
  /** Só para teste: espera o comando RemoteStop terminar (em produção é fire-and-forget). */
  aguardarComando?: boolean
}

export async function avaliarGuardaDeSaldo(session: SessaoParaGuarda, latestEnergyWh: number, opcoes: OpcoesGuardaDeSaldo = {}): Promise<ResultadoGuardaDeSaldo> {
  const dedupeKey = `ocpp:autostop:${session.id}`
  const alreadyDispatched = await redis.get(dedupeKey)
  if (alreadyDispatched) return 'JA_DISPARADA'

  const tariffSnapshot = session.tariffSnapshot as unknown as TariffSnapshot

  let limiteCents: number
  if (session.paymentMode === 'CARD') {
    const intent = await prisma.paymentIntent.findFirst({
      where: { chargingSessionId: session.id, purpose: 'SESSION_CARD_CAPTURE', status: 'AUTHORIZED' },
      select: { amountAuthorizedCents: true },
    })
    if (!intent) {
      logger.warn({ sessionId: session.id }, '[ocpp][guard] sessão CARD sem PaymentIntent AUTHORIZED vinculado — limite fail-closed (0)')
    }
    limiteCents = intent?.amountAuthorizedCents ?? 0
  } else {
    const [connector, wallet] = await Promise.all([
      prisma.connector.findUnique({ where: { id: session.connectorId }, select: { maxPowerKw: true } }),
      prisma.wallet.findUnique({ where: { userId: session.userId }, select: { id: true } }),
    ])

    let saldoDisponivelCents = 0
    if (wallet) {
      const lastEntry = await prisma.walletEntry.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        select: { balanceAfterCents: true },
      })
      saldoDisponivelCents = lastEntry?.balanceAfterCents ?? 0
    }

    const tetoEfetivoCents = calcularTetoReserva(
      { pricePerKwh: tariffSnapshot.pricePerKwh, pricePerMinute: tariffSnapshot.pricePerMinute, sessionFeeCents: tariffSnapshot.sessionFeeCents },
      { maxPowerKw: connector?.maxPowerKw?.toString() ?? null },
      { pisoCents: env.RESERVA_PISO_CENTS, tetoCents: env.RESERVA_TETO_CENTS },
    )

    // F5.9 (D7): outra sessão do motorista em STOP_UNCONFIRMED ainda vai debitar o custo provisório dela — esse saldo já está comprometido.
    const outras = await carregarSessoesNaoConfirmadas(session.userId, { excetoSessionId: session.id })
    limiteCents = Math.min(Math.max(0, saldoDisponivelCents - outras.comprometidoCents), tetoEfetivoCents)
  }

  const energyDeliveredWh = Math.max(0, latestEnergyWh - session.meterStartWh)
  // BAIXO-2 (Órion): "agora" é relógio do SERVIDOR e `startedAt`/`chargingEndedAt` são do CARREGADOR. Com o relógio do carregador adiantado `agora < startedAt`
  // e `calcularCustoSessao` LANÇAVA — a guarda nunca disparava (fail-open silencioso). A janela é normalizada antes da conta.
  const janela = normalizarJanelaDeCobranca({ startedAt: session.startedAt, chargingEndedAt: session.chargingEndedAt, stoppedAt: new Date() })
  let totalCostCents: number
  try {
    totalCostCents = calcularCustoSessao(tariffSnapshot, {
      energyDeliveredWh,
      startedAt: janela.startedAt,
      chargingEndedAt: janela.chargingEndedAt,
      stoppedAt: janela.stoppedAt,
      timezone: session.site.timezone,
    }).totalCostCents
  } catch (err) {
    // A guarda NÃO sabe avaliar: não para a recarga por um bug (ficaria o motorista sem energia por erro nosso), mas o alerta de ERRO obriga a olhar.
    logger.error({ err, sessionId: session.id }, '[ocpp][guard] cálculo do custo parcial falhou — guarda não avaliou esta amostra')
    void alertarSessaoLimitado('session_cost_calculation_failed', { sessionId: session.id, chargePointId: session.chargePointId, where: 'balance_guard' }, 'a guarda de saldo não conseguiu calcular o custo parcial').catch(() => undefined)
    return 'CUSTO_NAO_CALCULADO'
  }

  if (totalCostCents < limiteCents) return 'ABAIXO_DO_LIMITE'

  const dispatched = await redis.set(dedupeKey, '1', 'EX', AUTOSTOP_DEDUPE_TTL_SECONDS, 'NX')
  if (!dispatched) return 'JA_DISPARADA' // outra amostra concorrente já disparou o stop

  logger.warn(
    { sessionId: session.id, chargePointId: session.chargePointId, paymentMode: session.paymentMode, totalCostCents, limiteCents },
    '[ocpp][guard] custo parcial atingiu o limite disponível — pedindo a parada (RemoteStopTransaction)',
  )

  const pedido = pedirParadaSessao({ sessionId: session.id, solicitante: 'GUARD' }).catch((err) =>
    logger.error({ err, sessionId: session.id }, '[ocpp][guard] pedido de parada falhou'),
  )
  if (opcoes.aguardarComando) await pedido
  return 'DISPARADA'
}

/** Carrega o que a guarda precisa — para o WATCHDOG (o handler de MeterValues já tem a sessão na mão). */
export async function carregarSessaoParaGuarda(sessionId: string): Promise<SessaoParaGuarda> {
  return prisma.chargingSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      connectorId: true,
      chargePointId: true,
      meterStartWh: true,
      startedAt: true,
      chargingEndedAt: true,
      tariffSnapshot: true,
      paymentMode: true,
      site: { select: { timezone: true } },
    },
  })
}

/**
 * Última energia conhecida (Wh, medidor cumulativo). Sem nenhuma amostra, o próprio `meterStartWh` — energia entregue 0, NUNCA uma
 * estimativa: o que cresce sem amostra é só o custo por tempo/ociosidade, e é isso que a R6 quer reavaliar.
 */
export async function ultimaEnergiaConhecida(sessionId: string, chargePointId: string, meterStartWh: number): Promise<number> {
  const amostra = await buscarUltimaAmostra(prisma, sessionId, chargePointId)
  return amostra ? amostra.meterWh : meterStartWh
}
