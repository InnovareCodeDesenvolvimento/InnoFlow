import { z } from 'zod'
import type { ConnectorStatus } from '@prisma/client'
import { ocppDateTime } from './common'

export const ocppConnectorStatusEnum = z.enum([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
])

export const statusNotificationReqSchema = z.object({
  // connectorId = 0 é válido no protocolo (representa o charge point
  // inteiro) — não existe linha Connector para ele, ver handler.
  connectorId: z.number().int().min(0),
  errorCode: z.string().min(1).max(30),
  status: ocppConnectorStatusEnum,
  info: z.string().max(50).optional(),
  timestamp: ocppDateTime.optional(),
  vendorId: z.string().max(255).optional(),
  vendorErrorCode: z.string().max(50).optional(),
})

export type StatusNotificationReq = z.infer<typeof statusNotificationReqSchema>

/** Mapeia o status PascalCase do protocolo para o enum ConnectorStatus do Prisma. */
export const CONNECTOR_STATUS_MAP: Record<z.infer<typeof ocppConnectorStatusEnum>, ConnectorStatus> = {
  Available: 'AVAILABLE',
  Preparing: 'PREPARING',
  Charging: 'CHARGING',
  SuspendedEVSE: 'SUSPENDED_EVSE',
  SuspendedEV: 'SUSPENDED_EV',
  Finishing: 'FINISHING',
  Reserved: 'RESERVED',
  Unavailable: 'UNAVAILABLE',
  Faulted: 'FAULTED',
}
