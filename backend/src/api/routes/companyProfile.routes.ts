import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { atualizarPerfilEmpresa } from '../../services/legal/atualizarPerfilEmpresa'
import { getDadosLegaisEstrito, getLinhaDoPerfilEstrita } from '../../services/legal/dadosLegais'
import { toCompanyProfileDto } from '../../services/legal/perfilEmpresaDto'
import { asyncHandler } from '../middleware/asyncHandler'
import { auditCtx } from '../middleware/auditTrail'
import { authenticate, requireRole } from '../middleware/auth'
import { companyProfileWriteRateLimit } from '../middleware/rateLimit'
import { validateBody } from '../middleware/validate'
import { updateCompanyProfileSchema, type UpdateCompanyProfileBody } from '../schemas/companyProfile.schema'

/**
 * Dados da empresa (controlador) e versões dos Termos/Privacidade — `/api/admin/company-profile`. ADMIN-ONLY. Contrato LITERAL em `docs/CONTRATO-EMPRESA-ADMIN.md`.
 * Sem segredos (tudo é público por natureza), então sem cifragem e sem step-up de senha; em compensação cada PUT é auditado (nomes dos campos; valores só do que não é dado de pessoa).
 * O que esta tela grava alimenta `GET /api/public/legal`, o rodapé dos e-mails ao motorista e a versão exigida no aceite dos termos.
 */
const router = Router()

router.use(authenticate, requireRole('ADMIN'))

async function dtoAtual() {
  const [dados, linha] = await Promise.all([getDadosLegaisEstrito(), getLinhaDoPerfilEstrita()])
  return toCompanyProfileDto(dados, linha)
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await dtoAtual())
  }),
)

router.put(
  '/',
  companyProfileWriteRateLimit,
  validateBody(updateCompanyProfileSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as UpdateCompanyProfileBody
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.userId }, select: { email: true, name: true } })
    await atualizarPerfilEmpresa({
      body,
      actor: { userId: req.user!.userId, role: req.user!.role, email: actor.email, name: actor.name, operatorId: req.user!.operatorId ?? null },
      request: {
        method: req.method,
        path: req.originalUrl.split('?')[0] ?? '',
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        requestId: (req as { id?: string | number }).id != null ? String((req as { id?: string | number }).id) : null,
      },
    })
    // A linha de auditoria JÁ foi gravada (fail-closed, na mesma transação): `skip` evita o middleware genérico duplicar.
    auditCtx(res).describe({ skip: true })
    res.json(await dtoAtual())
  }),
)

export default router
