import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../../lib/env'
import { AppError } from './errorHandler'

export type Role = 'ADMIN' | 'OPERATOR' | 'DRIVER'

export interface AuthPayload {
  userId: string
  role: Role
  // Só preenchido para role=OPERATOR (CHECK constraint do Cronos garante
  // isso no banco); ADMIN e DRIVER carregam null/undefined.
  operatorId?: string | null
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

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) throw new AppError('Token não fornecido.', 401, 'UNAUTHORIZED')

  try {
    // algorithms fixado: impede confusão de algoritmo (ex.: alg:none / troca
    // HS/RS) — defesa em profundidade (mesma convenção do ParquedasFeiras).
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as AuthPayload
    req.user = payload
    next()
  } catch {
    throw new AppError('Token inválido ou expirado.', 401, 'UNAUTHORIZED')
  }
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
