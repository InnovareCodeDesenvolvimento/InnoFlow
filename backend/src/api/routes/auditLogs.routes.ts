import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { validateQuery } from '../middleware/validate'
import { paginationMeta } from '../schemas/pagination.schema'
import { auditLogActorsQuerySchema, auditLogQuerySchema, type AuditLogActorsQuery, type AuditLogQuery } from '../schemas/auditLog.schema'
import { resolveEffectivePeriod, resolvePeriodWindow } from '../lib/reportingWindow'
import { streamCsvReport } from '../lib/csvExport'

/**
 * `GET /api/admin/audit-logs*` — ADMIN-only de verdade (`requireRole('ADMIN')`,
 * NÃO `requireOperatorOrAdmin`: não existe OPERATOR nesta tela).
 *
 * `?format=csv` (aqui e nas 4 rotas de relatório existentes) vira
 * `action=EXPORT` automaticamente — o middleware genérico
 * (`api/middleware/auditTrail.ts`) já detecta `req.query.format === 'csv'`
 * sozinho, nenhuma chamada extra de `.describe()` precisa disto.
 *
 * Reaproveita `reportingWindow.ts` (presets de período) LITERALMENTE — NÃO
 * `reportingScope.ts` (é para a fronteira multi-tenant de OPERATOR, que não
 * existe aqui; `operatorId` é filtro opcional de conveniência).
 *
 * PERFORMANCE (nota honesta, não escondida): a listagem usa só query builder
 * do Prisma (sem `$queryRaw`, por pedido explícito) — não há como projetar
 * "changes IS NOT NULL" como booleano sem SQL cru nessa API, então
 * `hasChanges` é calculado buscando a coluna `changes` do Postgres e
 * DESCARTANDO o valor antes de montar a resposta JSON (o payload nunca sai
 * do processo Node para o cliente, mas ainda trafega Postgres->Node). Teto
 * real: 8KB (`AUDIT_LOG_CHANGES_MAX_BYTES`) × até 100 linhas/página = 800KB
 * no pior caso — aceitável para o volume estimado pela Nova (centenas a
 * ~50 mil linhas/dia), mas se esta tela ficar lenta na prática, a correção
 * é uma coluna `hasChanges BOOLEAN` denormalizada (Cronos) — mesmo padrão
 * de gatilho medido já usado em outras telas deste projeto.
 */

const router = Router()

router.use(authenticate, requireRole('ADMIN'))

interface AuditLogRow {
  id: string
  occurredAt: Date
  actorUserId: string
  actorRole: string
  actorEmail: string
  actorName: string
  actorOperatorId: string | null
  action: string
  actionDetail: string | null
  outcome: string
  httpStatus: number
  entityType: string | null
  entityId: string | null
  targetOperatorId: string | null
  method: string
  path: string
  ipAddress: string | null
  userAgent: string | null
  requestId: string | null
  correlationId: string | null
  changes: unknown
}

const LIST_SELECT = {
  id: true,
  occurredAt: true,
  actorUserId: true,
  actorRole: true,
  actorEmail: true,
  actorName: true,
  actorOperatorId: true,
  action: true,
  actionDetail: true,
  outcome: true,
  httpStatus: true,
  entityType: true,
  entityId: true,
  targetOperatorId: true,
  method: true,
  path: true,
  ipAddress: true,
  correlationId: true,
  changes: true, // ver nota de performance no cabeçalho — descartado antes da resposta
} as const

function toListItem(row: AuditLogRow) {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    actor: { userId: row.actorUserId, name: row.actorName, email: row.actorEmail, role: row.actorRole, operatorId: row.actorOperatorId },
    action: row.action,
    actionDetail: row.actionDetail,
    outcome: row.outcome,
    httpStatus: row.httpStatus,
    entityType: row.entityType,
    entityId: row.entityId,
    targetOperatorId: row.targetOperatorId,
    method: row.method,
    path: row.path,
    ipAddress: row.ipAddress,
    hasChanges: row.changes !== null && row.changes !== undefined,
  }
}

