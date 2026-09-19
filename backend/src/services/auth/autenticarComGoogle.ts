import { decidirAcaoGoogle, type ContaCandidata, type IdentidadeGoogle, type PapelConta } from '../../core/auth/decidirAcaoGoogle'

/**
 * Orquestração do login/cadastro com Google — sem Prisma nem a lib do Google
 * DIRETAMENTE: recebe o verificador do token e o repositório de usuários por
 * injeção (`GoogleAuthDeps`), então o fluxo inteiro (inclusive a corrida de
 * criação) é testável sem banco e sem rede. Os adaptadores reais moram em
 * `googleTokenVerifier.ts` e `prismaGoogleUserRepository.ts`.
 *
 * NUNCA confia em dado vindo do cliente além do `credential`: nome/e-mail/sub
 * saem SÓ do payload que o verificador devolve (já validado contra as chaves
 * públicas do Google, `aud`, `iss` e `exp`).
 */

export interface UsuarioGoogle extends ContaCandidata {
  name: string
  email: string
  role: PapelConta
  operatorId: string | null
  /** A conta tem senha (`passwordHash` não nulo)? Só o booleano — o hash nunca sai do repositório. */
  hasPassword: boolean
}

/** Lançada pelo repositório quando um INSERT/UPDATE bate numa unique (`googleSub`/`email`) — colisão esperada de dois requests simultâneos, NUNCA um 500. */
export class UniqueViolationError extends Error {}

export interface GoogleUserRepository {
  findBySub(sub: string): Promise<UsuarioGoogle | null>
  /** Case-insensitive — devolve TODAS as contas cujo e-mail difere só na caixa (a regra de staff precisa enxergar todas). */
  findManyByEmail(email: string): Promise<UsuarioGoogle[]>
  linkGoogleSub(userId: string, sub: string): Promise<UsuarioGoogle>
  /** User DRIVER (`passwordHash: null`) + Wallet, atomicamente. */
  createDriverWithWallet(input: { name: string; email: string; googleSub: string }): Promise<UsuarioGoogle>
}

export interface GoogleAuthDeps {
  /** Lança se o token for inválido por QUALQUER motivo (assinatura, `aud`, `iss`, `exp`, malformado, payload incompleto). */
  verifyIdToken(credential: string): Promise<IdentidadeGoogle>
  users: GoogleUserRepository
}

export type ResultadoGoogle =
  | { status: 'INVALID_TOKEN' }
  | { status: 'EMAIL_NOT_VERIFIED' }
  /** `staff` = a conta ADMIN/OPERATOR envolvida — a rota grava `LOGIN_FAILED` (sinal de segurança). */
  | { status: 'STAFF_NOT_ALLOWED'; staff: UsuarioGoogle }
  | { status: 'ACCOUNT_MISMATCH' }
  | { status: 'INACTIVE' }
  | { status: 'OK'; user: UsuarioGoogle; created: boolean; linked: boolean }

const MAX_NAME_LENGTH = 120
// 2 tentativas: a 1ª pode perder uma corrida de unique; a 2ª relê o banco e
// enxerga o vencedor (LOGIN em vez de CREATE). Uma 2ª colisão seguida não é
// corrida normal — propaga em vez de girar em loop.
const MAX_ATTEMPTS = 2

function nomeParaConta(identity: IdentidadeGoogle): string {
  const fromGoogle = identity.name?.trim()
  const fallback = identity.email.split('@')[0]
  return (fromGoogle || fallback).slice(0, MAX_NAME_LENGTH)
}

export async function autenticarComGoogle(credential: string, deps: GoogleAuthDeps): Promise<ResultadoGoogle> {
  let identity: IdentidadeGoogle
  try {
    identity = await deps.verifyIdToken(credential)
  } catch {
    // Deliberadamente sem `err`: mensagens da lib do Google embutem o próprio
    // JWT (ex.: "Wrong number of segments in token: <jwt>") — repassar o erro
    // adiante (log/resposta) vazaria a credencial.
    return { status: 'INVALID_TOKEN' }
  }

  // Curto-circuito ANTES de qualquer consulta: e-mail não verificado nem
  // chega a tocar o banco (e não revela se o e-mail existe).
  if (!identity.emailVerified) return { status: 'EMAIL_NOT_VERIFIED' }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userBySub = await deps.users.findBySub(identity.sub)
    const usersByEmail = userBySub ? [] : await deps.users.findManyByEmail(identity.email)
    const decisao = decidirAcaoGoogle(identity, userBySub, usersByEmail)

    try {
      switch (decisao.action) {
        case 'REJECT': {
          if (decisao.reason === 'EMAIL_NOT_VERIFIED') return { status: 'EMAIL_NOT_VERIFIED' }
          if (decisao.reason === 'ACCOUNT_MISMATCH') return { status: 'ACCOUNT_MISMATCH' }
          if (decisao.reason === 'INACTIVE') return { status: 'INACTIVE' }
          const staff = [userBySub, ...usersByEmail].find((u): u is UsuarioGoogle => u !== null && u.id === decisao.userId)
          // `staff` sempre existe aqui (a decisão só devolve `userId` de uma conta que veio dos achados) — o guard é só para o compilador.
          if (!staff) return { status: 'ACCOUNT_MISMATCH' }
          return { status: 'STAFF_NOT_ALLOWED', staff }
        }
        case 'LOGIN': {
          const user = [userBySub, ...usersByEmail].find((u): u is UsuarioGoogle => u !== null && u.id === decisao.userId)
          if (!user) return { status: 'INVALID_TOKEN' } // inalcançável: LOGIN só sai de um achado
          return { status: 'OK', user, created: false, linked: false }
        }
        case 'LINK': {
          // `email_verified` já foi exigido acima — é a ÚNICA razão de vincular.
          const user = await deps.users.linkGoogleSub(decisao.userId, identity.sub)
          return { status: 'OK', user, created: false, linked: true }
        }
        case 'CREATE': {
          const user = await deps.users.createDriverWithWallet({ name: nomeParaConta(identity), email: identity.email, googleSub: identity.sub })
          return { status: 'OK', user, created: true, linked: false }
        }
      }
    } catch (err) {
      // Idempotência sob concorrência: dois requests simultâneos do mesmo
      // Google tentando criar/vincular — o perdedor relê e cai no LOGIN.
      if (err instanceof UniqueViolationError && attempt < MAX_ATTEMPTS) continue
      throw err
    }
  }

  // Inalcançável (o último attempt sempre retorna ou lança) — satisfaz o compilador.
  throw new Error('autenticarComGoogle: tentativas esgotadas')
}
