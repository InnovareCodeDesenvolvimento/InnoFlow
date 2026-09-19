import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../../lib/env'
import { AppError } from './errorHandler'
import { sessionValidator } from '../lib/sessionValidatorInstance'

export type Role = 'ADMIN' | 'OPERATOR' | 'DRIVER'

export interface AuthPayload {
  userId: string
  role: Role
  // Só preenchido para role=OPERATOR (CHECK constraint do Cronos garante
  // isso no banco); ADMIN e DRIVER carregam null/undefined.
  operatorId?: string | null
  /** Emitido em / expira em (segundos) — `jsonwebtoken` preenche ao assinar; lidos por `sessionValidator` e pelo stream SSE. */
  iat?: number
  exp?: number
}

declare global {
  // Augmentation de tipos do Express exige namespace — não há forma com
  // módulo ES para adicionar `req.user` ao tipo Request.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

/**
 * Autentica pelo JWT e, DEPOIS da assinatura/`exp`, confere no banco (cache de ~30s, ver
 * `sessionValidator`) que o usuário existe, está ativo, mantém o mesmo papel/operador e que o
 * token não foi emitido antes de `sessionsValidAfter` (troca de senha, vínculo Google,
 * rotação). Sem isto, desativar uma conta ou trocar a senha NÃO cortava o token de 12h (Órion
 * A3/M1). Falha de banco vira 500 (fail-closed), nunca "deixa passar".
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) throw new AppError('Token não fornecido.', 401, 'UNAUTHORIZED')

  let payload: AuthPayload
  try {
    // algorithms fixado: impede confusão de algoritmo (ex.: alg:none / troca
    // HS/RS) — defesa em profundidade (mesma convenção do ParquedasFeiras).
    payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as AuthPayload
  } catch {
    throw new AppError('Token inválido ou expirado.', 401, 'UNAUTHORIZED')
  }

  sessionValidator
    .validate(payload.userId, payload)
    .then((resultado) => {
      if (!resultado.ok) {
        // Mesma resposta de token expirado — não diz ao cliente QUAL motivo (conta desativada, senha trocada...).
        next(new AppError('Token inválido ou expirado.', 401, 'UNAUTHORIZED'))
        return
      }
      req.user = payload
      next()
    })
    .catch(next)
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw new AppError('Não autenticado.', 401, 'UNAUTHORIZED')
    if (!roles.includes(req.user.role)) {
      throw new AppError('Acesso negado.', 403, 'FORBIDDEN')
    }
    next()
  }
}
