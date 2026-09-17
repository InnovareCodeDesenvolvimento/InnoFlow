import { Router, type Request } from 'express'
import bcrypt from 'bcryptjs'
import type { Role } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { issueToken } from '../../lib/jwt'
import { logger } from '../../lib/logger'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authRateLimit } from '../middleware/rateLimit'
import { validateBody } from '../middleware/validate'
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '../schemas/auth.schema'
import { writeAuditLog } from '../../services/auditoria/writeAuditLog'

/**
 * Log de auditoria de LOGIN — fora do middleware genérico (`auditTrail()`,
 * montado só em `/api/admin`, e login não é uma dessas rotas). Regras
 * (Nova, decisoes-audit-log.md): só ADMIN/OPERATOR (motorista fica fora — é
 * o público majoritário do sistema, logaria toda recarga de QR code) e
 * `LOGIN_FAILED` só quando o e-mail já pertence a uma conta existente
 * (e-mail desconhecido = ruído de bot batendo na porta, não vira linha —
 * proteção contra inundação da tabela append-only).
 */
const AUDITABLE_LOGIN_ROLES = new Set<Role>(['ADMIN', 'OPERATOR'])

function requestMeta(req: Request) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    requestId: (req as { id?: string }).id ?? null,
  }
}

async function recordLoginAudit(
  req: Request,
  user: { id: string; role: Role; email: string; name: string; operatorId: string | null },
  outcome: 'LOGIN_SUCCESS' | 'LOGIN_FAILED',
  httpStatus: number,
): Promise<void> {
  if (!AUDITABLE_LOGIN_ROLES.has(user.role)) return
  await writeAuditLog({
    actorUserId: user.id,
    actorRole: user.role,
    actorEmail: user.email,
    actorName: user.name,
    actorOperatorId: user.operatorId,
    action: outcome,
    outcome: outcome === 'LOGIN_SUCCESS' ? 'SUCCESS' : 'FAILED',
    httpStatus,
    entityType: 'User',
    entityId: user.id,
    targetOperatorId: user.operatorId,
    method: 'POST',
    path: '/api/auth/login',
    ...requestMeta(req),
  })
}

const BCRYPT_ROUNDS = 10

const router = Router()

function toUserDTO(user: { id: string; name: string; email: string; role: string; operatorId: string | null; operatorName?: string | null }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, operatorId: user.operatorId, operatorName: user.operatorName ?? null }
}

router.post(
  '/register',
  authRateLimit,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password, phone } = req.body as RegisterInput

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new AppError('Já existe uma conta com este e-mail.', 409, 'EMAIL_TAKEN')

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, role: 'DRIVER' },
    })
    await prisma.wallet.create({ data: { userId: user.id } })

    const token = issueToken(user)
    res.status(201).json({ token, user: toUserDTO(user) })
  }),
)

router.post(
  '/login',
  authRateLimit,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as LoginInput

    const user = await prisma.user.findUnique({ where: { email }, include: { operator: { select: { name: true } } } })
    // E-mail desconhecido: NUNCA audita (ruído de bot — ver cabeçalho do
    // arquivo) e responde igual a qualquer outra credencial inválida (não
    // vaza se o e-mail existe ou não).
    if (!user) throw new AppError('E-mail ou senha inválidos.', 401, 'INVALID_CREDENTIALS')

    if (!user.active || !user.passwordHash) {
      void recordLoginAudit(req, { ...user, operatorId: user.operatorId }, 'LOGIN_FAILED', 401).catch((err) =>
        logger.error({ err, userId: user.id }, '[audit] falha ao gravar LOGIN_FAILED (fire-and-forget)'),
      )
      throw new AppError('E-mail ou senha inválidos.', 401, 'INVALID_CREDENTIALS')
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash)
    if (!passwordOk) {
      void recordLoginAudit(req, user, 'LOGIN_FAILED', 401).catch((err) => logger.error({ err, userId: user.id }, '[audit] falha ao gravar LOGIN_FAILED (fire-and-forget)'))
      throw new AppError('E-mail ou senha inválidos.', 401, 'INVALID_CREDENTIALS')
    }

    const token = issueToken(user)
    res.json({ token, user: toUserDTO({ ...user, operatorName: user.operator?.name }) })

    void recordLoginAudit(req, user, 'LOGIN_SUCCESS', 200).catch((err) => logger.error({ err, userId: user.id }, '[audit] falha ao gravar LOGIN_SUCCESS (fire-and-forget)'))
  }),
)

export default router
