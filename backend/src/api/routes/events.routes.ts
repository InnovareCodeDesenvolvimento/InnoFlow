import { Router, type Request, type Response } from 'express'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { sseConnectRateLimit } from '../middleware/rateLimit'
import { requireOperatorOrAdmin } from '../middleware/tenantScope'
import { ADMIN_CHANNEL, operatorChannel } from '../../realtime/bus'
import { openSseStream } from '../lib/sseStream'
import { sseDeps } from '../lib/sseDefaultDeps'

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
 *
 * Teto de streams, backpressure, re-checagem de sessão no heartbeat e assinante Redis
 * compartilhado: `api/lib/sseStream.ts` (Órion A2). Limite de ABERTURAS por usuário aqui
 * (`sseConnectRateLimit`) — este endpoint estava sem rate limit nenhum.
 */

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

router.get('/', sseConnectRateLimit, (req: Request, res: Response) => {
  const channels = req.user!.role === 'ADMIN' ? [ADMIN_CHANNEL] : [operatorChannel(requireOperatorId(req))]
  openSseStream(sseDeps, req, res, channels)
})

function requireOperatorId(req: Request): string {
  const operatorId = req.user!.operatorId
  if (!operatorId) throw new AppError('Usuário operador sem operatorId associado.', 403, 'FORBIDDEN')
  return operatorId
}

export default router
