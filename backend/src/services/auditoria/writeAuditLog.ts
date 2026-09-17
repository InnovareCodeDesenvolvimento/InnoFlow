import type { AuditAction, AuditOutcome, Prisma, Role } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { clampDiffSize, type EntityDiff } from '../../core/auditoria/diffEntity'

/**
 * Escritor único do `AuditLog` — usado pelo middleware genérico
 * (`api/middleware/auditTrail.ts`, fire-and-forget) E pelo ajuste manual de
 * saldo (`api/routes/drivers.routes.ts`, FAIL-CLOSED, dentro da mesma
 * transação do `WalletEntry` — por isso aceita um `tx` opcional). Centraliza
 * o clamp de tamanho do diff (`AUDIT_LOG_CHANGES_MAX_BYTES`) para as duas
 * chamadas nunca divergirem nessa regra.
 */

export interface WriteAuditLogInput {
  actorUserId: string
  actorRole: Role
  actorEmail: string
  actorName: string
  actorOperatorId?: string | null
  action: AuditAction
  actionDetail?: string | null
  outcome: AuditOutcome
  httpStatus: number
  entityType?: string | null
  entityId?: string | null
  targetOperatorId?: string | null
  method: string
  path: string
  ipAddress?: string | null
  userAgent?: string | null
  requestId?: string | null
  correlationId?: string | null
  changes?: EntityDiff | null
}

type Tx = Prisma.TransactionClient | typeof prisma

export async function writeAuditLog(input: WriteAuditLogInput, tx: Tx = prisma): Promise<void> {
  const changes = clampDiffSize(input.changes ?? null, env.AUDIT_LOG_CHANGES_MAX_BYTES)

  await tx.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      actorEmail: input.actorEmail,
      actorName: input.actorName,
      actorOperatorId: input.actorOperatorId ?? null,
      action: input.action,
      actionDetail: input.actionDetail ?? null,
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      targetOperatorId: input.targetOperatorId ?? null,
      method: input.method,
      path: input.path,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      correlationId: input.correlationId ?? null,
      ...(changes !== null ? { changes: changes as Prisma.InputJsonValue } : {}),
    },
  })
}
