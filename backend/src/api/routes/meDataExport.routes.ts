import { Router } from 'express'
import { logger } from '../../lib/logger'
import { prisma } from '../../lib/prisma'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { cotaDiariaDeExportacao } from '../middleware/exportQuota'
import { meDataExportRateLimit } from '../middleware/lgpdRateLimit'
import { metaDaRequisicao } from '../lib/metaDaRequisicao'
import { nomeDoArquivoDeExportacao, TAMANHO_ALERTA_BYTES } from '../../core/lgpd/exportacao'
import { exportarDadosDoTitular } from '../../services/lgpd/exportarDadosDoTitular'
import { writeAuditLog } from '../../services/auditoria/writeAuditLog'

/**
 * `GET /api/me/data-export` (L1.4, LGPD art. 18) — exportação dos dados do TITULAR. DRIVER only; NENHUM `userId` vem de body/query/param (sempre `req.user!.userId`).
 * Contrato: `MeDataExport` em `frontend/src/types/api.ts`. 3 por dia por usuário (429 `RATE_LIMITED_EXPORT`), auditada (`EXPORT`), teto de linhas por coleção.
 */
const router = Router()
router.use(authenticate, requireRole('DRIVER'))

router.get(
  '/',
  meDataExportRateLimit,
  cotaDiariaDeExportacao,
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const dados = await exportarDadosDoTitular(userId)
    const corpo = JSON.stringify(dados)
    const bytes = Buffer.byteLength(corpo, 'utf8')
    if (bytes > TAMANHO_ALERTA_BYTES) {
      logger.warn({ userId, bytes }, '[lgpd] exportação passou de 5 MB — o plano manda virar job assíncrono com link por e-mail')
    }

    // Auditoria da extração ANTES de entregar os dados e FAIL-CLOSED: se a linha não grava, o titular não recebe o arquivo (a regra do projeto é "extração é auditada").
    const ator = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true, role: true } })
    if (!ator) throw new AppError('Conta não encontrada.', 404, 'NOT_FOUND')
    await writeAuditLog({
      actorUserId: userId,
      actorRole: ator.role,
      actorEmail: ator.email,
      actorName: ator.name,
      action: 'EXPORT',
      actionDetail: 'data_export',
      outcome: 'SUCCESS',
      httpStatus: 200,
      entityType: 'User',
      entityId: userId,
      method: 'GET',
      path: '/api/me/data-export',
      ...metaDaRequisicao(req),
    })

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${nomeDoArquivoDeExportacao(new Date(dados.exportedAt))}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(corpo)
  }),
)

export default router
