import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { auditCtx } from '../middleware/auditTrail'
import { operatorScopeWhere, requireOperatorOrAdmin } from '../middleware/tenantScope'
import { validateBody, validateQuery } from '../middleware/validate'
import { paginationMeta, paginationQuerySchema, type PaginationQuery } from '../schemas/pagination.schema'
import { createConnectorSchema, updateConnectorSchema, type CreateConnectorInput, type UpdateConnectorInput } from '../schemas/connector.schema'
import { diffEntity } from '../../core/auditoria/diffEntity'
import { AUDIT_ALLOWLIST_BY_ENTITY } from '../lib/auditAllowlists'

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

router.get(
  '/',
  validateQuery(paginationQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as PaginationQuery
    const where = operatorScopeWhere(req)

    const [items, total] = await Promise.all([
      prisma.connector.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      prisma.connector.count({ where }),
    ])

    res.json({ items, meta: paginationMeta(page, pageSize, total) })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const connector = await prisma.connector.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!connector) throw new AppError('Conector não encontrado.', 404, 'NOT_FOUND')
    res.json(connector)
  }),
)

router.post(
  '/',
  validateBody(createConnectorSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as CreateConnectorInput

    const chargePoint = await prisma.chargePoint.findFirst({ where: { id: body.chargePointId, ...operatorScopeWhere(req) } })
    if (!chargePoint) throw new AppError('Charge point não encontrado.', 404, 'NOT_FOUND')

    const connector = await prisma.connector.create({
      data: {
        // Idem chargePoints.routes.ts: reescrito por trigger, mandamos o
        // valor certo só para satisfazer o tipo obrigatório do Prisma.
        operatorId: chargePoint.operatorId,
        chargePointId: chargePoint.id,
        connectorId: body.connectorId,
        type: body.type,
        maxPowerKw: body.maxPowerKw,
      },
    })

    res.status(201).json(connector)

    auditCtx(res).describe({
      entityType: 'Connector',
      entityId: connector.id,
      targetOperatorId: connector.operatorId,
      changes: diffEntity(null, connector, AUDIT_ALLOWLIST_BY_ENTITY.Connector),
    })
  }),
)

router.patch(
  '/:id',
  validateBody(updateConnectorSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.connector.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Conector não encontrado.', 404, 'NOT_FOUND')

    const body = req.body as UpdateConnectorInput
    const connector = await prisma.connector.update({ where: { id: existing.id }, data: body })
    res.json(connector)

    auditCtx(res).describe({
      entityType: 'Connector',
      entityId: connector.id,
      targetOperatorId: connector.operatorId,
      changes: diffEntity(existing, connector, AUDIT_ALLOWLIST_BY_ENTITY.Connector),
    })
  }),
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.connector.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Conector não encontrado.', 404, 'NOT_FOUND')
    // Connector não tem coluna `active` no schema do Cronos — desativar de
    // verdade é marcar UNAVAILABLE, o equivalente operacional.
    const connector = await prisma.connector.update({ where: { id: existing.id }, data: { status: 'UNAVAILABLE' } })
    res.status(204).send()

    auditCtx(res).describe({
      entityType: 'Connector',
      entityId: connector.id,
      targetOperatorId: connector.operatorId,
      changes: diffEntity(existing, connector, AUDIT_ALLOWLIST_BY_ENTITY.Connector),
    })
  }),
)

export default router
