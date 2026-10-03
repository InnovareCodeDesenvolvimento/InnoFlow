import bcrypt from 'bcryptjs'

/**
 * Senha do ADMIN de teste (F5.7, M2 — step-up do `PUT /api/admin/payment-gateway` exige a senha atual). Custo 4 de propósito: o
 * teste cria dezenas de admins e o custo 12 de produção custaria ~250 ms cada (o `bcrypt.compare` lê o custo do próprio hash).
 * NUNCA reutilizar fora de teste.
 */
export const SENHA_ADMIN_TESTE = 'Senha-Admin-Teste#2026'
export const HASH_SENHA_ADMIN_TESTE = bcrypt.hashSync(SENHA_ADMIN_TESTE, 4)
