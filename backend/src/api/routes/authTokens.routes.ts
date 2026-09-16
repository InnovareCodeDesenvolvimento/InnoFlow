import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { validateBody, validateQuery } from '../middleware/validate'
import { paginationMeta, paginationQuerySchema, type PaginationQuery } from '../schemas/pagination.schema'
import { createAuthTokenSchema, updateAuthTokenSchema, type CreateAuthTokenInput, type UpdateAuthTokenInput } from '../schemas/authToken.schema'

/**
 * DECISÃO (documentada, não pedida explicitamente): `AuthToken` não tem
 * coluna `operatorId` no schema do Cronos — é identidade de rede (o mesmo
 * RFID/idTag pode ser usado em qualquer operador, igual ao motorista). Não
 * há como aplicar o isolamento `OPERATOR só vê o próprio operatorId` numa
 * entidade que não carrega esse campo. Por segurança, restringi esta rota
 * inteira a `ADMIN` até o dono/Nova decidirem se operadores devem enxergar
 * (e em que medida) tokens de outros operadores. Ver PARA O PRÓXIMO no
 * handoff.
 */
const router = Router()

router.use(authenticate, requireRole('ADMIN'))

router.get(
  '/',
  validateQuery(paginationQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as PaginationQuery
    const [items, total] = await Promise.all([
      prisma.authToken.findMany({ skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      prisma.authToken.count(),
    ])
    res.json({ items, meta: paginationMeta(page, pageSize, total) })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const token = await prisma.authToken.findUnique({ where: { id: req.params.id } })
    if (!token) throw new AppError('Token não encontrado.', 404, 'NOT_FOUND')
    res.json(token)
  }),
)

router.post(
  '/',
  validateBody(createAuthTokenSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as CreateAuthTokenInput
    const token = await prisma.authToken.create({
      data: { idTag: body.idTag, type: body.type, userId: body.userId, expiresAt: body.expiresAt },
    })
    res.status(201).json(token)
  }),
)

router.patch(
  '/:id',
  validateBody(updateAuthTokenSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.authToken.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new AppError('Token não encontrado.', 404, 'NOT_FOUND')

    const body = req.body as UpdateAuthTokenInput
    const token = await prisma.authToken.update({ where: { id: existing.id }, data: body })
    res.json(token)
  }),
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.authToken.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new AppError('Token não encontrado.', 404, 'NOT_FOUND')
    await prisma.authToken.update({ where: { id: existing.id }, data: { status: 'BLOCKED' } })
    res.status(204).send()
  }),
)

export default router
