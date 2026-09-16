import { z } from 'zod'

export const connectorTypeEnum = z.enum(['AC_TYPE2', 'DC_CCS2', 'DC_CHADEMO'])
export const connectorStatusEnum = z.enum([
  'AVAILABLE',
  'PREPARING',
  'CHARGING',
  'SUSPENDED_EVSE',
  'SUSPENDED_EV',
  'FINISHING',
  'RESERVED',
  'UNAVAILABLE',
  'FAULTED',
])

export const createConnectorSchema = z.object({
  chargePointId: z.string().cuid(),
  // connectorId = 0 nunca existe como linha (representa o charge point
  // inteiro no protocolo OCPP) — reforçado aqui e por CHECK no banco.
  connectorId: z.number().int().min(1),
  type: connectorTypeEnum,
  maxPowerKw: z.coerce.number().positive().max(9999).optional(),
})

export const updateConnectorSchema = z.object({
  type: connectorTypeEnum.optional(),
  maxPowerKw: z.coerce.number().positive().max(9999).optional(),
  status: connectorStatusEnum.optional(),
})

export type CreateConnectorInput = z.infer<typeof createConnectorSchema>
export type UpdateConnectorInput = z.infer<typeof updateConnectorSchema>
