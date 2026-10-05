import { Router } from 'express'
import { z } from 'zod'
import { getCommandStatusForStaff } from '../../ocpp/commandResultCache'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { requireRecargaRemotaPolicy } from '../middleware/recargaRemotaPolicy'
import { operatorScopeWhere, requireOperatorOrAdmin } from '../middleware/tenantScope'
import { validateParams } from '../middleware/validate'

/**
 * `GET /api/admin/commands/:correlationId` (L1.5) — resultado do comando de recarga remota disparado por `POST /api/admin/charge-points/:id/commands/remote-start`.
 * Contrato: `AdminCommandStatusResponse` em `frontend/src/types/api.ts`.
 *
 * - Mesma política de papel do disparo (DL4: só ADMIN no lote 1) — `requireRecargaRemotaPolicy`, regra única em `core/sessao/politicaRecargaRemota.ts`.
 * - ESCOPO por operador mesmo com a política fechada (defesa em profundidade; vale no dia em que OPERATOR for liberado): o registro carrega o `operatorId` onde o comando foi
 *   disparado (gravado pelo servidor) e `operatorScopeWhere(req)` decide o que o chamador enxerga.
 * - 404 `COMMAND_NOT_FOUND` = inexistente, EXPIRADO (TTL de 2 min) ou fora do escopo — indistinguíveis de propósito (não confirma que um correlationId de outro operador existe).
 */
const router = Router()

router.use(authenticate, requireOperatorOrAdmin, requireRecargaRemotaPolicy)

const paramsSchema = z.object({ correlationId: z.string().uuid() })

router.get(
  '/:correlationId',
  validateParams(paramsSchema),
  asyncHandler(async (req, res) => {
    const status = await getCommandStatusForStaff(req.params.correlationId, operatorScopeWhere(req))
    if (status === null) throw new AppError('Comando não encontrado ou expirado.', 404, 'COMMAND_NOT_FOUND')
    res.json({ status })
  }),
)

export default router
