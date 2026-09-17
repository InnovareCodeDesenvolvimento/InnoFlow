import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { operatorScopeWhere, requireOperatorOrAdmin, resolveOperatorIdForWrite } from '../middleware/tenantScope'
import { validateBody, validateQuery } from '../middleware/validate'
import { paginationMeta, paginationQuerySchema, type PaginationQuery } from '../schemas/pagination.schema'
import {
  createTariffAssignmentSchema,
  tariffAssignmentQuerySchema,
  updateTariffAssignmentSchema,
  type CreateTariffAssignmentInput,
  type TariffAssignmentFilterQuery,
  type UpdateTariffAssignmentInput,
} from '../schemas/tariffAssignment.schema'

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

const listQuerySchema = paginationQuerySchema.merge(tariffAssignmentQuerySchema)

router.get(
  '/',
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize, tariffId, siteId, chargePointId, connectorId, scope } = req.query as unknown as PaginationQuery & TariffAssignmentFilterQuery
    const where = {
      ...operatorScopeWhere(req),
      ...(tariffId && { tariffId }),
      ...(siteId && { siteId }),
      ...(chargePointId && { chargePointId }),
      ...(connectorId && { connectorId }),
      ...(scope && { scope }),
    }

    const [items, total] = await Promise.all([
      prisma.tariffAssignment.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: { tariff: { select: { id: true, name: true, model: true } } },
      }),
      prisma.tariffAssignment.count({ where }),
    ])

    res.json({ items, meta: paginationMeta(page, pageSize, total) })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const assignment = await prisma.tariffAssignment.findFirst({
      where: { id: req.params.id, ...operatorScopeWhere(req) },
      include: { tariff: { select: { id: true, name: true, model: true } } },
    })
    if (!assignment) throw new AppError('Vínculo de tarifa não encontrado.', 404, 'NOT_FOUND')
    res.json(assignment)
  }),
)

router.post(
  '/',
  validateBody(createTariffAssignmentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as CreateTariffAssignmentInput
    const operatorId = resolveOperatorIdForWrite(req, body.operatorId)

    const tariff = await prisma.tariff.findFirst({ where: { id: body.tariffId, operatorId } })
    if (!tariff) throw new AppError('Tarifa não encontrada.', 404, 'NOT_FOUND')

    // Confere que o alvo do vínculo (site/charge point/conector) pertence ao
    // MESMO operador da tarifa — nunca confiar no `id` que o cliente manda
    // sem provar que ele está no escopo de quem está autenticado.
    if (body.scope === 'SITE') {
      const site = await prisma.site.findFirst({ where: { id: body.siteId!, operatorId } })
      if (!site) throw new AppError('Site não encontrado.', 404, 'NOT_FOUND')
    } else if (body.scope === 'CHARGE_POINT') {
      const chargePoint = await prisma.chargePoint.findFirst({ where: { id: body.chargePointId!, operatorId } })
      if (!chargePoint) throw new AppError('Charge point não encontrado.', 404, 'NOT_FOUND')
    } else if (body.scope === 'CONNECTOR') {
      const connector = await prisma.connector.findFirst({ where: { id: body.connectorId!, operatorId } })
      if (!connector) throw new AppError('Conector não encontrado.', 404, 'NOT_FOUND')
    }

    const assignment = await prisma.tariffAssignment.create({
      data: {
        operatorId,
        tariffId: body.tariffId,
        scope: body.scope,
        siteId: body.scope === 'SITE' ? body.siteId : undefined,
        chargePointId: body.scope === 'CHARGE_POINT' ? body.chargePointId : undefined,
        connectorId: body.scope === 'CONNECTOR' ? body.connectorId : undefined,
        priority: body.priority,
        validFrom: body.validFrom,
        validTo: body.validTo,
      },
    })

    res.status(201).json(assignment)
  }),
)

router.patch(
  '/:id',
  validateBody(updateTariffAssignmentSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.tariffAssignment.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Vínculo de tarifa não encontrado.', 404, 'NOT_FOUND')

    const body = req.body as UpdateTariffAssignmentInput

    if (body.tariffId) {
      const tariff = await prisma.tariff.findFirst({ where: { id: body.tariffId, operatorId: existing.operatorId } })
      if (!tariff) throw new AppError('Tarifa não encontrada.', 404, 'NOT_FOUND')
    }

    const assignment = await prisma.tariffAssignment.update({ where: { id: existing.id }, data: body })
    res.json(assignment)
  }),
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.tariffAssignment.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Vínculo de tarifa não encontrado.', 404, 'NOT_FOUND')
    // TariffAssignment não tem coluna `active` (idem Connector) — "desativar"
    // de verdade é expirar a janela de validade agora, o que já é
    // exatamente o critério que `resolveActiveTariff` usa para ignorá-la
    // (`validTo: { gte: now } | null`). Preserva o histórico em vez de
    // apagar a linha.
    await prisma.tariffAssignment.update({ where: { id: existing.id }, data: { validTo: new Date() } })
    res.status(204).send()
  }),
)

export default router
