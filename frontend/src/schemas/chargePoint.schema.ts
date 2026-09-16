import { z } from "zod"

// Espelha backend/src/api/schemas/chargePoint.schema.ts.
export const chargePointFormSchema = z.object({
  siteId: z.string().min(1, "Selecione o site."),
  ocppIdentity: z.string().trim().min(1, "Informe o identificador OCPP.").max(50),
  vendor: z.string().trim().max(50).optional().or(z.literal("")),
  model: z.string().trim().max(50).optional().or(z.literal("")),
  serialNumber: z.string().trim().max(50).optional().or(z.literal("")),
  firmwareVersion: z.string().trim().max(50).optional().or(z.literal("")),
  // Obrigatório só na criação — no formulário de edição o campo some (deixar
  // em branco mantém o segredo atual), ver ChargePointForm.tsx.
  basicAuthSecret: z.string().min(8, "Mínimo de 8 caracteres.").max(100).optional().or(z.literal("")),
  active: z.boolean().optional(),
})
export type ChargePointFormValues = z.infer<typeof chargePointFormSchema>
