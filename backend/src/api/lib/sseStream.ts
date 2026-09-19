import type { Request, Response } from 'express'
import { ipKeyGenerator } from 'express-rate-limit'
import { AppError } from '../middleware/errorHandler'
import { tokenExpirado } from '../../core/auth/sessaoValida'
import type { StreamLimiter } from '../../core/realtime/streamLimiter'
import type { AuthPayload } from '../middleware/auth'

/**
 * Mecânica compartilhada de TODO endpoint SSE deste backend (`/api/admin/events` e
 * `/api/me/events`). Dependências injetadas (`SseDeps`) para testar com um hub falso e sem Redis.
 *
 * Órion A2/M1 (2026-09-19) — o que este módulo garante:
 *  - TETO de streams por usuário/IP/total (`core/realtime/streamLimiter.ts`): antes, conexões
 *    longas ilimitadas por conta = exaustão do processo;
 *  - UM assinante Redis compartilhado (o `subscribe` injetado vem de `realtime/bus.ts`), não um
 *    cliente Redis por conexão;
 *  - BACKPRESSURE: `res.write()` devolver `false` (cliente não está lendo, buffer estourou o
 *    limite) fecha o stream em vez de acumular memória sem fim;
 *  - o JWT só é verificado ao ABRIR a conexão — a cada heartbeat o stream re-checa `exp` e a sessão
 *    (conta desativada, senha trocada, papel alterado: cache de ~30s do `sessionValidator`) e SE
 *    ENCERRA quando vence/é revogada. Falha TRANSITÓRIA do banco não derruba o stream;
 *  - encerra por `close` da RESPOSTA (a conexão caiu) — `req.on('close')` não serve: em Node >= 16
 *    dispara quando a REQUISIÇÃO termina de ser lida, não quando o cliente desconecta.
 *
 * Nunca chama `res.end()` no caminho feliz — a conexão fica aberta até o cliente sair, o `exp`
 * vencer, a sessão cair, o backpressure estourar ou o teto por usuário expulsar este stream.
 */

export interface SseDeps {
  /** Ligação com o hub (`realtime/bus.ts`): recebe canais + ouvinte, devolve o "cancelar". */
  subscribe(channels: string[], listener: (event: { type: string }, raw: string) => void): () => void
  limiter: StreamLimiter
  /** A sessão deste usuário ainda vale? (cache de ~30s.) Lança em falha do banco. */
  validateSession(user: AuthPayload): Promise<{ ok: boolean }>
  heartbeatMs: number
  now?: () => number
  /** Diagnóstico (opcional): por que este stream foi encerrado pelo servidor. */
  onClose?: (reason: SseCloseReason) => void
}

export type SseCloseReason = 'client_closed' | 'token_expired' | 'session_revoked' | 'backpressure' | 'evicted' | 'write_error'

export function openSseStream(deps: SseDeps, req: Request, res: Response, channels: string[]): void {
  const user = req.user!
  // IPv6 vira a chave de sub-rede (/56) da própria lib de rate limit — um atacante com um /64 não foge do teto por IP variando o sufixo.
  const ip = req.ip ? ipKeyGenerator(req.ip) : 'unknown'
  const now = deps.now ?? Date.now

  let closed = false
  let unsubscribe: () => void = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined = undefined

  const close = (reason: SseCloseReason): void => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    unsubscribe()
    slot.release()
    deps.onClose?.(reason)
    if (reason !== 'client_closed' && !res.writableEnded) res.end()
  }

  const acquired = deps.limiter.acquire(user.userId, ip, () => close('evicted'))
  if (!acquired.ok) {
    if (acquired.reason === 'IP_LIMIT') throw new AppError('Muitas conexões de tempo real abertas a partir deste endereço.', 429, 'SSE_TOO_MANY_STREAMS')
    throw new AppError('Servidor no limite de conexões de tempo real. Tente novamente em instantes.', 503, 'SSE_CAPACITY')
  }
  const slot = acquired

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Redundância explícita com o bloco SSE do nginx (`frontend/nginx.conf.template`) — garante o
  // comportamento correto mesmo se o proxy da frente mudar de configuração.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // Primeiro byte imediato — alguns proxies só liberam a resposta ao cliente depois do primeiro write.
  if (res.write(': ok\n\n') === false) {
    close('backpressure')
    return
  }

  res.on('close', () => close('client_closed'))
  res.on('error', () => close('write_error'))

  unsubscribe = deps.subscribe(channels, (event, raw) => {
    if (closed) return
    // Uma só escrita por evento; `raw` já é o JSON publicado (sem quebra de linha: JSON.stringify escapa).
    if (res.write(`event: ${event.type}\ndata: ${raw}\n\n`) === false) close('backpressure')
  })

  heartbeat = setInterval(() => {
    void (async () => {
      if (closed) return
      if (tokenExpirado(user.exp, now())) return close('token_expired')
      const validacao = await deps.validateSession(user).catch(() => ({ ok: true }))
      if (closed) return
      if (!validacao.ok) return close('session_revoked')
      if (res.write(': ping\n\n') === false) close('backpressure')
    })()
  }, deps.heartbeatMs)
  heartbeat.unref?.()
}
