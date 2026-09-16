import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { operatorScopeWhere, requireOperatorOrAdmin, resolveOperatorIdForWrite } from '../middleware/tenantScope'
import { validateBody, validateQuery } from '../middleware/validate'
import { paginationMeta, paginationQuerySchema, type PaginationQuery } from '../schemas/pagination.schema'
import { createTariffSchema, updateTariffSchema, type CreateTariffInput, type UpdateTariffInput } from '../schemas/tariff.schema'

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

router.get(
  '/',
  validateQuery(paginationQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as PaginationQuery
    const where = operatorScopeWhere(req)

    const [items, total] = await Promise.all([
      prisma.tariff.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      prisma.tariff.count({ where }),
    ])

    res.json({ items, meta: paginationMeta(page, pageSize, total) })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const tariff = await prisma.tariff.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!tariff) throw new AppError('Tarifa não encontrada.', 404, 'NOT_FOUND')
    res.json(tariff)
  }),
)

router.post(
  '/',
  validateBody(createTariffSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as CreateTariffInput
    const operatorId = resolveOperatorIdForWrite(req, body.operatorId)

    const tariff = await prisma.tariff.create({
      data: {
        operatorId,
        name: body.name,
        model: body.model,
        pricePerKwh: body.pricePerKwh,
        pricePerMinute: body.pricePerMinute,
        sessionFeeCents: body.sessionFeeCents,
        minChargeCents: body.minChargeCents,
        idleFeePerMinute: body.idleFeePerMinute,
        idleGracePeriodSeconds: body.idleGracePeriodSeconds,
        currency: body.currency,
      },
    })

    res.status(201).json(tariff)
  }),
)

router.patch(
  '/:id',
  validateBody(updateTariffSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.tariff.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Tarifa não encontrada.', 404, 'NOT_FOUND')

    const body = req.body as UpdateTariffInput
    const tariff = await prisma.tariff.update({ where: { id: existing.id }, data: body })
    res.json(tariff)
  }),
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.tariff.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Tarifa não encontrada.', 404, 'NOT_FOUND')
    await prisma.tariff.update({ where: { id: existing.id }, data: { active: false } })
    res.status(204).send()
  }),
)

export default router
