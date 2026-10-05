import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { validateBody } from '../middleware/validate'
import { meNotificationPreferencesWriteRateLimit } from '../middleware/notificationRateLimit'
import { updateNotificationPreferencesSchema, type UpdateNotificationPreferencesInput } from '../schemas/notificationPreferences.schema'
import { atualizarPreferencias, lerPreferencias } from '../../services/notificacoes/preferencias'

/**
 * `/api/me/notification-preferences` (L1.6, DL5) — preferências de e-mail do MOTORISTA. DRIVER only. NENHUM `userId` vem de body/query/param: o dono é SEMPRE `req.user!.userId`
 * (`.strict()` no schema recusa até um `userId` no corpo) — não há como ler ou mudar a preferência de outra pessoa (IDOR). Contrato: `MeNotificationPreferences` /
 * `UpdateMeNotificationPreferencesRequest` em `frontend/src/types/api.ts`.
 * Só existe chave para o que é OPCIONAL (recibo, saldo baixo e o limiar). Segurança e cobrança (`PASSWORD_CHANGED`, `SESSION_PAYMENT_FAILED`, `ACCOUNT_DELETED`) são sempre enviados
 * e não aparecem aqui: tentar mandar qualquer outro campo é 400 `VALIDATION_ERROR`.
 */
const router = Router()

router.use(authenticate, requireRole('DRIVER'))

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await lerPreferencias(req.user!.userId))
  }),
)

router.patch(
  '/',
  meNotificationPreferencesWriteRateLimit,
  validateBody(updateNotificationPreferencesSchema),
  asyncHandler(async (req, res) => {
    res.json(await atualizarPreferencias(req.user!.userId, req.body as UpdateNotificationPreferencesInput))
  }),
)

export default router
