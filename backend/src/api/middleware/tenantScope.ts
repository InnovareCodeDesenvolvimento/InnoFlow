import type { Request, Response, NextFunction } from 'express'
import { AppError } from './errorHandler'

/**
 * Isolamento multi-tenant real (decisão do dono, não negociável — ver
 * PROGRESSO.md §Decisões em aberto item 1): papel `OPERATOR` só enxerga o
 * próprio `operatorId`; só `ADMIN` (plataforma) atravessa todos os
 * operadores. Toda rota `/api/admin/*` que toca uma entidade com
 * `operatorId` passa por aqui.
 */
export function requireOperatorOrAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new AppError('Não autenticado.', 401, 'UNAUTHORIZED')
  if (req.user.role !== 'OPERATOR' && req.user.role !== 'ADMIN') {
    throw new AppError('Acesso restrito a operadores da plataforma.', 403, 'FORBIDDEN')
  }
  next()
}

/**
 * Fragmento de `where` para usar em toda query de leitura escopada por
 * operador: `{ ...operatorScopeWhere(req) }`. ADMIN devolve `{}` (sem
 * filtro — atravessa tudo); OPERATOR devolve `{ operatorId }`. Chame só
 * depois de `authenticate` + `requireOperatorOrAdmin`.
 */
export function operatorScopeWhere(req: Request): { operatorId?: string } {
  if (req.user!.role === 'ADMIN') return {}
  if (!req.user!.operatorId) throw new AppError('Usuário operador sem operatorId associado.', 403, 'FORBIDDEN')
  return { operatorId: req.user!.operatorId }
}

/**
 * Resolve o `operatorId` a gravar num CREATE. ADMIN precisa informar
 * explicitamente de qual operador é o recurso (não tem um "próprio"
 * operatorId); OPERATOR NUNCA escolhe — usamos sempre o dele, ignorando
 * qualquer `operatorId` que o body tente mandar (não confiar no cliente
 * para a fronteira de tenant é a regra, não uma opção).
 */
export function resolveOperatorIdForWrite(req: Request, bodyOperatorId: string | undefined): string {
  if (req.user!.role === 'ADMIN') {
    if (!bodyOperatorId) throw new AppError('operatorId é obrigatório neste corpo quando quem cria é ADMIN.', 400, 'VALIDATION_ERROR')
    return bodyOperatorId
  }
  if (!req.user!.operatorId) throw new AppError('Usuário operador sem operatorId associado.', 403, 'FORBIDDEN')
  return req.user!.operatorId
}
