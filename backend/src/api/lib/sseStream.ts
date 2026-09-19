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
 *  - BACKPRESSURE em DOIS critérios (Íris/Vega, 2026-09-19). `res.write() === false` só diz "há mais
 *    de 16KB pendentes no buffer" — NÃO diz "o cliente parou de ler": um evento grande, ou uma rajada
 *    de eventos pequenos entregue no mesmo tick pelo assinante Redis (~50 x 330B bastam), passa dos
 *    16KB com o cliente lendo normalmente. Derrubar por esse sinal instantâneo fechava painéis
 *    saudáveis (o canal `ui:ev:admin` recebe TODO evento do sistema). A decisão "cliente parado"
 *    precisa de TEMPO: (1) `false` abre um PRAZO (`drainTimeoutMs`) para o `drain` — quem lê
 *    esvazia o buffer e segue; quem não esvazia dentro do prazo é derrubado; (2) um TETO duro de
 *    bytes pendentes (`maxBufferedBytes`) derruba na hora, para o cliente parado não acumular
 *    memória enquanto o prazo corre. Ao derrubar por backpressure o socket é DESTRUÍDO (um
 *    `end()` num socket que ninguém lê deixaria o buffer preso até o timeout do TCP);
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
  /** Prazo para o buffer drenar depois de um `write() === false` antes de derrubar o cliente. Padrão 5s. */
  drainTimeoutMs?: number
  /** Teto duro de bytes pendentes no socket (`res.writableLength`): acima disto derruba na hora. Padrão 1 MiB. */
  maxBufferedBytes?: number
}

export const DEFAULT_SSE_DRAIN_TIMEOUT_MS = 5_000
export const DEFAULT_SSE_MAX_BUFFERED_BYTES = 1024 * 1024

export type SseCloseReason = 'client_closed' | 'token_expired' | 'session_revoked' | 'backpressure' | 'evicted' | 'write_error'

export function openSseStream(deps: SseDeps, req: Request, res: Response, channels: string[]): void {
  const user = req.user!
  // IPv6 vira a chave de sub-rede (/56) da própria lib de rate limit — um atacante com um /64 não foge do teto por IP variando o sufixo.
  const ip = req.ip ? ipKeyGenerator(req.ip) : 'unknown'
  const now = deps.now ?? Date.now
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_SSE_DRAIN_TIMEOUT_MS
  const maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_SSE_MAX_BUFFERED_BYTES

  let closed = false
  let unsubscribe: () => void = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined = undefined
  /** Prazo em curso para o `drain` (existe só enquanto o buffer está acima do limite do `write`). */
  let drainDeadline: ReturnType<typeof setTimeout> | undefined = undefined

  const onDrain = (): void => {
    if (drainDeadline) clearTimeout(drainDeadline)
    drainDeadline = undefined
  }

  const close = (reason: SseCloseReason): void => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    onDrain()
    res.removeListener('drain', onDrain)
    unsubscribe()
    slot.release()
    deps.onClose?.(reason)
    if (reason === 'backpressure') res.destroy() // cliente que não lê: descarta o buffer pendente e o socket
    else if (reason !== 'client_closed' && !res.writableEnded) res.end()
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

  /**
   * ÚNICO ponto de escrita do stream. `write() === false` NÃO derruba: abre o prazo do `drain` (ver
   * o cabeçalho). Só o estouro do teto de bytes pendentes derruba na hora.
   */
  const write = (chunk: string): void => {
    if (closed) return
    const withoutBackpressure = res.write(chunk)
    if ((res.writableLength ?? 0) > maxBufferedBytes) return close('backpressure')
    if (withoutBackpressure || drainDeadline) return
    drainDeadline = setTimeout(() => close('backpressure'), drainTimeoutMs)
    drainDeadline.unref?.()
    res.once('drain', onDrain)
  }

  res.on('close', () => close('client_closed'))
  res.on('error', () => close('write_error'))

  // Primeiro byte imediato — alguns proxies só liberam a resposta ao cliente depois do primeiro write.
  write(': ok\n\n')
  if (closed) return

  unsubscribe = deps.subscribe(channels, (event, raw) => {
    // Uma só escrita por evento; `raw` já é o JSON publicado (sem quebra de linha: JSON.stringify escapa).
    write(`event: ${event.type}\ndata: ${raw}\n\n`)
  })

  heartbeat = setInterval(() => {
    void (async () => {
      if (closed) return
      if (tokenExpirado(user.exp, now())) return close('token_expired')
      const validacao = await deps.validateSession(user).catch(() => ({ ok: true }))
      if (closed) return
      if (!validacao.ok) return close('session_revoked')
      write(': ping\n\n')
    })()
  }, deps.heartbeatMs)
  heartbeat.unref?.()
}
