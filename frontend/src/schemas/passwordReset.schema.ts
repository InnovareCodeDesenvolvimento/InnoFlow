import { z } from "zod"
import { byteLength, PASSWORD_MAX_BYTES, PASSWORD_MIN_CHARS } from "@/schemas/profile.schema"

/**
 * Esqueci / redefinir senha (L1.3). Espelha `forgotPasswordSchema` e `resetPasswordSchema` (`backend/src/api/schemas/auth.schema.ts`) - mesmos limites, para o erro aparecer
 * ANTES de bater na API (o servidor segue sendo a autoridade). Lógica pura, sem DOM.
 *
 * A regra da nova senha é a de sempre no sistema (`newPasswordSchema` do servidor): 10 caracteres no mínimo e 72 BYTES no máximo (limite do bcrypt - acento e emoji
 * ocupam mais de um byte). `byteLength` e as constantes vêm de `profile.schema` (uma fonte só).
 */

export const forgotPasswordSchema = z.object({
  email: z.string().trim().min(1, "Informe o e-mail.").email("E-mail inválido.").max(180, "O e-mail pode ter no máximo 180 caracteres."),
})
export type ForgotPasswordFormValues = z.infer<typeof forgotPasswordSchema>

export const NEW_PASSWORD_TOO_SHORT = `A nova senha precisa de pelo menos ${PASSWORD_MIN_CHARS} caracteres.`
export const NEW_PASSWORD_TOO_LONG = `A nova senha pode ter no máximo ${PASSWORD_MAX_BYTES} bytes (acentos e emojis ocupam mais de um).`
export const NEW_PASSWORD_SERVER_REJECTED = `A nova senha precisa ter de ${PASSWORD_MIN_CHARS} caracteres a ${PASSWORD_MAX_BYTES} bytes.`

export interface ResetPasswordFormValues {
  newPassword: string
  confirmPassword: string
}

export const resetPasswordFormSchema = z
  .object({
    newPassword: z
      .string()
      .min(PASSWORD_MIN_CHARS, NEW_PASSWORD_TOO_SHORT)
      .refine((v) => byteLength(v) <= PASSWORD_MAX_BYTES, NEW_PASSWORD_TOO_LONG),
    confirmPassword: z.string().min(1, "Repita a nova senha."),
  })
  .superRefine((v, ctx) => {
    if (v.confirmPassword !== "" && v.newPassword !== v.confirmPassword) ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: "As senhas não conferem." })
  })

/** Estado de cada regra da nova senha, para as dicas ao vivo (a mesma conta do schema, sem mensagem). */
export function passwordRuleStatus(value: string): { minChars: boolean; maxBytes: boolean; bytes: number } {
  const bytes = byteLength(value)
  return { minChars: value.length >= PASSWORD_MIN_CHARS, maxBytes: bytes <= PASSWORD_MAX_BYTES, bytes }
}
