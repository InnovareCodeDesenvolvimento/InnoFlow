import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { meterValuesReqSchema } from '../schemas/meterValues'
import { defineOcppHandler } from './defineHandler'

export const handleMeterValues = defineOcppHandler('MeterValues', meterValuesReqSchema, async (data, ctx) => {
  const session = data.transactionId
    ? await prisma.chargingSession.findUnique({ where: { ocppTransactionId: data.transactionId } })
    : null

  // `raw` guarda o sampledValue original inteiro — é a prova em disputa de
  // kWh (junto com o log bruto em OcppMessage). Grava uma linha por
  // sampledValue (measurand), não uma por MeterValues.req.
  const rows = data.meterValue.flatMap((mv) =>
    mv.sampledValue.map((sv) => ({
      sessionId: session?.id,
      chargePointId: ctx.chargePointId,
      operatorId: ctx.operatorId,
      ts: mv.timestamp,
      measurand: sv.measurand ?? 'Energy.Active.Import.Register',
      value: sv.value,
      unit: sv.unit,
      context: sv.context,
      phase: sv.phase,
      location: sv.location,
      raw: sv as unknown as Prisma.InputJsonValue,
    })),
  )

  if (rows.length > 0) {
    // createMany não roda os triggers de FK per-row de forma diferente de
    // create — operatorId aqui seria sobrescrito pelo trigger de qualquer
    // forma, mas mandamos o valor correto por clareza (evita depender só do
    // trigger para leitura humana do payload antes dele rodar).
    await prisma.meterSample.createMany({ data: rows })
  }

  return {}
})
