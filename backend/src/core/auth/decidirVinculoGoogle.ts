/**
 * Decisão PURA de `POST /api/auth/google/link` (I-7, 04/10/2026): vincular o Google à conta JÁ LOGADA.
 *
 * Diferente de `decidirAcaoGoogle` (login público, que acha a conta pelo e-mail do Google e pode cair em OUTRA conta), aqui a conta alvo é a do token e NUNCA muda. Ordem das recusas
 * (de propósito: a mais barata e a que menos revela vêm primeiro):
 *  1. conta inativa/inexistente        -> INACTIVE (a rota responde 401 como as demais rotas autenticadas);
 *  2. só DRIVER                        -> NOT_ALLOWED (staff nunca ganha vínculo Google);
 *  3. e-mail do Google NÃO verificado  -> EMAIL_NOT_VERIFIED;
 *  4. e-mail do Google != e-mail da conta (sem caixa) -> EMAIL_MISMATCH. É a regra que impede o vínculo de virar atalho: `identidadeEhTestador` (sandbox) e o cartão olham o
 *     e-mail da CONTA + `googleSub`; se qualquer Google pudesse ser vinculado, uma conta só-senha com o e-mail de um testador passaria por testadora com o Google de outra pessoa;
 *  5. a conta já tem Google            -> ALREADY_LINKED (nunca sobrescreve um `googleSub`).
 * "Este Google já está em OUTRA conta" também é ALREADY_LINKED, mas só dá para saber consultando o banco — fica a cargo do serviço (e da unique `googleSub`).
 */

export interface ContaLogada {
  id: string
  role: 'ADMIN' | 'OPERATOR' | 'DRIVER'
  active: boolean
  email: string
  googleSub: string | null
}

export interface IdentidadeGoogleVerificada {
  sub: string
  email: string
  emailVerified: boolean
}

export type RecusaVinculoGoogle = 'INACTIVE' | 'NOT_ALLOWED' | 'EMAIL_NOT_VERIFIED' | 'EMAIL_MISMATCH' | 'ALREADY_LINKED'

export type DecisaoVinculoGoogle = { action: 'LINK' } | { action: 'REJECT'; reason: RecusaVinculoGoogle }

function normalizarEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function decidirVinculoGoogle(conta: ContaLogada | null, identidade: IdentidadeGoogleVerificada): DecisaoVinculoGoogle {
  if (!conta || !conta.active) return { action: 'REJECT', reason: 'INACTIVE' }
  if (conta.role !== 'DRIVER') return { action: 'REJECT', reason: 'NOT_ALLOWED' }
  if (identidade.emailVerified !== true) return { action: 'REJECT', reason: 'EMAIL_NOT_VERIFIED' }
  if (normalizarEmail(identidade.email) !== normalizarEmail(conta.email)) return { action: 'REJECT', reason: 'EMAIL_MISMATCH' }
  if (conta.googleSub !== null) return { action: 'REJECT', reason: 'ALREADY_LINKED' }
  return { action: 'LINK' }
}
