import type { NextFunction, Request, Response } from 'express'

/**
 * Express 4 não captura rejeições de Promise automaticamente — sem isto,
 * um `await prisma...` que falhar dentro de uma rota derruba a request sem
 * chamar `errorHandler` (fica pendurada, sem resposta e sem log). Todo
 * handler de rota assíncrono da API passa por aqui.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
