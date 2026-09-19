/**
 * Decisão PURA do login/cadastro com Google (2026-09-19) — recebe o que já
 * foi verificado (identidade do ID token) e o que já foi achado no banco, e
 * devolve O QUE FAZER. Sem Prisma/Express/rede de propósito (`core/` é
 * domínio puro): a regra de segurança mais sensível deste fluxo — "conta de
 * staff NUNCA entra nem é vinculada por Google" — fica testável sem banco.
 *
 * Ordem de resolução (decisão firme do Atlas/dono):
 *   (a) achou por `googleSub`        -> entra;
 *   (b) senão, achou por `email`     -> ADMIN/OPERATOR: REJEITA (nada é
 *       gravado); DRIVER: VINCULA o `googleSub` e entra — só porque
 *       `email_verified` é true;
 *   (c) senão                        -> cria um DRIVER novo.
 */

export type PapelConta = 'ADMIN' | 'OPERATOR' | 'DRIVER'

/** Só o que sai do payload VERIFICADO pela lib do Google — nunca do cliente. */
export interface IdentidadeGoogle {
  sub: string
  email: string
  emailVerified: boolean
  name: string | null
}

export interface ContaCandidata {
  id: string
  role: PapelConta
  active: boolean
  googleSub: string | null
}

export type MotivoRecusaGoogle =
  /** `email_verified !== true` — 403 `GOOGLE_EMAIL_NOT_VERIFIED`. */
  | 'EMAIL_NOT_VERIFIED'
  /** Conta ADMIN/OPERATOR — 403 `GOOGLE_LOGIN_NOT_ALLOWED` (e vale linha de auditoria). */
  | 'STAFF_NOT_ALLOWED'
  /** DRIVER do e-mail já está vinculado a OUTRO `sub` do Google — nunca sobrescrever (ver abaixo). */
  | 'ACCOUNT_MISMATCH'
  /** Conta desativada — mesma resposta que `/login` dá para conta inativa. */
  | 'INACTIVE'

export type DecisaoGoogle =
  | { action: 'LOGIN'; userId: string }
  | { action: 'LINK'; userId: string }
  | { action: 'CREATE' }
  | { action: 'REJECT'; reason: MotivoRecusaGoogle; /** conta de staff envolvida, quando houver — para a auditoria. */ userId?: string }

export function decidirAcaoGoogle(identity: IdentidadeGoogle, userBySub: ContaCandidata | null, usersByEmail: readonly ContaCandidata[]): DecisaoGoogle {
  // Primeiro de tudo: sem e-mail verificado nada é confiável — nem vincular,
  // nem criar, nem sequer revelar se o e-mail existe/é de staff.
  if (!identity.emailVerified) return { action: 'REJECT', reason: 'EMAIL_NOT_VERIFIED' }

  // (a) `sub` conhecido. Staff com `googleSub` não deveria existir (nunca
  // vinculamos), mas se existir por dado sujo a regra é a mesma: staff não
  // entra por Google.
  if (userBySub) {
    if (userBySub.role !== 'DRIVER') return { action: 'REJECT', reason: 'STAFF_NOT_ALLOWED', userId: userBySub.id }
    if (!userBySub.active) return { action: 'REJECT', reason: 'INACTIVE' }
    return { action: 'LOGIN', userId: userBySub.id }
  }

  // (b) e-mail (a busca é case-insensitive: `/register` só faz `trim()`, então
  // "Admin@x.com" cadastrado à mão TEM que casar com "admin@x.com" do Google —
  // senão a regra de staff seria contornável só pela caixa das letras).
  // QUALQUER staff entre os candidatos recusa, mesmo que também haja um DRIVER
  // com a mesma grafia-insensível.
  const staff = usersByEmail.find((u) => u.role !== 'DRIVER')
  if (staff) return { action: 'REJECT', reason: 'STAFF_NOT_ALLOWED', userId: staff.id }

  const driver = usersByEmail[0]
  if (driver) {
    // Já vinculada a OUTRO sub: nunca sobrescrever. Cenário real: Google
    // Workspace que reaproveita um e-mail para outra pessoa — vincular aqui
    // entregaria a carteira do motorista original ao novo dono do e-mail.
    if (driver.googleSub !== null && driver.googleSub !== identity.sub) return { action: 'REJECT', reason: 'ACCOUNT_MISMATCH' }
    if (!driver.active) return { action: 'REJECT', reason: 'INACTIVE' }
    // `googleSub === sub` aqui só ocorre em corrida (o passo (a) não achou,
    // mas outro request acabou de vincular) — entrar, sem regravar.
    return driver.googleSub === identity.sub ? { action: 'LOGIN', userId: driver.id } : { action: 'LINK', userId: driver.id }
  }

  // (c) ninguém — conta nova de motorista.
  return { action: 'CREATE' }
}
