import { z } from "zod"
import { isValidCpf, onlyDigits } from "@/lib/cpf"
import type { UpdateMeProfileRequest } from "@/types/api"

/**
 * Espelha `backend/src/api/schemas/meProfile.schema.ts` e `changePasswordSchema` (`auth.schema.ts`) - mesmos limites, para o erro aparecer ANTES de bater na API.
 * O servidor continua sendo a autoridade (CPF já usado por outra conta, por exemplo, só ele sabe). Lógica pura, sem DOM.
 */

const PHONE_CHARS = /^[0-9+()\s-]+$/

export const PASSWORD_MIN_CHARS = 10
/** Limite do bcrypt: o backend recusa acima de 72 BYTES (acento e emoji ocupam mais de um). */
export const PASSWORD_MAX_BYTES = 72

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

// ---- Dados do perfil ---------------------------------------------------------------------------------------------------------------------------------

export const profileFormSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome.").max(120, "O nome pode ter no máximo 120 caracteres."),
  /** Opcional: vazio = sem telefone. */
  phone: z
    .string()
    .trim()
    .max(30, "O telefone pode ter no máximo 30 caracteres.")
    .refine((v) => v === "" || PHONE_CHARS.test(v), "Use apenas números, espaço, +, ( ) e -.")
    .refine((v) => v === "" || (onlyDigits(v).length >= 8 && onlyDigits(v).length <= 15), "Telefone com 8 a 15 dígitos."),
  /** Opcional: vazio = não mexer no CPF salvo. */
  cpf: z
    .string()
    .trim()
    .refine((v) => v === "" || isValidCpf(v), "CPF inválido."),
})
export type ProfileFormValues = z.infer<typeof profileFormSchema>

/**
 * O que mandar no PATCH: SÓ o que mudou (o corpo do servidor é estrito e pede ao menos um campo). Telefone esvaziado vira `null` (apaga). CPF vazio NÃO
 * apaga o salvo (a tela nem mostra o CPF inteiro - só o mascarado): só um CPF digitado é enviado. `null` = nada mudou.
 */
export function buildProfilePatch(values: ProfileFormValues, initial: { name: string; phone: string | null }): UpdateMeProfileRequest | null {
  const patch: UpdateMeProfileRequest = {}
  const name = values.name.trim()
  if (name !== initial.name) patch.name = name
  const phone = values.phone.trim()
  if (phone !== (initial.phone ?? "")) patch.phone = phone === "" ? null : phone
  const cpf = values.cpf.trim()
  if (cpf !== "") patch.cpf = cpf
  return Object.keys(patch).length > 0 ? patch : null
}

// ---- Troca / definição de senha ----------------------------------------------------------------------------------------------------------------------

export interface ChangePasswordFormValues {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

/**
 * `hasPassword=false` (conta só-Google): não existe senha atual a pedir - o servidor ignora `currentPassword` e deixa DEFINIR a primeira. Regras da nova senha =
 * as do servidor (10 caracteres no mínimo, 72 BYTES no máximo); "diferente da atual" e "confirmação igual" são conferências do cliente (o servidor também
 * recusa a igual, com `PASSWORD_UNCHANGED`).
 */
export function buildChangePasswordSchema(hasPassword: boolean) {
  return z
    .object({
      currentPassword: z.string().max(200, "A senha atual é longa demais."),
      newPassword: z
        .string()
        .min(PASSWORD_MIN_CHARS, `A nova senha precisa de pelo menos ${PASSWORD_MIN_CHARS} caracteres.`)
        .refine((v) => byteLength(v) <= PASSWORD_MAX_BYTES, `A nova senha pode ter no máximo ${PASSWORD_MAX_BYTES} bytes (acentos e emojis ocupam mais de um).`),
      confirmPassword: z.string().min(1, "Repita a nova senha."),
    })
    .superRefine((v, ctx) => {
      if (hasPassword && v.currentPassword === "") ctx.addIssue({ code: "custom", path: ["currentPassword"], message: "Informe a senha atual." })
      if (hasPassword && v.currentPassword !== "" && v.newPassword !== "" && v.newPassword === v.currentPassword) {
        ctx.addIssue({ code: "custom", path: ["newPassword"], message: "A nova senha precisa ser diferente da atual." })
      }
      if (v.confirmPassword !== "" && v.newPassword !== v.confirmPassword) ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: "As senhas não conferem." })
    })
}
