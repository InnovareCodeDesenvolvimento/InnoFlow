import Redis, { type RedisOptions } from 'ioredis'
import { env } from './env'
import { logger } from './logger'
import { createLogGate } from './rateLimitedLog'

const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null, // exigido pelo BullMQ (ver docs/BullMQ)
}

/** Intervalo mínimo entre logs de erro de conexão de UMA conexão (o ioredis emite `error` a cada tentativa de reconexão). */
const CONNECTION_ERROR_LOG_INTERVAL_MS = 10_000

/**
 * O ioredis emite `error` a cada falha de conexão/reconexão; SEM ouvinte o Node imprime "Unhandled
 * error event" em cada uma (e um `error` sem ouvinte é exceção em qualquer EventEmitter). Não muda o
 * comportamento — o cliente reconecta sozinho —, só registra, no máximo 1x por intervalo por conexão,
 * e sem nunca despejar a URL (pode ter senha): só código e mensagem do erro.
 */
function attachErrorLogger(connection: Redis): void {
  const gate = createLogGate(CONNECTION_ERROR_LOG_INTERVAL_MS)
  connection.on('error', (err: Error & { code?: string; errors?: Error[] }) => {
    gate((suppressed) =>
      logger.warn(
        { code: err.code ?? err.errors?.[0]?.name, reason: err.message || err.errors?.[0]?.message, status: connection.status, suppressed },
        '[redis] erro de conexão (o cliente reconecta sozinho)',
      ),
    )
  })
}

/**
 * Fábrica de conexões, não um singleton único: Redis em modo pub/sub
 * (comandos API -> carregador) e conexões do BullMQ não podem compartilhar a
 * mesma instância de cliente que também faz get/set comum — é a própria
 * biblioteca `ioredis`/`bullmq` que exige conexões dedicadas por papel.
 * Cada entrypoint chama isto para abrir a conexão que precisa.
 */
export function createRedisConnection(): Redis {
  const connection = new Redis(env.REDIS_URL, baseOptions)
  attachErrorLogger(connection)
  return connection
}

/** Conexão padrão para uso geral (ex.: health check). */
export const redis = createRedisConnection()
