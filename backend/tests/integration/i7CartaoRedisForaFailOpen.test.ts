import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'

// A API fala com o Redis por um proxy TCP desta suíte (derrubar/travar sem tocar no Redis compartilhado); o Redis REAL é inspecionado direto.
const { proxy, realRedisUrl } = await vi.hoisted(async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy, realRedisUrl }
})

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { issueToken } from '../../src/lib/jwt'
import { registrarRecusaDeCartao } from '../../src/services/pagamentos/elegibilidadeCartao'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { BraspagFalsa, CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa } from './helpers/cenarioCartaoHttp'
import { uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * Íris (rodada 3) — I-7 com o REDIS DE VERDADE FORA: o bloqueio anti-carding é um freio de abuso e deve ser FAIL-OPEN (não derruba o cartão de todo mundo quando o Redis cai),
 * mas o portão de IDENTIDADE (Google) não depende de Redis e NÃO pode abrir junto. Também mede quanto o motorista espera quando o Redis fica TRAVADO (blackhole: aceita e não responde).
 */
describe('I-7 com o Redis fora/travado (proxy TCP)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const direct = new Redis(realRedisUrl)
  const braspag = new BraspagFalsa()
  const cielo = new CieloFalsaHttp()
  const baseline = { ...env } as Record<string, unknown>
  const e = env as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }
  let google: { id: string; token: string }
  let solo: { id: string; token: string }
  const ip = `198.19.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
  const h = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Forwarded-For': `${ip}, 10.0.0.9` })

  beforeAll(async () => {
    await cielo.iniciar()
    await braspag.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 600 })
    e.CIELO_SOP_CLIENT_ID = 'sop-client-r3'
    e.CIELO_SOP_CLIENT_SECRET = 'sop-secret-r3'
    e.CIELO_SOP_OAUTH_TOKEN_URL = `${braspag.url}/oauth2/token`
    e.CIELO_SOP_ACCESS_TOKEN_URL = `${braspag.url}/post/api/public/v2/accesstoken`
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    const g = await prisma.user.create({ data: { role: 'DRIVER', name: 'G', email: `g-${suffix}@example.com`, googleSub: `google-${randomUUID()}` } })
    const s = await prisma.user.create({ data: { role: 'DRIVER', name: 'S', email: `s-${suffix}@example.com` } })
    google = { id: g.id, token: issueToken({ id: g.id, role: 'DRIVER', operatorId: null }) }
    solo = { id: s.id, token: issueToken({ id: s.id, role: 'DRIVER', operatorId: null }) }
  }, 30_000)
  beforeEach(async () => {
    e.CARD_REQUIRE_VERIFIED_IDENTITY = true
    await proxy.up()
  })
  afterAll(async () => {
    Object.assign(env, baseline)
    process.env.CIELO_API_BASE_URL = processEnvBaseline.api
    process.env.CIELO_API_QUERY_BASE_URL = processEnvBaseline.query
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    await proxy.stop()
    await cielo.parar()
    await braspag.parar()
    direct.disconnect()
    await prisma.$disconnect()
    redis.disconnect()
  })

  const medir = async <T>(f: () => Promise<T>) => {
    const t0 = Date.now()
    const r = await f()
    return { r, ms: Date.now() - t0 }
  }

  it('Redis CAÍDO (ECONNREFUSED): motorista com Google segue (GET lista 200 eligible, tokenização 200) — fail-open com aviso no log; o SÓ-SENHA continua barrado (403): o portão de identidade não depende de Redis', async () => {
    await proxy.down()
    const aviso = vi.spyOn(logger, 'warn')
    const lista = await medir(() => request(app).get('/api/me/payment-methods').set(h(google.token)))
    expect(lista.r.status, JSON.stringify(lista.r.body)).toBe(200)
    expect(lista.r.body.cardEligibility).toEqual({ eligible: true, reason: null, blockedUntil: null })
    const tok = await medir(() => request(app).post('/api/me/payment-methods/tokenization-session').set(h(google.token)).send({}))
    expect(tok.r.status, JSON.stringify(tok.r.body)).toBe(200)
    const soloTok = await request(app).post('/api/me/payment-methods/tokenization-session').set(h(solo.token)).send({})
    expect(soloTok.status).toBe(403)
    expect(soloTok.body.code).toBe('CARD_REQUIRES_VERIFIED_IDENTITY')
    const falhasAvisadas = aviso.mock.calls.filter((c) => String(c[1] ?? '').includes('Redis indisponível'))
    aviso.mockRestore()
    expect(falhasAvisadas.length).toBeGreaterThan(0) // o fail-open é RUIDOSO, não silencioso
    process.stderr.write(`MEDICAO redis CAIDO: lista ${lista.ms} ms, tokenizacao ${tok.ms} ms\n`)
    expect(lista.ms).toBeLessThan(8_000)
  })

  it('Redis TRAVADO (blackhole): a lista de cartões e a tokenização continuam respondendo dentro de um prazo limitado (prazo de 2 s por operação, não infinito)', async () => {
    await proxy.blackhole()
    const lista = await medir(() => request(app).get('/api/me/payment-methods').set(h(google.token)))
    expect(lista.r.status, JSON.stringify(lista.r.body)).toBe(200)
    expect(lista.r.body.cardEligibility.eligible).toBe(true)
    const tok = await medir(() => request(app).post('/api/me/payment-methods/tokenization-session').set(h(google.token)).send({}))
    expect(tok.r.status, JSON.stringify(tok.r.body)).toBe(200)
    process.stderr.write(`MEDICAO redis TRAVADO: lista ${lista.ms} ms, tokenizacao ${tok.ms} ms\n`)
    expect(lista.ms).toBeLessThan(15_000)
    expect(tok.ms).toBeLessThan(15_000)
  }, 60_000)

  // ACHADO (rodada 3, severidade baixa-média): `bloqueadoAte` faz até 3 leituras SEQUENCIAIS (usuário, cadastros, IP), cada uma com prazo próprio de 2 s. Com o Redis fora ou travado cada
  // tela de cartão espera ~6 s (medido: 6.045–6.121 ms) antes do fail-open. Deveria ser UM prazo total (leituras em paralelo ou disjuntor). `it.fails`: ao corrigir, vira `it` com a asserção intacta.
  it.fails('ACHADO — com o Redis fora, a lista de cartões deveria responder em < 3 s (hoje ~6 s: 3 leituras sequenciais de 2 s cada)', async () => {
    await proxy.down()
    const lista = await medir(() => request(app).get('/api/me/payment-methods').set(h(google.token)))
    expect(lista.r.status).toBe(200)
    expect(lista.ms).toBeLessThan(3_000)
  }, 30_000)

  it('registrar uma recusa com o Redis fora NÃO lança (a resposta ao motorista não depende dele) e a recusa NÃO se perde: o comando fica na fila do ioredis e é gravado quando o Redis volta', async () => {
    const id = `fora-${randomUUID()}`
    await proxy.down()
    const t0 = Date.now()
    await expect(registrarRecusaDeCartao({ userId: id, ip })).resolves.toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(8_000)
    await proxy.up()
    await waitFor(async () => (await direct.get(`card-risk:refusals:user:${id}`)) === '1', { timeoutMs: 20_000, what: 'a recusa feita durante a queda ser gravada na volta' })
    await direct.del(`card-risk:refusals:user:${id}`)
  }, 40_000)

  it('o Redis VOLTA: o bloqueio volta a funcionar sozinho (sem reinício) — o contador volta a gravar', async () => {
    const id = `volta-${randomUUID()}`
    await proxy.down()
    await registrarRecusaDeCartao({ userId: id })
    await proxy.up()
    await waitFor(
      async () => {
        await registrarRecusaDeCartao({ userId: id })
        return (await direct.get(`card-risk:refusals:user:${id}`)) !== null
      },
      { timeoutMs: 20_000, what: 'o contador voltar a gravar depois da reconexão' },
    )
    await direct.del(`card-risk:refusals:user:${id}`)
  }, 40_000)
})
