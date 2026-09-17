import type { NextFunction, Request, Response } from 'express'
import type { AuditAction, AuditOutcome } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { writeAuditLog } from '../../services/auditoria/writeAuditLog'
import { emitAdminEntityChanged, emitDashboardDirty } from '../../realtime/emit'
import type { EntityDiff } from '../../core/auditoria/diffEntity'

/**
 * Middleware de auditoria — montado UMA vez em `app.use('/api/admin',
 * auditTrail())`, ANTES de todos os routers admin (`app.ts`). Mecânica
 * (Nova, §2.1): registra um listener em `res.on('finish')`, que roda DEPOIS
 * de tudo — `req.user`/`res.statusCode`/`res.locals` já estão preenchidos
 * nesse ponto, então qualquer router admin FUTURO nasce auditado sem
 * ninguém lembrar de instrumentar nada (ver `inferEntityType`/
 * `defaultActionForMethod` abaixo, o fallback que garante isso).
 *
 * Fire-and-forget: falha ao gravar audita NUNCA derruba a resposta ao
 * cliente (só o ajuste manual de saldo é diferente — fail-closed, gravado
 * dentro da própria transação do `WalletEntry`, ver `drivers.routes.ts`).
 */

export interface AuditDescribeInput {
  entityType?: string
  entityId?: string | null
  targetOperatorId?: string | null
  action?: AuditAction
  actionDetail?: string | null
  changes?: EntityDiff | null
  correlationId?: string | null
  /** Grava mesmo sendo GET sem `?format=csv` — hoje só usado por `GET /api/admin/drivers/:id/wallet` (decisão do dono: ver extrato de UM motorista é auditável). */
  forceAudit?: boolean
  /** A rota já gravou a própria linha de auditoria (ex.: ajuste de saldo — fail-closed, dentro da MESMA transação do `WalletEntry`, ver `walletLedger.ts`). Sem isto, o middleware genérico duplicaria a linha. */
  skip?: boolean
}

const LOCALS_KEY = '__auditDescribe'

/** API que cada rota mutante chama, DEPOIS da operação, para descrever o que mudou. Uma chamada por rota — pode chamar de novo para completar campos (merge raso). */
export function auditCtx(res: Response): { describe(input: AuditDescribeInput): void } {
  return {
    describe(input: AuditDescribeInput): void {
      const prev = res.locals[LOCALS_KEY] as AuditDescribeInput | undefined
      res.locals[LOCALS_KEY] = { ...prev, ...input }
    },
  }
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Prefixo mais específico primeiro (`tariff-assignments` antes de `tariffs`,
// senão o `startsWith` genérico casaria errado).
const PATH_ENTITY_MAP: ReadonlyArray<{ prefix: string; entityType: string }> = [
  { prefix: '/api/admin/tariff-assignments', entityType: 'TariffAssignment' },
  { prefix: '/api/admin/sites', entityType: 'Site' },
  { prefix: '/api/admin/charge-points', entityType: 'ChargePoint' },
  { prefix: '/api/admin/connectors', entityType: 'Connector' },
  { prefix: '/api/admin/tariffs', entityType: 'Tariff' },
  { prefix: '/api/admin/auth-tokens', entityType: 'AuthToken' },
  { prefix: '/api/admin/drivers', entityType: 'User' },
  { prefix: '/api/admin/sessions', entityType: 'ChargingSession' },
  { prefix: '/api/admin/reports', entityType: 'Report' },
  { prefix: '/api/admin/audit-logs', entityType: 'AuditLog' },
]

function inferEntityType(pathname: string): string | null {
  return PATH_ENTITY_MAP.find((m) => pathname.startsWith(m.prefix))?.entityType ?? null
}

function defaultActionForMethod(method: string, pathname: string): AuditAction {
  if (pathname.includes('/commands/')) return 'REMOTE_COMMAND'
  if (pathname.endsWith('/wallet/entries')) return 'WALLET_ADJUSTMENT'
  switch (method) {
    case 'POST':
      return 'CREATE'
    case 'PATCH':
    case 'PUT':
      return 'UPDATE'
    case 'DELETE':
      return 'DELETE'
    default:
      return 'OTHER'
  }
}

/**
 * Mapeia status HTTP -> outcome. `null` = NUNCA grava (400 validação Zod, 401
 * sem ator confiável). Regra literal da Nova (§2.4): 2xx/202 -> SUCCESS;
 * 403/404 -> DENIED (sinal de segurança real — OPERATOR tentando acessar
 * recurso de outro tenant); 5xx -> FAILED. Demais códigos (409 conflito de
 * negócio, 429 rate limit, etc.) não foram enumerados explicitamente —
 * tratados como FAILED aqui (não é sucesso, não é DENIED de tenant/auth,
 * ainda vale registrar que a operação não completou).
 */
function resolveOutcome(statusCode: number): AuditOutcome | null {
  if (statusCode === 400 || statusCode === 401) return null
  if (statusCode >= 200 && statusCode < 300) return 'SUCCESS'
  if (statusCode === 403 || statusCode === 404) return 'DENIED'
  if (statusCode >= 500) return 'FAILED'
  return 'FAILED'
}

function fieldNamesOnly(body: unknown): EntityDiff | null {
  if (!body || typeof body !== 'object') return null
  const fieldNames = Object.keys(body as Record<string, unknown>)
  if (fieldNames.length === 0) return null
  return { fieldNamesOnly: fieldNames }
}

export function auditTrail() {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      void recordAuditEntry(req, res).catch((err) => {
        logger.error({ err, path: req.originalUrl }, '[audit] falha ao gravar linha de auditoria (fire-and-forget, não afeta a resposta já enviada)')
      })
    })
    next()
  }
}

