import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request } from 'express'
import { AppError } from './errorHandler'

/**
 * Limite em memória das preferências de notificação (L1.6) — mesmo formato de `lgpdRateLimit.ts` (envelope `{ error, code }` via `next(AppError)`: o `handler` roda numa função async
 * da lib e um `throw` viraria unhandled rejection). Por USUÁRIO (atrás de NAT o limite por IP puniria inocentes).
 */
const porUsuario = (req: Request): string => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown')

/** `PATCH /api/me/notification-preferences`: 30 escritas / 15 min por usuário (a tela mexe em 1-3 chaves por vez; o teto barra loop de cliente quebrado). Contrato: 429. */
export const meNotificationPreferencesWriteRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: porUsuario,
  handler: (_req, _res, next) => next(new AppError('Muitas requisições. Tente novamente em instantes.', 429, 'RATE_LIMITED')),
})
