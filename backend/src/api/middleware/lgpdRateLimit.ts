import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request } from 'express'
import { AppError } from './errorHandler'
import { EXPORTACOES_POR_DIA, JANELA_EXPORTACAO_SEGUNDOS } from '../../core/lgpd/exportacao'

/**
 * Limites em memória das rotas de LGPD/termos (L1.4/L1.9) — mesmo formato de `rateLimit.ts` (envelope `{ error, code }` via `next(AppError)`: o `handler` roda numa função async da lib e um
 * `throw` viraria unhandled rejection). Arquivo próprio para não disputar o `rateLimit.ts` (editado em paralelo por outras frentes); a regra é a mesma.
 * TODOS por USUÁRIO (atrás de NAT o limite por IP puniria inocentes; quem tem o token roubado não ganha tentativas trocando de IP).
 */
const porUsuario = (req: Request): string => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown')

function limitador(windowMs: number, max: number, code: string, opcoes: { skipSuccessfulRequests?: boolean } = {}) {
  return rateLimit({
    windowMs,
    max,
    ...(opcoes.skipSuccessfulRequests ? { skipSuccessfulRequests: true } : {}),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: porUsuario,
    handler: (_req, _res, next) => next(new AppError('Muitas requisições. Tente novamente em instantes.', 429, code)),
  })
}

/** `GET /api/me/data-export`: 3 por dia por usuário (contrato: 429 `RATE_LIMITED_EXPORT`). Segunda camada — a cota durável está no Redis (`exportQuota.ts`). */
export const meDataExportRateLimit = limitador(JANELA_EXPORTACAO_SEGUNDOS * 1000, EXPORTACOES_POR_DIA, 'RATE_LIMITED_EXPORT')

/** `POST /api/me/account/deletion`: só FALHAS contam (10 / 15 min por usuário). A tranca por tentativas de SENHA (5 erros/15 min) mora no step-up (Redis); este é o teto geral. */
export const meAccountDeletionRateLimit = limitador(15 * 60 * 1000, 10, 'RATE_LIMITED_ACCOUNT_DELETION', { skipSuccessfulRequests: true })

/** `POST /api/me/consents`: o reaceite acontece uma vez por versão — 20 / 15 min por usuário barra loop de cliente quebrado. */
export const meConsentsWriteRateLimit = limitador(15 * 60 * 1000, 20, 'RATE_LIMITED')

/** `POST /api/admin/account-deletions/:id/refund`: ato raro do ADMIN (10/min por ADMIN), além do step-up de senha com tranca própria. */
export const accountDeletionRefundRateLimit = limitador(60 * 1000, 10, 'RATE_LIMITED_ACCOUNT_DELETION')
