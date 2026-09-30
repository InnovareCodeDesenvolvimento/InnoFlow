import type { AuditAction, AuditActorRole, AuditOutcome, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { clampDiffSize, type EntityDiff } from '../../core/auditoria/diffEntity'
import { limitarCamposDeAuditoria } from '../../core/auditoria/limitesDeCampos'

/**
 * Escritor único do `AuditLog` — usado pelo middleware genérico
 * (`api/middleware/auditTrail.ts`, fire-and-forget), pelo ajuste manual de
 * saldo (`api/routes/drivers.routes.ts`, FAIL-CLOSED, dentro da mesma
 * transação do `WalletEntry` — por isso aceita um `tx` opcional) E pelo
 * crédito de Pix (`services/pagamentos/creditarTopupPix.ts`, F5.2,
 * `actorRole='SYSTEM'`, também fail-closed na mesma transação). Centraliza
 * o clamp de tamanho do diff (`AUDIT_LOG_CHANGES_MAX_BYTES`) para as três
 * chamadas nunca divergirem nessa regra.
 */

export interface WriteAuditLogInput {
  actorUserId: string
  actorRole: AuditActorRole
  actorEmail: string
  actorName: string
  actorOperatorId?: string | null
  action: AuditAction
  actionDetail?: string | null
  outcome: AuditOutcome
  entityType?: string | null
  entityId?: string | null
  targetOperatorId?: string | null
  requestId?: string | null
  correlationId?: string | null
  changes?: EntityDiff | null
  // Opcionais desde a F5 (2026-09-30) — SÓ podem faltar quando
  // `actorRole === 'SYSTEM'` (evento automático, sem requisição HTTP por
  // trás). Reforçado por CHECK no banco
  // (`audit_log_http_fields_required_unless_system`); o `if` abaixo replica
  // a MESMA regra em código para falhar cedo com uma mensagem clara de bug
  // de programação, em vez de deixar o INSERT quebrar com um erro genérico
  // de constraint violada.
  httpStatus?: number | null
  method?: string | null
  path?: string | null
  ipAddress?: string | null
  userAgent?: string | null
}

type Tx = Prisma.TransactionClient | typeof prisma

export async function writeAuditLog(rawInput: WriteAuditLogInput, tx: Tx = prisma): Promise<void> {
  if (rawInput.actorRole !== 'SYSTEM' && (rawInput.httpStatus == null || rawInput.method == null || rawInput.path == null)) {
    throw new Error(
      `writeAuditLog: httpStatus/method/path são obrigatórios quando actorRole !== 'SYSTEM' (recebido actorRole=${rawInput.actorRole}, action=${rawInput.action}) — bug de programação no chamador, não confiar no CHECK do banco para pegar isto.`,
    )
  }

  // Teto de `path`/`userAgent`/`entityId` (Órion A4): a tabela é imutável por 24 meses — campo sem
  // teto deixa um atacante encher o disco para sempre. Mesmos limites como CHECK no banco.
  const input = limitarCamposDeAuditoria(rawInput)
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
      httpStatus: input.httpStatus ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      targetOperatorId: input.targetOperatorId ?? null,
      method: input.method ?? null,
      path: input.path ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      correlationId: input.correlationId ?? null,
      ...(changes !== null ? { changes: changes as Prisma.InputJsonValue } : {}),
    },
  })
}
