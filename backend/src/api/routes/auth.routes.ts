import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma'
import { issueToken } from '../../lib/jwt'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authRateLimit } from '../middleware/rateLimit'
import { validateBody } from '../middleware/validate'
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '../schemas/auth.schema'

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
    if (!user || !user.active || !user.passwordHash) {
      throw new AppError('E-mail ou senha inválidos.', 401, 'INVALID_CREDENTIALS')
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash)
    if (!passwordOk) throw new AppError('E-mail ou senha inválidos.', 401, 'INVALID_CREDENTIALS')

    const token = issueToken(user)
    res.json({ token, user: toUserDTO({ ...user, operatorName: user.operator?.name }) })
  }),
)

export default router
