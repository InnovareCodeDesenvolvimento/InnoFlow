import type { NextFunction, Request, Response } from 'express'
import { redis } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { incrWithTtl } from '../../lib/redisCounter'
import { withDeadline } from '../../lib/withDeadline'
import { EXPORTACOES_POR_DIA, JANELA_EXPORTACAO_SEGUNDOS } from '../../core/lgpd/exportacao'
import { asyncHandler } from './asyncHandler'
import { AppError } from './errorHandler'

/**
 * Cota DIÁRIA da exportação de dados (L1.4): `EXPORTACOES_POR_DIA` (3) por USUÁRIO numa janela de 24 h, contada no REDIS — sobrevive a reinício do processo e vale entre réplicas
 * (o limitador em memória de `rateLimit.ts` roda junto como segunda camada, mas zera a cada deploy: sozinho deixaria um token roubado exportar de novo a cada reinício).
 * Janela FIXA a partir da 1ª exportação (INCR+EXPIRE atômico, `incrWithTtl`): simples e previsível; o `Retry-After` é o TTL que resta.
 *
 * Fail-open se o Redis não responde (500 ms): o limitador em memória continua valendo e a exportação é auditada — recusar o titular de acessar os PRÓPRIOS dados por um Redis fora do ar
 * seria pior do que o risco residual.
 */

const PRAZO_REDIS_MS = 500

export const chaveDaCotaDeExportacao = (userId: string): string => `lgpd:export:${userId}`

export const cotaDiariaDeExportacao = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user!.userId
  const chave = chaveDaCotaDeExportacao(userId)

  let usadas: number | null = null
  try {
    if (redis.status !== 'ready') throw new Error(`Redis indisponível (status=${redis.status})`)
    usadas = await withDeadline(incrWithTtl(redis, chave, JANELA_EXPORTACAO_SEGUNDOS), PRAZO_REDIS_MS, 'cota de exportação')
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[lgpd] cota diária de exportação indisponível (Redis) — seguindo só com o limitador em memória')
  }

  if (usadas !== null && usadas > EXPORTACOES_POR_DIA) {
    let restante = JANELA_EXPORTACAO_SEGUNDOS
    try {
      const ttl = await withDeadline(redis.ttl(chave), PRAZO_REDIS_MS, 'ttl da cota de exportação')
      if (ttl > 0) restante = ttl
    } catch {
      // mantém a janela cheia como teto do Retry-After
    }
    res.setHeader('Retry-After', String(restante))
    throw new AppError('Você já exportou seus dados 3 vezes hoje. Tente novamente amanhã.', 429, 'RATE_LIMITED_EXPORT')
  }
  next()
})
