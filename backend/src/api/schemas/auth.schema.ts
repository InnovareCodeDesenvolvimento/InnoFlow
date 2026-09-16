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
  password: z.string().min(1),
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
