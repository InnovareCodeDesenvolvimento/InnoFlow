import { z } from "zod"

export const BASIC_AUTH_SECRET_MIN = 16
export const BASIC_AUTH_SECRET_MAX = 40
/** Limite do bcrypt: o backend recusa segredo com mais bytes que isto (UTF-8). */
const BASIC_AUTH_SECRET_MAX_BYTES = 72

/** Vazio passa (edição = manter o segredo atual); preenchido → 16–40 caracteres e ≤ 72 bytes. */
function basicAuthSecretField() {
  return z
    .string()
    .min(BASIC_AUTH_SECRET_MIN, `O segredo precisa ter no mínimo ${BASIC_AUTH_SECRET_MIN} caracteres.`)
    .max(BASIC_AUTH_SECRET_MAX, `O segredo pode ter no máximo ${BASIC_AUTH_SECRET_MAX} caracteres.`)
    .refine((v) => new TextEncoder().encode(v).length <= BASIC_AUTH_SECRET_MAX_BYTES, {
      message: "Segredo grande demais: evite muitos acentos ou emojis (limite de 72 bytes).",
    })
    .optional()
    .or(z.literal(""))
}

// Espelha backend/src/api/schemas/chargePoint.schema.ts.
export const chargePointFormSchema = z.object({
  siteId: z.string().min(1, "Selecione o site."),
  ocppIdentity: z.string().trim().min(1, "Informe o identificador OCPP.").max(50),
  vendor: z.string().trim().max(50).optional().or(z.literal("")),
  model: z.string().trim().max(50).optional().or(z.literal("")),
  serialNumber: z.string().trim().max(50).optional().or(z.literal("")),
  firmwareVersion: z.string().trim().max(50).optional().or(z.literal("")),
  // Obrigatório só na criação (o diálogo cobra o campo vazio ali). Na edição é
  // opcional: em branco mantém o segredo atual; preenchido, tem de passar na
  // mesma regra da criação.
  // 16 a 40 caracteres, como o backend (Órion A1, 19/09/2026): é a ÚNICA
  // credencial do carregador na internet. O teto de 40 fica abaixo dos 72 BYTES
  // do bcrypt, que trunca em silêncio — e o backend também recusa > 72 bytes,
  // então caractere multibyte (acento, emoji) pode estourar antes dos 40.
  basicAuthSecret: basicAuthSecretField(),
  active: z.boolean().optional(),
})
export type ChargePointFormValues = z.infer<typeof chargePointFormSchema>
