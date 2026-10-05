import type { Request } from 'express'

/** Metadados da requisição para a auditoria (mesma forma das demais rotas /api/me: ip, user-agent, id da requisição como string — o `req.id` do pino-http é número). */
export function metaDaRequisicao(req: Request) {
  const rawId = (req as { id?: string | number }).id
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    requestId: rawId != null ? String(rawId) : null,
  }
}
