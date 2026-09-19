import type Redis from 'ioredis'
import { createRedisConnection } from '../lib/redis'
import { releaseReservations, reserveAttempt, settleAttemptFailure } from '../lib/redisCounter'
import { env } from '../lib/env'
import { createOcppAuthRateLimiter, type AuthCounterStore } from '../core/ocpp/authRateLimiter'

/**
 * Binding do limite de tentativas de autenticação do gateway OCPP ao Redis. A regra (três contadores —
 * par identidade+IP, falhas do IP e tentativas em andamento do IP —, reserva ANTES de avaliar, zerar o par
 * no sucesso) está em `core/ocpp/authRateLimiter.ts`; aqui só o armazenamento.
 *
 * Contadores em REDIS (não em memória do processo) pelo mesmo motivo do lock de `registry.ts`:
 * sobrevivem a restart do gateway (reiniciar não zera um ataque em andamento) e valem com mais
 * de uma réplica. Reserva/falha/devolução são scripts Lua atômicos: ver `lib/redisCounter.ts`.
 */

function redisCounterStore(redis: Redis): AuthCounterStore {
  return {
    reserve: (keys, limits, ttls) => reserveAttempt(redis, keys, limits, ttls),
    settleFailure: (keys, windowSeconds) => settleAttemptFailure(redis, keys, windowSeconds),
    release: (keys) => releaseReservations(redis, keys),
    async del(keys) {
      if (keys.length > 0) await redis.del(...keys)
    },
  }
}

export const ocppAuthRateLimiter = createOcppAuthRateLimiter(redisCounterStore(createRedisConnection()), {
  maxAttemptsPerIdentityIp: env.OCPP_AUTH_RATE_LIMIT_MAX_ATTEMPTS,
  maxFailuresPerIp: env.OCPP_AUTH_IP_MAX_FAILURES,
  maxConcurrentPerIp: env.OCPP_AUTH_IP_MAX_CONCURRENT,
  windowSeconds: env.OCPP_AUTH_RATE_LIMIT_WINDOW_SECONDS,
})
