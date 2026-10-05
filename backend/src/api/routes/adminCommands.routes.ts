import { Router } from 'express'
import { z } from 'zod'
import { getCommandRecordForStaff } from '../../ocpp/commandResultCache'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { buscarSessaoDoRemoteStart } from '../../services/sessao/buscarSessaoDoRemoteStart'
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
 * - `sessionId` (aditivo): SÓ quando `status === 'ACCEPTED'` e o comando é um remote-start. É o id da sessão nascida dele, ou `null` se o carregador aceitou mas o `StartTransaction` ainda não chegou
 *   (a sessão nasce lá — o cliente refaz a consulta). Achada pelo idTag virtual do comando + motorista + charge point + escopo do operador (`services/sessao/buscarSessaoDoRemoteStart.ts`).
 *   Nos demais status e nos comandos que não são remote-start a chave NÃO vem no JSON.
 * - 404 `COMMAND_NOT_FOUND` = inexistente, EXPIRADO (TTL de 2 min) ou fora do escopo — indistinguíveis de propósito (não confirma que um correlationId de outro operador existe).
 */
const router = Router()

router.use(authenticate, requireOperatorOrAdmin, requireRecargaRemotaPolicy)

const paramsSchema = z.object({ correlationId: z.string().uuid() })

router.get(
  '/:correlationId',
  validateParams(paramsSchema),
  asyncHandler(async (req, res) => {
    const scope = operatorScopeWhere(req)
    const record = await getCommandRecordForStaff(req.params.correlationId, scope)
    if (record === null) throw new AppError('Comando não encontrado ou expirado.', 404, 'COMMAND_NOT_FOUND')
    if (record.status === 'ACCEPTED' && record.idTag) {
      res.json({ status: record.status, sessionId: await buscarSessaoDoRemoteStart(record, scope) })
      return
    }
    res.json({ status: record.status })
  }),
)

export default router
