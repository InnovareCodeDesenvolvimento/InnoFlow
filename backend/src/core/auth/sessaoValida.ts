/**
 * Regra PURA de "esta sessão (JWT) ainda vale?" — Órion A3/M1 (2026-09-19). Até aqui o token
 * de 12h só era checado por assinatura+`exp`: desativar a conta, trocar a senha ou vincular o
 * Google não cortava nada. Sem Prisma/Express/relógio implícito de propósito: a decisão é
 * testável sem banco; quem busca o usuário (e faz o cache de ~30s) é `api/lib/sessionValidator.ts`.
 */

export type PapelSessao = 'ADMIN' | 'OPERATOR' | 'DRIVER'

/** O que o JWT afirma (`AuthPayload`) — `iat` em SEGUNDOS, como no padrão JWT. */
export interface AfirmacoesDoToken {
  role: PapelSessao
  operatorId?: string | null
  iat?: number
}

/** O que o banco diz hoje sobre o usuário do token. */
export interface UsuarioParaSessao {
  active: boolean
  role: PapelSessao
  operatorId: string | null
  sessionsValidAfter: Date | null
}

export type MotivoSessaoInvalida =
  | 'USER_NOT_FOUND'
  | 'INACTIVE'
  /** Papel ou operador mudou depois da emissão — o token carrega privilégio velho. */
  | 'PRIVILEGES_CHANGED'
  /** Emitido antes de `sessionsValidAfter` (troca de senha, vínculo Google, rotação). */
  | 'REVOKED'

export type ResultadoSessao = { ok: true } | { ok: false; reason: MotivoSessaoInvalida }

export function avaliarSessao(token: AfirmacoesDoToken, user: UsuarioParaSessao | null): ResultadoSessao {
  if (!user) return { ok: false, reason: 'USER_NOT_FOUND' }
  if (!user.active) return { ok: false, reason: 'INACTIVE' }
  if (user.role !== token.role || (user.operatorId ?? null) !== (token.operatorId ?? null)) return { ok: false, reason: 'PRIVILEGES_CHANGED' }

  if (user.sessionsValidAfter) {
    // `iat` do JWT tem granularidade de SEGUNDO; `sessionsValidAfter` tem milissegundo. Comparar
    // em segundos, com o piso de `sessionsValidAfter` — senão o token NOVO emitido logo depois da
    // troca de senha (mesmo segundo, `iat` truncado) seria recusado por ser "anterior" ao bump.
    // Custo: uma janela de <1s em que um token emitido no mesmo segundo do bump ainda vale.
    const cutoffSec = Math.floor(user.sessionsValidAfter.getTime() / 1000)
    // Sem `iat` (token fora do padrão) e com revogação registrada: fail-closed.
    if (token.iat === undefined || token.iat < cutoffSec) return { ok: false, reason: 'REVOKED' }
  }

  return { ok: true }
}

/** `exp` (segundos) já vencido? Usado no stream SSE, onde o JWT só foi verificado ao ABRIR a conexão. */
export function tokenExpirado(exp: number | undefined, nowMs: number): boolean {
  return exp !== undefined && nowMs >= exp * 1000
}
