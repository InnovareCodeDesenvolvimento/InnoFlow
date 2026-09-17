import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { redis } from '../../lib/redis'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { sendCommand } from '../commands'
import { calcularCustoSessao, type TariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { calcularTetoReserva } from '../../core/carteira/calcularTetoReserva'
import { meterValuesReqSchema } from '../schemas/meterValues'
import { defineOcppHandler } from './defineHandler'
import type { OcppHandlerCtx } from '../context'
import { emitSessionMetrics } from '../../realtime/emit'

const ENERGY_MEASURANDS = new Set([
  'Energy.Active.Import.Register',
  'Energy.Active.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Reactive.Export.Register',
])

/**
 * OCPP 1.6 aceita `Wh` OU `kWh` no campo `unit` do sampledValue — tratar tudo
 * como Wh sem checar subfatura por 1000× silenciosamente (achado da F4,
 * 2026-09-17). Só afeta measurands de ENERGIA — Power/SoC não usam Wh.
 */
function normalizeEnergyToWh(measurand: string, rawValue: number, unit: string | undefined): number {
  if (!ENERGY_MEASURANDS.has(measurand)) return rawValue
  if ((unit ?? '').toLowerCase() === 'kwh') return rawValue * 1000
  return rawValue // 'Wh' ou unidade ausente — assume Wh (mesma convenção de sempre)
}

const OPEN_SESSION_STATUSES = new Set(['STARTED', 'CHARGING', 'FINISHING'])
const AUTOSTOP_DEDUPE_TTL_SECONDS = 300

export const handleMeterValues = defineOcppHandler('MeterValues', meterValuesReqSchema, async (data, ctx) => {
  const session = data.transactionId
    ? await prisma.chargingSession.findUnique({
        where: { ocppTransactionId: data.transactionId },
        select: {
          id: true,
          userId: true,
          connectorId: true,
          meterStartWh: true,
          startedAt: true,
          chargingEndedAt: true,
          tariffSnapshot: true,
          ocppTransactionId: true,
          status: true,
          site: { select: { timezone: true } },
        },
      })
    : null

  let latestEnergyWh: number | null = null
  let latestPowerW: number | null = null
  let latestSoc: number | null = null
  let latestTs: Date | null = null

  // `raw` guarda o sampledValue original inteiro — é a prova em disputa de
  // kWh (junto com o log bruto em OcppMessage). `value` guarda o valor JÁ
  // NORMALIZADO para Wh (measurands de energia) — nunca perdemos o bruto.
  // Grava uma linha por sampledValue (measurand), não uma por MeterValues.req.
  const rows = data.meterValue.flatMap((mv) => {
    if (!latestTs || mv.timestamp.getTime() > latestTs.getTime()) latestTs = mv.timestamp

    return mv.sampledValue.map((sv) => {
      const measurand = sv.measurand ?? 'Energy.Active.Import.Register'
      const rawNumeric = Number(sv.value)
      const isNumeric = Number.isFinite(rawNumeric)
      const storedValue: number | string = isNumeric ? normalizeEnergyToWh(measurand, rawNumeric, sv.unit) : sv.value

      if (isNumeric && typeof storedValue === 'number') {
        if (measurand === 'Energy.Active.Import.Register') latestEnergyWh = storedValue
        if (measurand === 'Power.Active.Import') latestPowerW = Math.round(storedValue)
        if (measurand === 'SoC') latestSoc = Math.round(storedValue)
      }

      return {
        sessionId: session?.id,
        chargePointId: ctx.chargePointId,
        operatorId: ctx.operatorId,
        ts: mv.timestamp,
        measurand,
        value: storedValue,
        unit: sv.unit,
        context: sv.context,
        phase: sv.phase,
        location: sv.location,
        raw: sv as unknown as Prisma.InputJsonValue,
      }
    })
  })

  if (rows.length > 0) {
    // createMany não roda os triggers de FK per-row de forma diferente de
    // create — operatorId aqui seria sobrescrito pelo trigger de qualquer
    // forma, mas mandamos o valor correto por clareza (evita depender só do
    // trigger para leitura humana do payload antes dele rodar).
    await prisma.meterSample.createMany({ data: rows })
  }

  if (session) {
    // Painel "ao vivo" da retaguarda (2026-09-16) — sobrescrito a cada
    // amostra, nunca congelado. Não bloqueante: falha aqui não pode derrubar
    // o ack ao carregador (a leitura já foi persistida em MeterSample acima).
    await prisma.chargingSession
      .update({
        where: { id: session.id },
        data: {
          lastSampleAt: latestTs ?? undefined,
          ...(latestPowerW !== null ? { lastPowerW: latestPowerW } : {}),
          ...(latestSoc !== null ? { lastSoc: latestSoc } : {}),
        },
      })
      .catch((err) => logger.error({ err, sessionId: session.id }, '[ocpp] falha ao atualizar campos ao vivo da sessão (não bloqueante)'))
  }

  // Guarda de saldo — depois de responder {} ao carregador (nunca atrasa o
  // ack): fire-and-forget, sem `await`. Só roda quando há amostra fresca de
  // energia (medida cumulativa, necessária para calcular custo parcial) e a
  // sessão ainda está tecnicamente aberta.
  if (session && latestEnergyWh !== null && OPEN_SESSION_STATUSES.has(session.status)) {
    void runBalanceGuard(ctx, { ...session, tariffSnapshot: session.tariffSnapshot }, latestEnergyWh).catch((err) =>
      logger.error({ err, sessionId: session.id }, '[ocpp][guard] falha ao avaliar guarda de saldo (não bloqueante)'),
    )

    // `session.metrics` — coalescido a no máximo 1 evento/5s por sessão
    // dentro de `emitSessionMetrics` (ver realtime/emit.ts). O custo parcial
    // é calculado com a MESMA função pura da guarda de saldo acima — nunca
    // diverge do que pode disparar o auto-stop.
    try {
      const energyDeliveredWh = Math.max(0, latestEnergyWh - session.meterStartWh)
      const { totalCostCents } = calcularCustoSessao(session.tariffSnapshot as unknown as TariffSnapshot, {
        energyDeliveredWh,
        startedAt: session.startedAt,
        chargingEndedAt: session.chargingEndedAt,
        stoppedAt: new Date(),
        timezone: session.site.timezone,
      })
      void emitSessionMetrics({
        operatorId: ctx.operatorId,
        userId: session.userId,
        sessionId: session.id,
        energyWh: energyDeliveredWh,
        powerW: latestPowerW,
        soc: latestSoc,
        partialCostCents: totalCostCents,
      }).catch((err) => logger.error({ err, sessionId: session.id }, '[realtime] falha ao publicar session.metrics (não bloqueante)'))
    } catch (err) {
      logger.error({ err, sessionId: session.id }, '[realtime] calcularCustoSessao lançou ao montar session.metrics — evento pulado (não bloqueante)')
    }
  }

  return {}
})

interface GuardSession {
  id: string
  userId: string
  connectorId: string
  meterStartWh: number
  startedAt: Date
  chargingEndedAt: Date | null
  tariffSnapshot: Prisma.JsonValue
  ocppTransactionId: number
  site: { timezone: string }
}

/**
 * Se o custo parcial da sessão (estimado com o que já foi medido + tempo
 * decorrido até AGORA) atingir o menor entre o saldo disponível e o teto
 * calculado (`calcularTetoReserva`), dispara `RemoteStopTransaction` pelo
 * barramento Redis que já existe (`ocpp/commands.ts`) — fire-and-forget,
 * marcando a sessão (chave Redis com TTL) para não redisparar a cada nova
 * amostra enquanto o carregador ainda não obedeceu ao comando.
 */
async function runBalanceGuard(ctx: OcppHandlerCtx, session: GuardSession, latestEnergyWh: number): Promise<void> {
  const dedupeKey = `ocpp:autostop:${session.id}`
  const alreadyDispatched = await redis.get(dedupeKey)
  if (alreadyDispatched) return

  const tariffSnapshot = session.tariffSnapshot as unknown as TariffSnapshot

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

  const energyDeliveredWh = Math.max(0, latestEnergyWh - session.meterStartWh)
  const { totalCostCents } = calcularCustoSessao(tariffSnapshot, {
    energyDeliveredWh,
    startedAt: session.startedAt,
    chargingEndedAt: session.chargingEndedAt,
    stoppedAt: new Date(),
    timezone: session.site.timezone,
  })

  const limiteCents = Math.min(saldoDisponivelCents, tetoEfetivoCents)
  if (totalCostCents < limiteCents) return

  const dispatched = await redis.set(dedupeKey, '1', 'EX', AUTOSTOP_DEDUPE_TTL_SECONDS, 'NX')
  if (!dispatched) return // outra amostra concorrente já disparou o stop

  logger.warn(
    { sessionId: session.id, chargePointId: ctx.chargePointId, totalCostCents, limiteCents, saldoDisponivelCents, tetoEfetivoCents },
    '[ocpp][guard] custo parcial atingiu o limite disponível — disparando RemoteStopTransaction',
  )

  sendCommand(ctx.chargePointId, 'RemoteStopTransaction', { transactionId: session.ocppTransactionId }).catch((err) =>
    logger.error({ err, sessionId: session.id }, '[ocpp][guard] RemoteStopTransaction falhou'),
  )
}
