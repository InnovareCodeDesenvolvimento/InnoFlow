import pino from 'pino'
import { env } from './env'

/**
 * Logger compartilhado pelos 3 entrypoints. `pino-pretty` só em
 * desenvolvimento (dependência de dev) — em produção sai JSON puro, mais
 * barato e pronto para qualquer coletor de logs.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  // `pino-http` (app.ts) usa esta MESMA instância como logger base — o
  // `redact` daqui vale para os objetos req/res que ele serializa
  // automaticamente em toda requisição, não só para chamadas manuais de
  // `logger.info(...)`. Sem isto, o header `Authorization: Bearer <jwt>`
  // (e qualquer cookie) ia parar em texto puro nos logs de produção em
  // TODA rota autenticada — achado real do Órion, 17/09/2026: combinado
  // com token de 12h sem revogação, isso equivale a sequestro de sessão
  // pra quem tiver acesso aos logs do EasyPanel. Bloqueante antes da F5
  // (pagamento real), corrigido antes de prosseguir.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
})
