import { z } from "zod"

// Espelha backend/src/api/schemas/auth.schema.ts — mesmos limites, para o
// usuário ver o erro ANTES de bater na API.
export const loginSchema = z.object({
  email: z.string().trim().min(1, "Informe o e-mail.").email("E-mail inválido."),
  password: z.string().min(1, "Informe a senha."),
})
export type LoginFormValues = z.infer<typeof loginSchema>

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome.").max(120),
  email: z.string().trim().min(1, "Informe o e-mail.").email("E-mail inválido.").max(180),
  password: z.string().min(8, "A senha precisa de pelo menos 8 caracteres.").max(72),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  // L1.9: aceite dos Termos de Uso e da Política de Privacidade. Só existe no formulário - o que vai à API é `acceptedTermsVersion` (a versão vigente), montado pela tela.
  acceptTerms: z.boolean().refine((v) => v === true, "Aceite os Termos de Uso e a Política de Privacidade para criar a conta."),
})
export type RegisterFormValues = z.infer<typeof registerSchema>
