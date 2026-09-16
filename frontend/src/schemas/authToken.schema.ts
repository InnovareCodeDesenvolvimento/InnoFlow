import { z } from "zod"
import { AUTH_TOKEN_STATUSES, AUTH_TOKEN_TYPES } from "@/types/api"

// Espelha backend/src/api/schemas/authToken.schema.ts.
export const authTokenFormSchema = z.object({
  // OCPP 1.6 limita idTag a 20 caracteres.
  idTag: z.string().trim().min(1, "Informe o idTag.").max(20, "Máximo de 20 caracteres (limite do OCPP 1.6)."),
  type: z.enum(AUTH_TOKEN_TYPES, { message: "Selecione o tipo do token." }),
  status: z.enum(AUTH_TOKEN_STATUSES).optional(),
})
export type AuthTokenFormValues = z.infer<typeof authTokenFormSchema>
