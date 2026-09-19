import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request } from 'express'
import { AppError } from './errorHandler'

/**
 * Rate limit em memória do próprio processo (não distribuído entre réplicas
 * — aceitável para o MVP de 1 réplica da API; se a API escalar horizontalmente,
 * isto precisa de um store compartilhado, ex. `rate-limit-redis`, já que
 * temos Redis disponível). Handler customizado para manter o mesmo envelope
 * de erro `{ error, code }` do resto da API em vez do texto solto padrão da
 * lib.
 */
function buildLimiter(windowMs: number, max: number, code: string, keyGenerator?: (req: Request) => string) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
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

/**
 * `POST /api/auth/password` — escopado por USUÁRIO (não por IP: atrás de NAT compartilhado o
 * limite por IP puniria inocentes, e um atacante com o token roubado não deve ganhar tentativas
 * de adivinhar a senha atual só trocando de IP). 8 tentativas / 15 min. Roda DEPOIS de
 * `authenticate`.
 */
export const changePasswordRateLimit = buildLimiter(15 * 60 * 1000, 8, 'RATE_LIMITED_PASSWORD', (req) => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown'))

/**
 * `POST /api/me/sessions/start` — mais apertado que o público geral e
 * escopado por MOTORISTA (não por IP, ver `keyGenerator`): um motorista
 * sozinho não tem por que iniciar mais de 10 recargas por minuto, e escopar
 * por IP puniria uma garagem inteira atrás do mesmo NAT. Roda DEPOIS de
 * `authenticate` (precisa de `req.user` já resolvido).
 */
// Achado real em produção, 17/09/2026: passar `req.ip` cru pro keyGenerator
// customizado (fallback do caso sem `req.user`, que não deveria acontecer
// nesta rota já autenticada, mas existe por segurança) disparava o aviso de
// validação do express-rate-limit — endereço IPv6 tem várias representações
// equivalentes, então usar o texto cru como chave deixaria um cliente IPv6
// contornar o limite variando a própria representação. `ipKeyGenerator` é o
// helper oficial da lib pra normalizar isso (mesmo raciocínio dela pro
// keyGenerator DEFAULT, que já faz isso sozinho — só o customizado precisa
// chamar na mão).
export const meStartSessionRateLimit = buildLimiter(60 * 1000, 10, 'RATE_LIMITED_SESSION_START', (req) => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown'))
