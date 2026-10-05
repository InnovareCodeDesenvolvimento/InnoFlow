import type { NextFunction, Request, Response } from 'express'
import { AppError } from './errorHandler'
import { podeIniciarRecargaRemota } from '../../core/sessao/politicaRecargaRemota'

/**
 * Guarda de papel da recarga remota pela administração (L1.5, DL4). A regra mora em `core/sessao/politicaRecargaRemota.ts` — este middleware só a aplica (lida a CADA
 * requisição, para a política poder ser trocada sem reiniciar teste/processo). Roda DEPOIS de `authenticate`. 403 `FORBIDDEN`, mesmo envelope do resto da API.
 */
export function requireRecargaRemotaPolicy(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new AppError('Não autenticado.', 401, 'UNAUTHORIZED')
  if (!podeIniciarRecargaRemota(req.user.role)) {
    throw new AppError('Apenas administradores da plataforma podem iniciar recarga remota.', 403, 'FORBIDDEN')
  }
  next()
}
