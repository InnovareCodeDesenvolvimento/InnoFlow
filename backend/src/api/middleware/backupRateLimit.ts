import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request } from 'express'
import { AppError } from './errorHandler'

/**
 * Limites em memória das rotas de backup — mesmo formato de `rateLimit.ts` (envelope `{ error, code }` via `next(AppError)`: o `handler` roda numa função async da lib e um `throw`
 * viraria unhandled rejection). Arquivo próprio para não disputar o `rateLimit.ts` (editado em paralelo por outras frentes); a regra é a mesma. TODOS por USUÁRIO ADMIN (não por IP):
 * quem tem o token roubado não ganha tentativas trocando de IP. Rodam DEPOIS de `authenticate`/`requireRole('ADMIN')`.
 */
const porUsuario = (req: Request): string => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown')

function limitador(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: porUsuario,
    handler: (_req, _res, next) => next(new AppError('Muitas requisições. Tente novamente em instantes.', 429, 'RATE_LIMITED_BACKUP')),
  })
}

/** Escritas (PUT da config, gerar chave, Google start/disconnect): 10/min por ADMIN, além do step-up de senha com tranca própria. */
export const backupWriteRateLimit = limitador(60 * 1000, 10)
/** "Fazer backup agora" e "Conferir": cada um baixa/gera gigas — 6 a cada 10 min por ADMIN. */
export const backupRunRateLimit = limitador(10 * 60 * 1000, 6)
/** "Testar destino": 5/min por ADMIN (anti-varredura de portas por quem tiver um token). */
export const backupTestRateLimit = limitador(60 * 1000, 5)
