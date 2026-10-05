import { z } from 'zod'

// Registro público SEMPRE cria um DRIVER — criar ADMIN/OPERATOR por uma rota
// pública seria um buraco de segurança óbvio. Contas de staff (ADMIN/
// OPERATOR) nascem hoje só via seed; uma rota administrativa para isso é
// pendência declarada no handoff desta fase (fora do escopo de CRUDs pedido).
export const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(180),
  password: z.string().min(8).max(72),
  phone: z.string().trim().max(30).optional(),
})

export const loginSchema = z.object({
  email: z.string().trim().email(),
  // Teto de 200: bcrypt só lê 72 bytes; acima disso é só carga (hash de entrada gigante) sem ganho.
  password: z.string().min(1).max(200),
})

// `POST /api/auth/google` — só o ID token (JWT) do Google Identity Services;
// nome/e-mail/sub NUNCA vêm do cliente, saem do payload verificado. ID tokens
// reais têm ~1-1,5 KB; 4096 é folga razoável e barra lixo antes de gastar CPU
// na verificação. Falha de formato aqui é 400 (validação); um JWT bem-formado
// mas inválido é 401 `INVALID_GOOGLE_TOKEN`, decidido pelo verificador.
export const googleAuthSchema = z.object({
  credential: z.string().min(1).max(4096),
})

// `POST /api/auth/password`. `newPassword`: mínimo 10 (Órion) e máximo 72 BYTES — o bcrypt
// TRUNCA em silêncio acima disso (senhas longas diferindo só depois do byte 72 valeriam igual).
// A política de senha NOVA mora aqui, num lugar só: `POST /api/auth/password` e `POST /api/auth/password/reset` (L1.3) usam a MESMA regra.
export const newPasswordSchema = z
  .string()
  .min(10)
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, { message: 'no máximo 72 bytes' })

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: newPasswordSchema,
})

// `POST /api/auth/password/forgot` (L1.3) — só o e-mail. Mesmo teto de 180 do cadastro. A resposta é 202 para qualquer e-mail BEM FORMADO (existente ou não).
export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(180),
})

// `POST /api/auth/password/reset` (L1.3). `token`: o formato real (43 caracteres) é conferido no serviço — token malformado vira `RESET_TOKEN_INVALID`, não `VALIDATION_ERROR`
// (um código só para "este link não vale"); aqui só um teto que barra corpo gigante.
export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(200),
  newPassword: newPasswordSchema,
})


export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
