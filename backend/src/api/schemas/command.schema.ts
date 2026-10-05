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

/** Texto livre do suporte (L1.5): 10 a 200 caracteres DEPOIS do trim, sem caracteres de controle (quebra de linha/tab/NUL num campo que vai para o log de auditoria). */
export const REMOTE_START_REASON_MIN = 10
export const REMOTE_START_REASON_MAX = 200
// eslint-disable-next-line no-control-regex -- é exatamente o objetivo: recusar caracteres de controle
const CARACTERES_DE_CONTROLE = /[\u0000-\u001f\u007f-\u009f]/

// F4 (2026-09-17) — o admin dispara a sessão em nome do motorista.
// L1.5 (06/10/2026) — MUDANÇA DELIBERADA: `reason` OBRIGATÓRIO (vai para o `actionDetail` da auditoria). Cliente sem `reason` recebe 400 VALIDATION_ERROR (details[].path = reason);
// nenhum cliente de produção chamava a rota (só a API — a tela admin é nova).
export const remoteStartCommandSchema = z.object({
  connectorId: z.number().int().min(1),
  userId: z.string().cuid(),
  reason: z
    .string({ required_error: 'Informe o motivo da recarga remota.' })
    .trim()
    .min(REMOTE_START_REASON_MIN, `O motivo precisa de pelo menos ${REMOTE_START_REASON_MIN} caracteres.`)
    .max(REMOTE_START_REASON_MAX, `O motivo pode ter no máximo ${REMOTE_START_REASON_MAX} caracteres.`)
    .refine((v) => !CARACTERES_DE_CONTROLE.test(v), { message: 'O motivo não pode ter quebras de linha nem caracteres de controle.' }),
})
export type RemoteStartCommandInput = z.infer<typeof remoteStartCommandSchema>
