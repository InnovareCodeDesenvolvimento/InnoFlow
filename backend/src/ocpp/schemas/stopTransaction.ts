import { z } from 'zod'
import type { StopReason } from '@prisma/client'
import { idTagSchema, ocppDateTime } from './common'
import { meterValueSchema } from './meterValues'

export const ocppStopReasonEnum = z.enum([
  'EmergencyStop',
  'EVDisconnected',
  'HardReset',
  'Local',
  'Other',
  'PowerLoss',
  'Reboot',
  'Remote',
  'SoftReset',
  'UnlockCommand',
  'DeAuthorized',
])

export const stopTransactionReqSchema = z.object({
  transactionId: z.number().int(),
  idTag: idTagSchema.optional(),
  meterStop: z.number().int(),
  timestamp: ocppDateTime,
  reason: ocppStopReasonEnum.optional(),
  transactionData: z.array(meterValueSchema).optional(),
})

export type StopTransactionReq = z.infer<typeof stopTransactionReqSchema>

/** Mapeia o motivo PascalCase do protocolo para o enum StopReason do Prisma. */
export const STOP_REASON_MAP: Record<z.infer<typeof ocppStopReasonEnum>, StopReason> = {
  EmergencyStop: 'EMERGENCY_STOP',
  EVDisconnected: 'EV_DISCONNECTED',
  HardReset: 'HARD_RESET',
  Local: 'LOCAL',
  Other: 'OTHER',
  PowerLoss: 'POWER_LOSS',
  Reboot: 'HARD_RESET',
  Remote: 'REMOTE',
  SoftReset: 'SOFT_RESET',
  UnlockCommand: 'UNLOCK_COMMAND',
  DeAuthorized: 'DEAUTHORIZED',
}
