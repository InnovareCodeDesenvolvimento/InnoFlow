import { z } from "zod"
import { CONNECTOR_STATUSES, CONNECTOR_TYPES } from "@/types/api"

// Espelha backend/src/api/schemas/connector.schema.ts.
export const connectorFormSchema = z.object({
  chargePointId: z.string().min(1, "Selecione o ponto de recarga."),
  // connectorId = 0 nunca existe como linha (representa o charge point
  // inteiro no protocolo OCPP) — mesma regra do backend.
  connectorId: z.coerce.number().int().min(1, "O número do conector começa em 1."),
  type: z.enum(CONNECTOR_TYPES, { message: "Selecione o tipo do conector." }),
  maxPowerKw: z.coerce.number().positive("Informe uma potência maior que zero.").max(9999).optional(),
  status: z.enum(CONNECTOR_STATUSES).optional(),
})
export type ConnectorFormValues = z.infer<typeof connectorFormSchema>
export type ConnectorFormInput = z.input<typeof connectorFormSchema>
