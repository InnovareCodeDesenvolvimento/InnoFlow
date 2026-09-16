import { z } from 'zod'
import { idTagSchema, ocppDateTime } from './common'

export const startTransactionReqSchema = z.object({
  // connectorId = 0 NUNCA é válido aqui — uma transação sempre pertence a um
  // conector real (regra do próprio spec OCPP 1.6, seção StartTransaction).
  connectorId: z.number().int().min(1),
  idTag: idTagSchema,
  meterStart: z.number().int(),
  timestamp: ocppDateTime,
  reservationId: z.number().int().optional(),
})

export type StartTransactionReq = z.infer<typeof startTransactionReqSchema>
