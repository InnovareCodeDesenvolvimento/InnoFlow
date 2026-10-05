import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { validateBody, validateParams, validateQuery } from '../middleware/validate'
import { auditCtx } from '../middleware/auditTrail'
import { AppError } from '../middleware/errorHandler'
import { accountDeletionRefundRateLimit } from '../middleware/lgpdRateLimit'
import { paginationMeta } from '../schemas/pagination.schema'
import {
  adminAccountDeletionParamsSchema,
  adminAccountDeletionRefundSchema,
  adminAccountDeletionsQuerySchema,
  type AdminAccountDeletionRefundInput,
  type AdminAccountDeletionsQuery,
} from '../schemas/accountDeletion.schema'
import { listarPedidosDeDevolucao, registrarDevolucaoManual } from '../../services/lgpd/devolucaoDeSaldo'
import { exigirSenhaAtual, StepUpRateLimitedError } from '../../services/auth/stepUpSenha'

/**
 * `/api/admin/account-deletions` (L1.4, DL2) — a fila do ADMIN para devolver por Pix o saldo de quem excluiu a conta. ADMIN-ONLY (não existe OPERATOR aqui: o saldo é da REDE, não de um
 * operador). Contrato: `AdminAccountDeletionRow` / `AdminAccountDeletionRefundRequest` em `frontend/src/types/api.ts`.
 *
 *  - `GET  /`           — lista paginada (`status`, `page`, `pageSize`). Decifra a chave Pix só dos pedidos `PENDING_REFUND`; quando a página traz alguma chave, a leitura é AUDITADA
 *                         (`EXPORT` / `pix_refund_keys_viewed`): é a única rota que mostra a chave de um titular a um humano.
 *  - `POST /:id/refund` — registra a devolução (valor INTEGRAL, `TOPUP_REFUND`, apaga a chave). Step-up de senha do ADMIN (mesmo mecanismo do gateway) e auditoria fail-closed.
 */
const router = Router()

router.use(authenticate, requireRole('ADMIN'))

router.get(
  '/',
  validateQuery(adminAccountDeletionsQuerySchema),
  asyncHandler(async (req, res) => {
    const { status, page, pageSize } = req.query as unknown as AdminAccountDeletionsQuery
    const { items, total } = await listarPedidosDeDevolucao({ status, page, pageSize })
    res.setHeader('Cache-Control', 'no-store') // a resposta pode trazer chave Pix de titular
    res.json({ items, meta: paginationMeta(page, pageSize, total) })

    if (items.some((i) => i.refundPixKey !== null)) {
      auditCtx(res).describe({ action: 'EXPORT', actionDetail: 'pix_refund_keys_viewed', entityType: 'AccountDeletionRequest', forceAudit: true })
    }
  }),
)

router.post(
  '/:id/refund',
  accountDeletionRefundRateLimit,
  validateParams(adminAccountDeletionParamsSchema),
  validateBody(adminAccountDeletionRefundSchema),
  asyncHandler(async (req, res) => {
    const { amountCents, proofReference, currentPassword } = req.body as AdminAccountDeletionRefundInput
    const adminId = req.user!.userId

    try {
      await exigirSenhaAtual({ userId: adminId, senhaInformada: currentPassword }, undefined, 'RATE_LIMITED_ACCOUNT_DELETION')
    } catch (err) {
      if (err instanceof StepUpRateLimitedError) res.setHeader('Retry-After', String(err.retryAfterSeconds))
      throw err
    }

    const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { email: true, name: true, operatorId: true } })
    if (!admin) throw new AppError('Token inválido ou expirado.', 401, 'UNAUTHORIZED')

    const rawId = (req as { id?: string | number }).id
    const pedido = await registrarDevolucaoManual({
      requestId: req.params.id as string,
      amountCents,
      proofReference,
      actor: { userId: adminId, email: admin.email, name: admin.name, operatorId: admin.operatorId },
      request: { method: req.method, path: req.originalUrl.split('?')[0] as string, ipAddress: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined) ?? null, requestId: rawId != null ? String(rawId) : null },
    })

    res.setHeader('Cache-Control', 'no-store')
    res.json(pedido)

    // A linha de auditoria JÁ foi gravada (fail-closed, na MESMA transação do lançamento) — `skip` evita o middleware genérico duplicar.
    auditCtx(res).describe({ skip: true })
  }),
)

export default router
