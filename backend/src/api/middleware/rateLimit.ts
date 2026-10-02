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
function buildLimiter(windowMs: number, max: number, code: string, keyGenerator?: (req: Request) => string, options: { skipSuccessfulRequests?: boolean } = {}) {
  return rateLimit({
    windowMs,
    max,
    // Conta só as respostas de ERRO (>= 400) quando pedido — sucesso legítimo não gasta o balde.
    ...(options.skipSuccessfulRequests ? { skipSuccessfulRequests: true } : {}),
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

/**
 * Login/cadastro/Google: alvo clássico de força bruta — limite apertado por IP. Órion M7
 * (2026-09-19): antes era UMA instância compartilhada (20/15min por IP) contando SUCESSOS e
 * misturando as três rotas — motoristas legítimos atrás do mesmo NAT (garagem, empresa) gastavam o
 * balde uns dos outros só por entrar. Agora: uma instância por rota, e login/Google só contam
 * FALHAS (`skipSuccessfulRequests`). Cadastro conta tudo (cada 201 é uma conta criada: o limite ali
 * é anti-cadastro em massa). O risco real — brute-force DISTRIBUÍDO de uma conta — é coberto por
 * `core/auth/loginThrottle.ts` (por conta, com backoff).
 */
export const loginRateLimit = buildLimiter(15 * 60 * 1000, 20, 'RATE_LIMITED_AUTH', undefined, { skipSuccessfulRequests: true })
export const registerRateLimit = buildLimiter(15 * 60 * 1000, 20, 'RATE_LIMITED_AUTH')
export const googleAuthRateLimit = buildLimiter(15 * 60 * 1000, 20, 'RATE_LIMITED_AUTH', undefined, { skipSuccessfulRequests: true })

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
 * ABERTURA de stream SSE (`/api/admin/events`, `/api/me/events`): 20 aberturas/min por USUÁRIO
 * (loop de reconexão de cliente quebrado / abuso). O teto de streams SIMULTÂNEOS é outro mecanismo
 * (`core/realtime/streamLimiter.ts`) — este limita a TAXA de abrir. Roda DEPOIS de `authenticate`.
 */
export const sseConnectRateLimit = buildLimiter(60 * 1000, 20, 'RATE_LIMITED_SSE', (req) => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown'))

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

/**
 * `POST /api/me/wallet/topups` (F5.2) — escopado por MOTORISTA, mesmo
 * raciocínio de `meStartSessionRateLimit`. Mais folgado (gerar um Pix é bem
 * mais barato que iniciar uma recarga), mas ainda limitado: sem isto, um
 * motorista poderia gerar dezenas de QR por minuto (cada um é uma chamada
 * paga à Cielo do nosso lado) — `TOO_MANY_PENDING_TOPUPS` já cobre "vários
 * QR vivos ao mesmo tempo", isto cobre "gerar e deixar expirar em loop".
 */
export const meCreateTopupRateLimit = buildLimiter(60 * 1000, 10, 'RATE_LIMITED_TOPUP', (req) => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown'))

/**
 * `POST /api/me/payment-methods/tokenization-session` (F5.3) — escopado por
 * MOTORISTA. Emitir um `accessToken` de sessão é barato pro nosso lado, mas
 * cada chamada bate na Cielo (OAuth) do outro — sem limite, um motorista
 * poderia gerar dezenas de sessão por minuto (loop de cliente quebrado, ou
 * reconhecimento de superfície contra o gateway).
 */
export const meTokenizationSessionRateLimit = buildLimiter(60 * 1000, 20, 'RATE_LIMITED_TOKENIZATION', (req) => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown'))

/**
 * `POST /api/me/payment-methods` (F5.3, cadastro de cartão) — mais apertado
 * que o padrão: cada tentativa bate na Cielo (`GET /1/card/{token}`) e é o
 * tipo de rota que um script tentando "testar" CardTokens roubados/gerados
 * abusaria primeiro. `PATCH`/`DELETE`/`GET` desta mesma família de rotas
 * usam o `adminRateLimit` geral (montado em `/api/me`) — não precisam do
 * mesmo aperto.
 */
export const meCreatePaymentMethodRateLimit = buildLimiter(60 * 1000, 8, 'RATE_LIMITED_PAYMENT_METHOD', (req) => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown'))

/**
 * `POST /api/webhooks/cielo/:pathToken` (F5.2) — rota PÚBLICA (sem JWT, sem
 * `req.user`), então a chave é por IP. Folgado o bastante para a Cielo
 * reenviar notificações legítimas em rajada (retry dela própria em caso de
 * 5xx nosso), apertado o bastante para não virar superfície de negação de
 * serviço contra o worker (cada request grava uma linha em `WebhookEvent` e
 * enfileira um job).
 */
export const webhookCieloRateLimit = buildLimiter(60 * 1000, 60, 'RATE_LIMITED_WEBHOOK')

/**
 * `PUT /api/admin/payment-gateway` (F5.5) — troca credenciais/ambiente da conta Cielo da plataforma: ato raro e
 * sensível, então 10/min por ADMIN (por USUÁRIO, não por IP — atrás de NAT compartilhado o limite por IP
 * puniria outros admins). Roda DEPOIS de `authenticate`/`requireRole('ADMIN')`.
 */
export const paymentGatewayWriteRateLimit = buildLimiter(60 * 1000, 10, 'RATE_LIMITED_PAYMENT_GATEWAY', (req) => req.user?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown'))
