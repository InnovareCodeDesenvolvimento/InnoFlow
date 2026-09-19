import { redis } from '../../lib/redis'
import { incrWithTtl, releaseReservations, reserveLoginAttempt } from '../../lib/redisCounter'
import { createLoginThrottle, type ThrottleStore } from '../../core/auth/loginThrottle'

/**
 * Falha RÁPIDA quando a conexão não está pronta. Com `maxRetriesPerRequest: null` (exigência do
 * BullMQ) o ioredis não rejeita comando com o Redis fora do ar: ENFILEIRA e espera reconectar —
 * numa queda longa, cada login empilharia comandos sem teto, e ao voltar o Redis executaria uma
 * enxurrada de reservas de logins que já terminaram (vagas fantasma que trancariam contas). Aqui o
 * comando nem entra na fila: o `throttleSafely` da rota trata a exceção como fail-open.
 * (Um Redis "travado" — conexão aberta e muda — continua coberto só pelo timeout da rota.)
 */
function assertRedisReady(): void {
  if (redis.status !== 'ready') throw new Error(`Redis indisponível (status=${redis.status})`)
}

/** Binding do throttle de login por conta ao Redis compartilhado da API (regra em `core/auth/loginThrottle.ts`). */
const store: ThrottleStore = {
  async reserve(keys, maxFailures, windowSeconds) {
    assertRedisReady()
    return reserveLoginAttempt(redis, keys, maxFailures, windowSeconds)
  },
  async release(key) {
    assertRedisReady()
    await releaseReservations(redis, [key])
  },
  async incrWithTtl(key, ttlSeconds) {
    assertRedisReady()
    return incrWithTtl(redis, key, ttlSeconds)
  },
  async setWithTtl(key, value, ttlSeconds) {
    assertRedisReady()
    await redis.set(key, String(value), 'EX', ttlSeconds)
  },
  async del(keys) {
    assertRedisReady()
    if (keys.length > 0) await redis.del(...keys)
  },
}

export const loginThrottle = createLoginThrottle(store)
