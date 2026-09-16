import type { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { logger } from '../../lib/logger'

/**
 * Envelope de erro da casa (convenção herdada do ParquedasFeiras, ver
 * .claude/agent-memory/nova/referencia-parquedasfeiras.md):
 * `{ error, code, details? }` — sempre com o mesmo formato, para o
 * frontend tratar programaticamente por `code`, não por `error` (texto
 * solto pode mudar; `code` é o contrato).
 */
export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 400,
    public code: string = 'ERROR',
    public details?: Array<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Resposta já começou (rotas de exportação CSV fazem streaming — ver
  // csvExport.ts) — não dá para reescrever status/corpo a esta altura.
  // Tentar `res.status().json()` de novo lançaria "Cannot set headers after
  // they are sent". Só loga (estruturado, sem corpo de request) e encerra a
  // conexão; o cliente recebe um CSV truncado, não um JSON de erro solto no
  // meio do arquivo.
  if (res.headersSent) {
    logger.error({ err, method: req.method, path: req.originalUrl, requestId: (req as { id?: string }).id }, '[api] erro após resposta iniciada (stream) — conexão encerrada sem corpo de erro')
    res.end()
    return
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.details ? { details: err.details } : {}),
    })
    return
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Dados inválidos.',
      code: 'VALIDATION_ERROR',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    })
    return
  }

  // Erros conhecidos do Prisma. `err?.constructor?.name` (não
  // `err.constructor.name`) porque um throwable sem protótipo explodiria
  // dentro do próprio error handler — a request morreria sem resposta.
  if (typeof err === 'object' && err !== null && (err as { constructor?: { name?: string } }).constructor?.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as { code?: string; meta?: Record<string, unknown> }
    if (prismaErr.code === 'P2002') {
      res.status(409).json({ error: 'Registro duplicado. Verifique os dados informados.', code: 'DUPLICATE', details: [{ meta: prismaErr.meta }] })
      return
    }
    if (prismaErr.code === 'P2025') {
      res.status(404).json({ error: 'Registro não encontrado.', code: 'NOT_FOUND' })
      return
    }
    if (prismaErr.code === 'P2003') {
      res.status(409).json({ error: 'Referência inválida — o registro relacionado não existe ou está em uso.', code: 'FOREIGN_KEY_VIOLATION' })
      return
    }
  }

  // 5xx não tratado: log estruturado com contexto de request, SEM corpo da
  // requisição (pode conter senha/token) e sem stack no corpo da resposta.
  logger.error({ err, method: req.method, path: req.originalUrl, requestId: (req as { id?: string }).id }, '[api] erro não tratado')

  res.status(500).json({ error: 'Erro interno do servidor. Tente novamente mais tarde.', code: 'INTERNAL_ERROR' })
}
