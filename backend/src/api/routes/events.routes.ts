import { Router, type Request, type Response } from 'express'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { requireOperatorOrAdmin } from '../middleware/tenantScope'
import { ADMIN_CHANNEL, operatorChannel, subscribeChannels } from '../../realtime/bus'
import type { RealtimeEvent } from '../../realtime/events'
import { sessionValidator } from '../lib/sessionValidatorInstance'
import { tokenExpirado } from '../../core/auth/sessaoValida'

/**
 * `GET /api/admin/events` — canal SSE do painel admin/operador. Auth
 * IDÊNTICA ao resto da API (`Authorization: Bearer`, via `authenticate`) —
 * NUNCA JWT na querystring (vazaria em access log/histórico/Referer, ver
 * decisão 4 da Nova). Cliente consome com `fetch` + `ReadableStream`, não
 * `EventSource` nativo (que não manda header custom).
 *
 * Fronteira multi-tenant na ASSINATURA: ADMIN assina `ui:ev:admin` (todo
 * evento do sistema é replicado lá, ver `realtime/emit.ts`); OPERATOR
 * assina só o próprio canal (`ui:ev:op:{operatorId}`) — nunca os dois, nunca
 * um `if` depois de já ter recebido o evento de outro operador.
 */

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

router.get('/', (req: Request, res: Response) => {
  const channels = req.user!.role === 'ADMIN' ? [ADMIN_CHANNEL] : [operatorChannel(requireOperatorId(req))]
  startSseStream(req, res, channels)
})

function requireOperatorId(req: Request): string {
  const operatorId = req.user!.operatorId
  if (!operatorId) throw new AppError('Usuário operador sem operatorId associado.', 403, 'FORBIDDEN')
  return operatorId
}

/**
 * Mecânica compartilhada por qualquer endpoint SSE deste backend (usada
 * também por `/api/me/events`, ver `me.routes.ts`) — cabeçalhos, heartbeat
 * (`SSE_HEARTBEAT_INTERVAL_SECONDS`, evita o proxy cortar por inatividade),
 * assinatura dos canais e limpeza no `close`. Nunca chama `res.end()`
 * sozinha — a conexão fica aberta até o cliente desconectar.
 */
export function startSseStream(req: Request, res: Response, channels: string[]): void {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Redundância explícita com o bloco SSE do nginx (`frontend/nginx.conf.template`,
  // corrigido pelo Vulcano) — garante o comportamento correto mesmo se o
  // proxy da frente mudar de configuração.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  res.write(': ok\n\n') // primeiro byte imediato — alguns proxies só liberam a resposta ao cliente depois do primeiro write

  const unsubscribe = subscribeChannels(channels, (event: RealtimeEvent) => {
    res.write(`event: ${event.type}\n`)
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  })

  const cleanup = (): void => {
    clearInterval(heartbeat)
    unsubscribe()
  }

  // O JWT só é verificado ao ABRIR a conexão — sem re-checagem, um stream aberto sobrevive a
  // `exp`, conta desativada e senha trocada (Órion M1). A cada heartbeat: `exp` vencido ou
  // sessão revogada (cache de ~30s de `sessionValidator`) => encerra o stream. Falha TRANSITÓRIA
  // do banco não derruba o stream (fica para a próxima checagem).
  const user = req.user
  const heartbeat = setInterval(() => {
    void (async () => {
      if (user) {
        const validacao = await sessionValidator.validate(user.userId, user).catch(() => ({ ok: true as const }))
        if (tokenExpirado(user.exp, Date.now()) || !validacao.ok) {
          cleanup()
          res.end()
          return
        }
      }
      res.write(': ping\n\n')
    })()
  }, env.SSE_HEARTBEAT_INTERVAL_SECONDS * 1000)
  heartbeat.unref?.()

  req.on('close', cleanup)
  res.on('error', (err) => {
    logger.error({ err }, '[sse] erro na conexão — encerrando')
    cleanup()
  })
}

export default router
