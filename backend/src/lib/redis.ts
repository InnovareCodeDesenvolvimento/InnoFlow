import Redis, { type RedisOptions } from 'ioredis'
import { env } from './env'

const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null, // exigido pelo BullMQ (ver docs/BullMQ)
}

/**
 * Fábrica de conexões, não um singleton único: Redis em modo pub/sub
 * (comandos API -> carregador) e conexões do BullMQ não podem compartilhar a
 * mesma instância de cliente que também faz get/set comum — é a própria
 * biblioteca `ioredis`/`bullmq` que exige conexões dedicadas por papel.
 * Cada entrypoint chama isto para abrir a conexão que precisa.
 */
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, baseOptions)
}

/** Conexão padrão para uso geral (ex.: health check). */
export const redis = createRedisConnection()
