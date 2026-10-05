import { Router } from 'express'
import { logger } from '../../lib/logger'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { meProfileWriteRateLimit } from '../middleware/rateLimit'
import { validateBody } from '../middleware/validate'
import { updateMeProfileSchema, type UpdateMeProfileInput } from '../schemas/meProfile.schema'
import { atualizarPerfil, obterPerfil } from '../../services/perfil/perfilMotorista'
import { writeAuditLog } from '../../services/auditoria/writeAuditLog'

/**
 * `/api/me/profile` (L1.2) — perfil do MOTORISTA. DRIVER only. NENHUM `userId` vem de body/query/param: o dono do perfil é sempre `req.user!.userId`
 * (`.strict()` no schema recusa até um `userId`/`email` no corpo). Contrato: `MeProfile` / `UpdateMeProfileRequest` em `frontend/src/types/api.ts`.
 * Troca de senha NÃO mora aqui: é `POST /api/auth/password` (já existe).
 */
const router = Router()

router.use(authenticate, requireRole('DRIVER'))

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await obterPerfil(req.user!.userId))
  }),
)

router.patch(
  '/',
  meProfileWriteRateLimit,
  validateBody(updateMeProfileSchema),
  asyncHandler(async (req, res) => {
    const resultado = await atualizarPerfil(req.user!.userId, req.body as UpdateMeProfileInput)
    res.json(resultado.perfil)

    if (resultado.camposAlterados.length === 0) return // nada mudou: nada a auditar

    // Auditoria (fire-and-forget, como o resto de /api/me e do login): SÓ os NOMES dos campos — nome/telefone/CPF são dado pessoal e a tabela é append-only.
    const rawId = (req as { id?: string | number }).id
    void writeAuditLog({
      actorUserId: resultado.ator.id,
      actorRole: resultado.ator.role,
      actorEmail: resultado.ator.email,
      actorName: resultado.ator.name,
      action: 'UPDATE',
      actionDetail: 'profile_updated',
      outcome: 'SUCCESS',
      httpStatus: 200,
      entityType: 'User',
      entityId: resultado.ator.id,
      method: 'PATCH',
      path: '/api/me/profile',
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: rawId != null ? String(rawId) : null,
      changes: { fieldNamesOnly: resultado.camposAlterados },
    }).catch((err) => logger.error({ err, userId: resultado.ator.id }, '[audit] falha ao gravar profile_updated (fire-and-forget)'))
  }),
)

export default router
