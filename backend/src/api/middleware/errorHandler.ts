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
    // Array (lista de pendências/itens) OU objeto (`GATEWAY_HAS_INFLIGHT_PAYMENTS`: `{ count }`, contrato literal de `PaymentGatewayConfigErrorCode`).
    public details?: Array<Record<string, unknown> | string> | Record<string, unknown>,
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

  // Erros do body-parser (`type` string, `statusCode` 4xx): corpo malformado/grande/codificação — erro do CLIENTE, não nosso. Sem log de erro e sem `err` (o corpo pode ter segredo), só um aviso curto.
  const tipoBodyParser = typeof err === 'object' && err !== null ? (err as { type?: unknown }).type : undefined
  if (typeof tipoBodyParser === 'string' && /^(entity|encoding|charset|request|stream)[.]/.test(tipoBodyParser)) {
    const status = tipoBodyParser === 'entity.too.large' ? 413 : tipoBodyParser === 'entity.parse.failed' ? 400 : tipoBodyParser.startsWith('encoding') || tipoBodyParser.startsWith('charset') ? 415 : 400
    logger.debug({ tipo: tipoBodyParser, method: req.method, path: req.originalUrl.split('?')[0] }, '[api] corpo da requisição recusado pelo parser')
    res.status(status).json({
      error: status === 413 ? 'Corpo da requisição grande demais.' : status === 415 ? 'Codificação do corpo não suportada.' : 'Corpo da requisição inválido (JSON malformado).',
      code: status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_BODY' : 'INVALID_JSON',
    })
    return
  }

  // Erros conhecidos do Prisma. `err?.constructor?.name` (não
  // `err.constructor.name`) porque um throwable sem protótipo explodiria
  // dentro do próprio error handler — a request morreria sem resposta.
  if (typeof err === 'object' && err !== null && (err as { constructor?: { name?: string } }).constructor?.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as { code?: string; meta?: Record<string, unknown> }
    if (prismaErr.code === 'P2002') {
      // Sem `meta` do Prisma na resposta (Órion): ele traz o NOME da constraint/colunas (`target`) —
      // estrutura interna do banco que o cliente não precisa (e ajuda a enumerar o schema).
      res.status(409).json({ error: 'Registro duplicado. Verifique os dados informados.', code: 'DUPLICATE' })
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
