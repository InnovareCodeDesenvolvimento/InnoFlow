import { redis } from '../../lib/redis'
import { incrWithTtl } from '../../lib/redisCounter'
import { createLoginThrottle, type ThrottleStore } from '../../core/auth/loginThrottle'

/** Binding do throttle de login por conta ao Redis compartilhado da API (regra em `core/auth/loginThrottle.ts`). */
const store: ThrottleStore = {
  async get(key) {
    const value = await redis.get(key)
    return value === null ? 0 : Number(value)
  },
  incrWithTtl: (key, ttlSeconds) => incrWithTtl(redis, key, ttlSeconds),
  async ttlSeconds(key) {
    return Math.max(0, await redis.ttl(key)) // -2 = não existe, -1 = sem TTL: ambos "sem trancamento"
  },
  async setWithTtl(key, value, ttlSeconds) {
    await redis.set(key, String(value), 'EX', ttlSeconds)
  },
  async del(keys) {
    if (keys.length > 0) await redis.del(...keys)
  },
}

export const loginThrottle = createLoginThrottle(store)