function buildWhere(query: AuditLogQuery, window: { from: Date; to: Date }): Record<string, unknown> {
  const where: Record<string, unknown> = { occurredAt: { gte: window.from, lt: window.to } }
  if (query.actorUserId) where.actorUserId = query.actorUserId
  if (query.actorRole) where.actorRole = query.actorRole
  if (query.action) where.action = query.action
  if (query.outcome) where.outcome = query.outcome
  if (query.entityType) where.entityType = query.entityType
  if (query.entityId) where.entityId = query.entityId
  if (query.operatorId) where.OR = [{ actorOperatorId: query.operatorId }, { targetOperatorId: query.operatorId }]
  if (query.q) {
    where.AND = [
      { OR: [{ actorEmail: { contains: query.q, mode: 'insensitive' } }, { actorName: { contains: query.q, mode: 'insensitive' } }, { entityId: { contains: query.q, mode: 'insensitive' } }] },
    ]
  }
  return where
}

router.get(
  '/',
  validateQuery(auditLogQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as AuditLogQuery
    const tz = query.tz ?? env.REPORTING_TIMEZONE
    const period = resolveEffectivePeriod(query.period, query.from, query.to)
    const window = resolvePeriodWindow({ period, from: query.from, to: query.to, tz })
    const where = buildWhere(query, window)

    if (query.format === 'csv') {
      await streamCsvReport<AuditLogRow>(
        res,
        { filename: 'audit-log.csv', headers: ['Data/Hora', 'Ator', 'Papel', 'Acao', 'Resultado', 'Status HTTP', 'Entidade', 'ID da Entidade', 'Metodo', 'Rota'] },
        (offset, limit) =>
          prisma.auditLog.findMany({ where, select: LIST_SELECT, orderBy: { occurredAt: 'desc' }, skip: offset, take: limit }) as unknown as Promise<AuditLogRow[]>,
        (row) => [
          row.occurredAt.toISOString(),
          `${row.actorName} <${row.actorEmail}>`,
          row.actorRole,
          row.action,
          row.outcome,
          row.httpStatus,
          row.entityType ?? '',
          row.entityId ?? '',
          row.method,
          row.path,
        ],
      )
      return
    }

    const { page, pageSize } = query
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({ where, select: LIST_SELECT, orderBy: { occurredAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.auditLog.count({ where }),
    ])

    res.json({ items: (items as unknown as AuditLogRow[]).map(toListItem), meta: paginationMeta(page, pageSize, total) })
  }),
)

router.get(
  '/actors',
  validateQuery(auditLogActorsQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as AuditLogActorsQuery
    const tz = query.tz ?? env.REPORTING_TIMEZONE
    const period = resolveEffectivePeriod(query.period, query.from, query.to)
    const window = resolvePeriodWindow({ period, from: query.from, to: query.to, tz })

    const grouped = await prisma.auditLog.groupBy({
      by: ['actorUserId', 'actorRole', 'actorEmail', 'actorName', 'actorOperatorId'],
      where: { occurredAt: { gte: window.from, lt: window.to } },
      _count: { _all: true },
    })

    const items = grouped
      .map((g) => ({ userId: g.actorUserId, name: g.actorName, email: g.actorEmail, role: g.actorRole, operatorId: g.actorOperatorId, eventCount: g._count._all }))
      .sort((a, b) => b.eventCount - a.eventCount)

    res.json({ items })
  }),
)

// `:id` DEPOIS de `/actors` — senão o Express casaria "actors" como valor de
// `:id` (rota mais específica primeiro).
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.auditLog.findUnique({ where: { id: req.params.id } })
    if (!row) throw new AppError('Linha de auditoria não encontrada.', 404, 'NOT_FOUND')

    const base = toListItem(row as unknown as AuditLogRow)
    res.json({ ...base, userAgent: row.userAgent, requestId: row.requestId, correlationId: row.correlationId, changes: row.changes })
  }),
)

export default router
