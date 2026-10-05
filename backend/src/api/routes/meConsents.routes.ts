import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { validateBody } from '../middleware/validate'
import { meConsentsWriteRateLimit } from '../middleware/lgpdRateLimit'
import { consentsAcceptSchema, type ConsentsAcceptInput } from '../schemas/consents.schema'
import { registrarReaceite, statusDoConsentimento } from '../../services/legal/consentimento'

/**
 * `GET/POST /api/me/consents` (L1.9) — status do aceite dos termos e novo aceite (modal de reaceite quando a versão vigente muda). DRIVER only; o dono é sempre `req.user!.userId`.
 * Contrato: `MeConsentStatus` / `MeAcceptConsentsRequest` em `frontend/src/types/api.ts`. O POST é idempotente (mesma versão não duplica) e responde 201.
 */
const router = Router()
router.use(authenticate, requireRole('DRIVER'))

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await statusDoConsentimento(req.user!.userId))
  }),
)

router.post(
  '/',
  meConsentsWriteRateLimit,
  validateBody(consentsAcceptSchema),
  asyncHandler(async (req, res) => {
    const { termsVersion, privacyVersion } = req.body as ConsentsAcceptInput
    const status = await registrarReaceite({ userId: req.user!.userId, termsVersion, privacyVersion, ip: req.ip })
    res.status(201).json(status)
  }),
)

export default router
