import pino from 'pino'
import { env } from './env'

/**
 * Logger compartilhado pelos 3 entrypoints. `pino-pretty` só em
 * desenvolvimento (dependência de dev) — em produção sai JSON puro, mais
 * barato e pronto para qualquer coletor de logs.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
})
