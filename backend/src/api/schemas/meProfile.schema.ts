import { z } from 'zod'
import { apenasDigitos, isValidCpf } from '../../core/pagamentos/validarCpf'

/**
 * `PATCH /api/me/profile` (L1.2). Contrato: `UpdateMeProfileRequest` em `frontend/src/types/api.ts`.
 * `.strict()`: campo desconhecido é 400 — em particular `email`, `userId`, `role`, `googleSub` NUNCA passam (o e-mail não é editável neste lote e o dono do
 * perfil é sempre o `req.user`). Campo ausente = "não mexer"; `null` (phone/cpf) = apagar.
 */

const TELEFONE_CARACTERES = /^[0-9+()\s-]+$/

const nomeSchema = z.string().trim().min(1, 'Informe o nome.').max(120)

/** 8 a 30 caracteres entre dígitos, espaço, `+`, `(`, `)` e `-`, com 8 a 15 dígitos (limite do E.164). */
const telefoneSchema = z
  .string()
  .trim()
  .max(30)
  .refine((v) => TELEFONE_CARACTERES.test(v), { message: 'Use apenas números, espaço, +, ( ) e -.' })
  .refine((v) => {
    const digitos = apenasDigitos(v).length
    return digitos >= 8 && digitos <= 15
  }, { message: 'Telefone com 8 a 15 dígitos.' })

/** Aceita com ou sem pontuação; entrega SÓ os 11 dígitos (como o banco guarda) e exige dígito verificador válido. */
const cpfSchema = z
  .string()
  .trim()
  .max(20)
  .transform(apenasDigitos)
  .refine(isValidCpf, { message: 'CPF inválido.' })

export const updateMeProfileSchema = z
  .object({
    name: nomeSchema.optional(),
    phone: telefoneSchema.nullable().optional(),
    cpf: cpfSchema.nullable().optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((v) => v !== undefined), { message: 'Informe ao menos um campo para alterar.' })

export type UpdateMeProfileInput = z.infer<typeof updateMeProfileSchema>
