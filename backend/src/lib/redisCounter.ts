import type Redis from 'ioredis'

/**
 * `INCR` + `EXPIRE` na criação, ATÔMICOS (script Lua). Feitos como dois comandos separados, uma
 * queda entre eles deixa a chave SEM TTL para sempre = bloqueio/contador permanente. Compartilhado
 * pelos contadores de tentativas (gateway OCPP e throttle de login).
 */
const INCR_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`

export async function incrWithTtl(redis: Redis, key: string, ttlSeconds: number): Promise<number> {
  return Number(await redis.eval(INCR_WITH_TTL_SCRIPT, 1, key, String(ttlSeconds)))
}
