import type { Request, Response, NextFunction } from 'express'
import type { ZodType } from 'zod'

/**
 * Validação de entrada com Zod. Lança `ZodError` de forma síncrona dentro do
 * próprio middleware — Express 4 captura throws síncronos automaticamente
 * (diferente de Promises rejeitadas, que precisam de `asyncHandler`), então
 * não precisamos de try/catch aqui: o `errorHandler` central já sabe
 * traduzir `ZodError` em 400 com `details` por campo.
 *
 * Reatribui `req.body`/`req.query`/`req.params` com o resultado PARSEADO
 * (não o bruto) — coerções do schema (`z.coerce.number()`, defaults) valem
 * para o resto da cadeia de handlers.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.body = schema.parse(req.body)
    next()
  }
}

export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.query = schema.parse(req.query) as typeof req.query
    next()
  }
}

export function validateParams<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.params = schema.parse(req.params) as typeof req.params
    next()
  }
}
