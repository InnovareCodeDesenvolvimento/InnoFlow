import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { requireOperatorOrAdmin } from '../middleware/tenantScope'
import { validateQuery } from '../middleware/validate'
import { paginationMeta, paginationQuerySchema, type PaginationQuery } from '../schemas/pagination.schema'

/**
 * Fecha a pendência que a Lyra deixou: campo `operatorId` texto livre nos
 * formulários de site/tarifa. ADMIN vê todos (paginado); OPERATOR recebe uma
 * lista com só o próprio operador — mesmo componente de frontend serve os
 * dois papéis (a Lyra só troca o `<select>` por um item fixo/desabilitado
 * quando a lista vier com um único resultado, decisão dela).
 */
const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

router.get(
  '/',
  validateQuery(paginationQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as PaginationQuery

    if (req.user!.role !== 'ADMIN') {
      if (!req.user!.operatorId) throw new AppError('Usuário operador sem operatorId associado.', 403, 'FORBIDDEN')
      const operator = await prisma.operator.findUnique({ where: { id: req.user!.operatorId } })
      res.json({ items: operator ? [operator] : [], meta: paginationMeta(1, 1, operator ? 1 : 0) })
      return
    }

    const [items, total] = await Promise.all([
      prisma.operator.findMany({ skip: (page - 1) * pageSize, take: pageSize, orderBy: { name: 'asc' } }),
      prisma.operator.count(),
    ])
    res.json({ items, meta: paginationMeta(page, pageSize, total) })
  }),
)

export default router
