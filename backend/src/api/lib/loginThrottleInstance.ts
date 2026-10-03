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

/**
 * Step-up de senha da config do gateway de pagamento (`PUT /api/admin/payment-gateway`): MESMO mecanismo do login
 * (reserva atômica antes do bcrypt, trancamento com backoff, fail-open se o Redis cair), mas o balde é por USUÁRIO
 * logado e só conta senha ERRADA. 5 erradas em 15 min trancam o step-up (60 s, dobrando a cada reincidência até 15 min):
 * quem tem só um token roubado não ganha tentativas ilimitadas de adivinhar a senha do ADMIN. A chave é `stepup:<userId>`
 * (hasheada pelo throttle) — não colide com a de login, que é um e-mail.
 */
export const stepUpThrottle = createLoginThrottle(store, {
  maxFailures: 5,
  windowSeconds: 15 * 60,
  baseLockSeconds: 60,
  maxLockSeconds: 15 * 60,
  strikesTtlSeconds: 24 * 60 * 60,
})
