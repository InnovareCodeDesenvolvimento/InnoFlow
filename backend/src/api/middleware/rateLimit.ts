import rateLimit from 'express-rate-limit'
import { AppError } from './errorHandler'

/**
 * Rate limit em memória do próprio processo (não distribuído entre réplicas
 * — aceitável para o MVP de 1 réplica da API; se a API escalar horizontalmente,
 * isto precisa de um store compartilhado, ex. `rate-limit-redis`, já que
 * temos Redis disponível). Handler customizado para manter o mesmo envelope
 * de erro `{ error, code }` do resto da API em vez do texto solto padrão da
 * lib.
 */
function buildLimiter(windowMs: number, max: number, code: string) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // IMPORTANTE: `handler` roda dentro de uma função async da própria lib —
    // Express 4 não captura rejeição de Promise automaticamente, então
    // `throw` aqui viraria unhandled rejection (a request travaria sem
    // resposta). Tem que chamar `next(err)` explicitamente.
    handler: (_req, _res, next) => {
      next(new AppError('Muitas requisições. Tente novamente em instantes.', 429, code))
    },
  })
}

/** Login/registro: alvo clássico de força bruta — limite apertado por IP. */
export const authRateLimit = buildLimiter(15 * 60 * 1000, 20, 'RATE_LIMITED_AUTH')

/** Rotas administrativas em geral: limite mais folgado, só contra abuso/loop de cliente quebrado. */
export const adminRateLimit = buildLimiter(60 * 1000, 300, 'RATE_LIMITED')

/** Rotas públicas (app do motorista): mesmo espírito do admin, IP costuma ser compartilhado (NAT). */
export const publicRateLimit = buildLimiter(60 * 1000, 300, 'RATE_LIMITED')
