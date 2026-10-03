import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { normalizarJanelaDeCobranca } from '../../core/tarifacao/janelaDeCobranca'
import { calcularCustoSessao, type TariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { isSessaoAberta, isSessaoNaoConfirmada } from '../../core/sessao/estadosSessao'
import { meterValuesReqSchema } from '../schemas/meterValues'
import { defineOcppHandler } from './defineHandler'
import { emitSessionMetrics } from '../../realtime/emit'
import { avaliarGuardaDeSaldo } from '../../services/sessao/guardaDeSaldo'
import { alertarSessaoLimitado } from '../../services/sessao/alertasSessao'

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
          paymentMode: true,
          meterStopWh: true,
          chargePointId: true,
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
    //
    // F5.9: `lastActivityAt`/`lastMeterValuesAt` são RELÓGIO DO SERVIDOR (`new Date()`) — o watchdog decide só por eles; `lastSampleAt`
    // (abaixo) continua sendo o relógio do carregador (timestamp do payload) e NUNCA entra na decisão. Só mexem em sessão viva
    // (aberta ou em confirmação): numa sessão STOPPED os campos ficam como estavam, e é a leitura de energia que avisa (abaixo).
    const sessaoViva = isSessaoAberta(session.status) || isSessaoNaoConfirmada(session.status)
    const agora = new Date()
    await prisma.chargingSession
      .update({
        where: { id: session.id },
        data: {
          ...(sessaoViva ? { lastActivityAt: agora, lastMeterValuesAt: agora } : {}),
          lastSampleAt: latestTs ?? undefined,
          ...(latestPowerW !== null ? { lastPowerW: latestPowerW } : {}),
          ...(latestSoc !== null ? { lastSoc: latestSoc } : {}),
        },
      })
      .catch((err) => logger.error({ err, sessionId: session.id }, '[ocpp] falha ao atualizar campos ao vivo da sessão (não bloqueante)'))
  }

  // F5.9: leitura de energia que CHEGA numa sessão já STOPPED e maior que o `meterStopWh` cobrado = o carregador continuou entregando
  // depois de o servidor fechar (energia não cobrada). Só alerta — não reabre, não cobra.
  if (session && session.status === 'STOPPED' && latestEnergyWh !== null && session.meterStopWh !== null && latestEnergyWh > session.meterStopWh) {
    // 1x por hora por sessão: um carregador que segue entregando mandaria um alerta de ERRO a cada MeterValues (medido: 42 em 3 min no simulador).
    void alertarSessaoLimitado(
      'session_metering_after_close',
      { sessionId: session.id, chargePointId: session.chargePointId, billedMeterStopWh: session.meterStopWh, reportedMeterWh: latestEnergyWh },
      'MeterValues com energia MAIOR que a cobrada chegou depois da sessão encerrada — consumo não cobrado',
    ).catch((err) => logger.error({ err, sessionId: session.id }, '[ocpp] falha ao emitir o alerta session_metering_after_close (não bloqueante)'))
  }

  // Guarda de saldo — depois de responder {} ao carregador (nunca atrasa o
  // ack): fire-and-forget, sem `await`. Só roda quando há amostra fresca de
  // energia (medida cumulativa, necessária para calcular custo parcial) e a
  // sessão ainda está tecnicamente aberta (constante única — inclui FAULTED).
  if (session && latestEnergyWh !== null && isSessaoAberta(session.status)) {
    void avaliarGuardaDeSaldo({ ...session }, latestEnergyWh).catch((err) =>
      logger.error({ err, sessionId: session.id }, '[ocpp][guard] falha ao avaliar guarda de saldo (não bloqueante)'),
    )

    // `session.metrics` — coalescido a no máximo 1 evento/5s por sessão
    // dentro de `emitSessionMetrics` (ver realtime/emit.ts). O custo parcial
    // é calculado com a MESMA função pura da guarda de saldo acima — nunca
    // diverge do que pode disparar o auto-stop.
    try {
      const energyDeliveredWh = Math.max(0, latestEnergyWh - session.meterStartWh)
      const janela = normalizarJanelaDeCobranca({ startedAt: session.startedAt, chargingEndedAt: session.chargingEndedAt, stoppedAt: new Date() })
      const { totalCostCents } = calcularCustoSessao(session.tariffSnapshot as unknown as TariffSnapshot, {
        energyDeliveredWh,
        startedAt: janela.startedAt,
        chargingEndedAt: janela.chargingEndedAt,
        stoppedAt: janela.stoppedAt,
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