async function recordAuditEntry(req: Request, res: Response): Promise<void> {
  const user = req.user
  if (!user) return // sem ator autenticado — nunca grava (401 cai aqui trivialmente, e também evita vetor de inundação)

  const described = res.locals[LOCALS_KEY] as AuditDescribeInput | undefined
  if (described?.skip) return

  const method = req.method
  const pathname = req.originalUrl.split('?')[0]
  const isMutation = MUTATION_METHODS.has(method)
  const isCsvExport = (req.query as Record<string, unknown> | undefined)?.format === 'csv'
  const forceAudit = described?.forceAudit === true

  if (!isMutation && !isCsvExport && !forceAudit) return // GET comum — não audita (regra padrão)

  const outcome = resolveOutcome(res.statusCode)
  if (outcome === null) return

  const entityType = described?.entityType ?? inferEntityType(pathname)
  const entityId = described?.entityId ?? (typeof req.params?.id === 'string' ? req.params.id : null)
  const action: AuditAction = described?.action ?? (isCsvExport ? 'EXPORT' : defaultActionForMethod(method, pathname))
  const changes = described ? (described.changes ?? null) : fieldNamesOnly(req.body)

  // `req.user` (JWT) só carrega userId/role/operatorId — email/name (NOT
  // NULL no model) vêm de uma consulta extra, só quando a linha VAI ser
  // gravada (mutação/export, não em toda requisição).
  const actor = await prisma.user.findUnique({ where: { id: user.userId }, select: { email: true, name: true } })
  if (!actor) {
    logger.error({ userId: user.userId }, '[audit] ator do token não encontrado no banco — linha de auditoria descartada')
    return
  }

  await writeAuditLog({
    actorUserId: user.userId,
    actorRole: user.role,
    actorEmail: actor.email,
    actorName: actor.name,
    actorOperatorId: user.operatorId ?? null,
    action,
    actionDetail: described?.actionDetail ?? null,
    outcome,
    httpStatus: res.statusCode,
    entityType,
    entityId,
    targetOperatorId: described?.targetOperatorId ?? (user.role === 'OPERATOR' ? (user.operatorId ?? null) : null),
    method,
    path: pathname,
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    requestId: (req as { id?: string }).id ?? null,
    correlationId: described?.correlationId ?? null,
    changes,
  })

  // Tempo real: reaproveita o MESMO cálculo acima (entityType/entityId/
  // action/targetOperatorId) para os dois eventos de UI — nenhuma
  // instrumentação nova (decisão da Nova, decisoes-tempo-real-sse.md).
  if (outcome === 'SUCCESS' && entityType && entityId && (action === 'CREATE' || action === 'UPDATE' || action === 'DELETE')) {
    const targetOperatorId = described?.targetOperatorId ?? (user.role === 'OPERATOR' ? (user.operatorId ?? null) : null)
    await emitAdminEntityChanged(targetOperatorId, entityType, entityId, action).catch((err) =>
      logger.error({ err }, '[audit] falha ao publicar admin.entity.changed (best-effort)'),
    )
    await emitDashboardDirty(targetOperatorId).catch((err) => logger.error({ err }, '[audit] falha ao publicar dashboard.dirty (best-effort)'))
  }
}
