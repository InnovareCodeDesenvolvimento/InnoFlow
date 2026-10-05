import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { validateBody } from '../middleware/validate'
import { meAccountDeletionRateLimit } from '../middleware/lgpdRateLimit'
import { accountDeletionSchema, type AccountDeletionInput } from '../schemas/accountDeletion.schema'
import { confirmarIdentidadeDoTitular } from '../../services/lgpd/confirmarIdentidadeDoTitular'
import { excluirContaDoMotorista } from '../../services/lgpd/excluirConta'
import { StepUpRateLimitedError } from '../../services/auth/stepUpSenha'

/**
 * `POST /api/me/account/deletion` (L1.4, LGPD art. 18 VI) — exclusão/anonimização da conta do MOTORISTA. DRIVER only; o dono é SEMPRE `req.user!.userId` (`.strict()` no schema recusa até
 * um `userId` no corpo). Contrato: `MeAccountDeletionRequest/Response` e `MeAccountDeletionErrorCode` em `frontend/src/types/api.ts`.
 * Reautenticação obrigatória (senha com tranca por tentativas, ou ID token do Google para conta só-Google) ANTES de qualquer consulta de estado; depois, uma transação (ver `excluirConta.ts`).
 */
const router = Router()
router.use(authenticate, requireRole('DRIVER'))

router.post(
  '/deletion',
  meAccountDeletionRateLimit,
  validateBody(accountDeletionSchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const { currentPassword, googleCredential, refundPixKey } = req.body as AccountDeletionInput

    try {
      // Quem só tem o token não descobre nada da conta (dívida, sessão, saldo) nem gasta tentativa de senha "de graça".
      await confirmarIdentidadeDoTitular(userId, { currentPassword, googleCredential })
    } catch (err) {
      if (err instanceof StepUpRateLimitedError) res.setHeader('Retry-After', String(err.retryAfterSeconds))
      throw err
    }

    const resultado = await excluirContaDoMotorista({ userId, refundPixKey })
    // `resultado.notificar` (e-mail/nome ANTES de anonimizar) é o insumo do aviso `ACCOUNT_DELETED` (L1.6) — o enfileiramento é de quem implementa as notificações.
    res.status(200).json({ status: resultado.status })
  }),
)

export default router
