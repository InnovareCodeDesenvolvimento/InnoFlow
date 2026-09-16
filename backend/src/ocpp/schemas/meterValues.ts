import { z } from 'zod'
import { ocppDateTime } from './common'

export const sampledValueSchema = z.object({
  value: z.string(),
  context: z.string().optional(),
  format: z.string().optional(),
  measurand: z.string().optional(),
  phase: z.string().optional(),
  location: z.string().optional(),
  unit: z.string().optional(),
})

export const meterValueSchema = z.object({
  timestamp: ocppDateTime,
  sampledValue: z.array(sampledValueSchema).min(1),
})

export const meterValuesReqSchema = z.object({
  // connectorId = 0 é aceito (medição do charge point inteiro), mas não
  // amarra a nenhuma sessão — ver handler.
  connectorId: z.number().int().min(0),
  transactionId: z.number().int().optional(),
  meterValue: z.array(meterValueSchema).min(1),
})

export type MeterValuesReq = z.infer<typeof meterValuesReqSchema>
export type SampledValue = z.infer<typeof sampledValueSchema>
