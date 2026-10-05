import type { Request, Response } from 'express'
import { prisma } from '../../lib/prisma'
import { exigirSenhaAtual, StepUpRateLimitedError } from '../../services/auth/stepUpSenha'
import type { AtorEstorno, RequisicaoEstorno } from '../../services/estornos/tipos'
import { auditCtx } from '../middleware/auditTrail'
import { authenticate, requireRole } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

/** Peças comuns das rotas de estorno e de chargeback (L1.8) — ADMIN-only, step-up de senha, ator/requisição para a auditoria FAIL-CLOSED gravada junto com o dinheiro. */

/** `requireRole('ADMIN')` é POR ROTA (o router de `/api/admin/sessions` é compartilhado com o OPERATOR, que continua parando uma sessão como antes). */
export const apenasAdmin = [authenticate, requireRole('ADMIN')]

export function requisicaoDe(req: Request): RequisicaoEstorno {
  const id = (req as { id?: string | number }).id
  return {
    method: req.method,
    path: req.originalUrl.split('?')[0],
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    // `req.id` do pino-http é NÚMERO e `AuditLog.requestId` é `String?` (mesmo bug já corrigido em drivers/paymentGateway).
    requestId: id != null ? String(id) : null,
  }
}

export async function atorDe(req: Request): Promise<AtorEstorno> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.userId }, select: { email: true, name: true } })
  return { userId: req.user!.userId, role: req.user!.role, email: u.email, name: u.name, operatorId: req.user!.operatorId ?? null }
}

/** Step-up ANTES de qualquer regra de negócio. Senha errada é sinal de segurança: grava DENIED com `action` certa (sem corpo). A senha não sobrevive nem em `req.body`. */
export async function exigirStepUp(req: Request, res: Response, action: 'REFUND' | 'CHARGEBACK', entityId: string | null): Promise<void> {
  const body = req.body as { currentPassword?: string }
  const senha = body.currentPassword ?? ''
  delete body.currentPassword
  try {
    await exigirSenhaAtual({ userId: req.user!.userId, senhaInformada: senha })
  } catch (err) {
    if (err instanceof StepUpRateLimitedError) res.setHeader('Retry-After', String(err.retryAfterSeconds))
    if (err instanceof AppError && err.code === 'INVALID_CURRENT_PASSWORD') auditCtx(res).describe({ action, actionDetail: 'stepup_failed', entityType: 'PaymentReversal', entityId, changes: null })
    throw err
  }
}

/** Descrição padrão para recusas de regra (409/404): o middleware genérico grava FAILED/DENIED com a ação certa e sem o corpo (que traz texto livre). */
export function descreverTentativa(res: Response, action: 'REFUND' | 'CHARGEBACK', actionDetail: string, entityType: string, entityId: string | null): void {
  auditCtx(res).describe({ action, actionDetail, entityType, entityId, changes: null })
}
