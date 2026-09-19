import type Redis from 'ioredis'
import { createRedisConnection } from '../lib/redis'
import { env } from '../lib/env'
import { createOcppAuthRateLimiter, type AuthCounterStore } from '../core/ocpp/authRateLimiter'

/**
 * Binding do limite de tentativas de autenticação do gateway OCPP ao Redis. A regra (dois
 * contadores de FALHAS — identidade+IP e global por IP —, zerar o par no sucesso) está em
 * `core/ocpp/authRateLimiter.ts`; aqui só o armazenamento.
 *
 * Contadores em REDIS (não em memória do processo) pelo mesmo motivo do lock de `registry.ts`:
 * sobrevivem a restart do gateway (reiniciar não zera um ataque em andamento) e valem com mais
 * de uma réplica.
 */

/**
 * `INCR` + `EXPIRE` na criação, ATÔMICOS (script Lua). A versão antiga fazia os dois comandos
 * separados: uma queda entre eles deixava a chave SEM TTL para sempre = bloqueio permanente.
 */
const INCR_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`

function redisCounterStore(redis: Redis): AuthCounterStore {
  return {
    async getMany(keys) {
      const values = await redis.mget(...keys)
      return values.map((v) => (v === null ? 0 : Number(v)))
    },
    async incrWithTtl(key, ttlSeconds) {
      return Number(await redis.eval(INCR_WITH_TTL_SCRIPT, 1, key, String(ttlSeconds)))
    },
    async del(keys) {
      if (keys.length > 0) await redis.del(...keys)
    },
  }
}

export const ocppAuthRateLimiter = createOcppAuthRateLimiter(redisCounterStore(createRedisConnection()), {
  maxAttemptsPerIdentityIp: env.OCPP_AUTH_RATE_LIMIT_MAX_ATTEMPTS,
  maxFailuresPerIp: env.OCPP_AUTH_IP_MAX_FAILURES,
  windowSeconds: env.OCPP_AUTH_RATE_LIMIT_WINDOW_SECONDS,
})
