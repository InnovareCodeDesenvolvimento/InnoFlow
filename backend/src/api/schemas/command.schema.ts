import { z } from 'zod'

export const resetCommandSchema = z.object({
  type: z.enum(['Hard', 'Soft']).default('Soft'),
})

export const unlockCommandSchema = z.object({
  connectorId: z.number().int().min(1),
})

export const changeAvailabilitySchema = z.object({
  connectorId: z.number().int().min(0),
  type: z.enum(['Inoperative', 'Operative']),
})

export const triggerMessageSchema = z.object({
  requestedMessage: z.enum([
    'BootNotification',
    'DiagnosticsStatusNotification',
    'FirmwareStatusNotification',
    'Heartbeat',
    'MeterValues',
    'StatusNotification',
  ]),
  connectorId: z.number().int().min(0).optional(),
})

// F4 (2026-09-17) — o admin dispara a sessão em nome do motorista.
export const remoteStartCommandSchema = z.object({
  connectorId: z.number().int().min(1),
  userId: z.string().cuid(),
})
export type RemoteStartCommandInput = z.infer<typeof remoteStartCommandSchema>
