import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { validateBody } from '../middleware/validate'
import { meAccountDeletionRateLimit } from '../middleware/lgpdRateLimit'
import { accountDeletionSchema, type AccountDeletionInput } from '../schemas/accountDeletion.schema'
import { confirmarIdentidadeDoTitular } from '../../services/lgpd/confirmarIdentidadeDoTitular'
import { excluirContaDoMotorista } from '../../services/lgpd/excluirConta'
import { StepUpRateLimitedError } from '../../services/auth/stepUpSenha'
import { notificarContaExcluida } from '../../services/notificacoes/gatilhos'

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
    res.status(200).json({ status: resultado.status })

    // L1.6 (DL5: sempre enviado): `resultado.notificar` (e-mail/nome capturados ANTES de anonimizar) vai SÓ no payload do job — some ao concluir (ver `worker/queues.ts`). `null` = 2ª chamada
    // concorrente (já havia sido excluída): nenhum 2º aviso. entityId = id do pedido de exclusão. Fire-and-forget, depois da resposta.
    if (resultado.notificar) notificarContaExcluida({ userId, requestId: resultado.requestId, email: resultado.notificar.email, nome: resultado.notificar.nome })
  }),
)

export default router
