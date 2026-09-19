import { afterAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomInt } from 'node:crypto'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import Redis from 'ioredis'

// A API fala com o Redis pelo proxy desta suíte; o Redis REAL é inspecionado direto, fora do proxy.
const { proxy, realRedisUrl } = await vi.hoisted(async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy, realRedisUrl }
})

import { createApp } from '../../src/api/app'
import { redis } from '../../src/lib/redis'
import { createUser, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * `loginThrottleInstance.ts` recusa comando com o Redis fora (`assertRedisReady`) para NÃO enfileirar no ioredis:
 * "ao voltar, o Redis executaria uma enxurrada de reservas de logins que já terminaram (vagas fantasma que
 * trancariam contas)". Nenhum teste provava isso (mutação L12, Íris 2026-09-19: remover o `assertRedisReady`
 * deixava a suíte inteira verde). Este prova: logins feitos com o Redis CAÍDO não deixam vaga nenhuma no Redis
 * quando ele volta — a conta de quem só errou a senha durante a queda não sai trancada dela.
 */

const SENHA = 'SenhaCerta#123'
const suffix = uniqueSuffix()
const app = createApp()
const direct = new Redis(realRedisUrl)
const accountId = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)
const failKey = (email: string) => `login:fail:${accountId(email)}`
const lockKey = (email: string) => `login:lock:${accountId(email)}`
const strikesKey = (email: string) => `login:strikes:${accountId(email)}`
const touched = new Set<string>()

const ip = `198.${18 + randomInt(0, 2)}.${randomInt(0, 256)}.${randomInt(1, 255)}`
const login = (email: string, password: string) => request(app).post('/api/auth/login').set('X-Forwarded-For', `${ip}, 10.0.0.1`).send({ email, password })

afterAll(async () => {
  const keys = [...touched].flatMap((e) => [failKey(e), lockKey(e), strikesKey(e)])
  if (keys.length > 0) await direct.del(...keys)
  await direct.quit().catch(() => {})
  redis.disconnect()
  await proxy.stop()
})

describe('login com o Redis CAÍDO não deixa vaga fantasma quando ele volta', () => {
  it('5 senhas erradas durante a queda (fail-open: 401, sem 429) e, depois da volta, nenhuma vaga/falha/trancamento ficou no Redis — e a senha certa entra', async () => {
    const passwordHash = await bcrypt.hash(SENHA, 4)
    const u = await createUser({ role: 'DRIVER', label: 'fantasma', suffix, passwordHash })
    touched.add(u.email)
    await waitFor(async () => redis.status === 'ready', { timeoutMs: 15_000, what: 'conexão do throttle pronta' })

    await proxy.down()
    try {
      await waitFor(async () => redis.status !== 'ready', { timeoutMs: 5_000, what: 'cliente perceber a queda' })
      const status: number[] = []
      for (let i = 0; i < 6; i++) status.push((await login(u.email, `errada-${i}`)).status)
      expect(status).toEqual([401, 401, 401, 401, 401, 401]) // fail-open: avaliadas todas, nenhuma barrada (não há contador para barrar)
    } finally {
      await proxy.up()
    }
    await waitFor(async () => redis.status === 'ready', { timeoutMs: 15_000, what: 'reconexão do throttle' })
    await new Promise((r) => setTimeout(r, 1_500)) // tempo de sobra para uma fila offline (se existisse) ser despejada no Redis

    expect(await direct.get(failKey(u.email))).toBeNull() // nenhuma reserva/falha fantasma
    expect(await direct.ttl(lockKey(u.email))).toBe(-2) // conta NÃO trancada
    expect(await direct.get(strikesKey(u.email))).toBeNull()
    expect((await login(u.email, SENHA)).status).toBe(200)
  }, 60_000)
})
