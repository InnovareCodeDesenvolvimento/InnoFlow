import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { operatorScopeWhere, requireOperatorOrAdmin, resolveOperatorIdForWrite } from '../middleware/tenantScope'
import { validateBody, validateQuery } from '../middleware/validate'
import { paginationMeta, paginationQuerySchema, type PaginationQuery } from '../schemas/pagination.schema'
import { createSiteSchema, updateSiteSchema, type CreateSiteInput, type UpdateSiteInput } from '../schemas/site.schema'

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

router.get(
  '/',
  validateQuery(paginationQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as PaginationQuery
    const where = operatorScopeWhere(req)

    const [items, total] = await Promise.all([
      prisma.site.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      prisma.site.count({ where }),
    ])

    res.json({ items, meta: paginationMeta(page, pageSize, total) })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const site = await prisma.site.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!site) throw new AppError('Site não encontrado.', 404, 'NOT_FOUND')
    res.json(site)
  }),
)

router.post(
  '/',
  validateBody(createSiteSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as CreateSiteInput
    const operatorId = resolveOperatorIdForWrite(req, body.operatorId)

    const site = await prisma.site.create({
      data: {
        operatorId,
        name: body.name,
        addressLine: body.addressLine,
        city: body.city,
        state: body.state,
        postalCode: body.postalCode,
        country: body.country,
        latitude: body.latitude,
        longitude: body.longitude,
        timezone: body.timezone,
        openingHours: body.openingHours,
      },
    })

    res.status(201).json(site)
  }),
)

router.patch(
  '/:id',
  validateBody(updateSiteSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.site.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Site não encontrado.', 404, 'NOT_FOUND')

    const body = req.body as UpdateSiteInput
    const site = await prisma.site.update({ where: { id: existing.id }, data: body })
    res.json(site)
  }),
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.site.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Site não encontrado.', 404, 'NOT_FOUND')

    // Soft delete: Site tem FKs Restrict de ChargePoint/ChargingSession —
    // apagar de verdade quebraria histórico. `active: false` é o padrão de
    // "desativado" em todo o schema do Cronos.
    await prisma.site.update({ where: { id: existing.id }, data: { active: false } })
    res.status(204).send()
  }),
)

export default router
