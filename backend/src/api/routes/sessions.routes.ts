import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { sendCommand } from '../../ocpp/commands'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { auditCtx } from '../middleware/auditTrail'
import { operatorScopeWhere, requireOperatorOrAdmin } from '../middleware/tenantScope'

const COMMAND_TIMEOUT_MS = 35_000

/** Estados em que uma `ChargingSession` ainda pode ser parada remotamente — `STOPPED`/`FAULTED` já são terminais. */
const ACTIVE_SESSION_STATUSES = new Set(['STARTED', 'CHARGING', 'FINISHING'])

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

/**
 * `POST /api/admin/sessions/:id/stop` — 202 fire-and-forget, mesmo padrão de
 * `POST /api/admin/charge-points/:id/commands/*` (a rota não espera a
 * resposta do carregador, só dispara `RemoteStopTransaction` pelo barramento
 * Redis). A liquidação financeira de verdade acontece no `StopTransaction`
 * real que o carregador manda de volta (ver `ocpp/handlers/stopTransaction.ts`)
 * — esta rota só PEDE a parada, não a garante.
 */
router.post(
  '/:id/stop',
  asyncHandler(async (req, res) => {
    const session = await prisma.chargingSession.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!session) throw new AppError('Sessão não encontrada.', 404, 'SESSION_NOT_FOUND')
    if (!ACTIVE_SESSION_STATUSES.has(session.status)) throw new AppError('Sessão não está ativa.', 409, 'SESSION_NOT_ACTIVE')

    const correlationId = randomUUID()
    logger.info({ sessionId: session.id, chargePointId: session.chargePointId, correlationId }, '[api] stop de sessão disparado')

    sendCommand(session.chargePointId, 'RemoteStopTransaction', { transactionId: session.ocppTransactionId }, { timeoutMs: COMMAND_TIMEOUT_MS })
      .then((result) => logger.info({ sessionId: session.id, correlationId, result }, '[api] stop de sessão concluído'))
      .catch((err) => logger.error({ err, sessionId: session.id, correlationId }, '[api] stop de sessão falhou'))

    res.status(202).json({ correlationId, status: 'PENDING' })

    // Intenção, não resultado (mesma regra do comando remoto ao charge
    // point) — o `StopTransaction` real (protocolo OCPP) é quem de fato
    // fecha a sessão e cobra.
    auditCtx(res).describe({
      entityType: 'ChargingSession',
      entityId: session.id,
      action: 'REMOTE_COMMAND',
      actionDetail: 'RemoteStopTransaction',
      correlationId,
    })
  }),
)

export default router
