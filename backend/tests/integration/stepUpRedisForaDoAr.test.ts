import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import request from 'supertest'
import Redis from 'ioredis'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

// A API fala com o Redis por um proxy TCP desta suíte (ver helpers/redisProxy.ts): "derrubar o Redis" = derrubar o proxy, sem tocar no Redis
// compartilhado das outras suítes. Tem que valer ANTES de `lib/env` ser importado (por isso hoisted e async).
const { proxy, realRedisUrl } = await (async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy, realRedisUrl }
})()

/**
 * QA da Íris (F5.8, rodada Vega-2) — o step-up de senha do PUT do gateway com o Redis FORA DO AR (fail-open declarado no código: `comTimeout`
 * devolve `{ allowed: true }` e o registro da falha vira no-op). Pergunta: sem o limite por usuário do Redis, QUANTAS senhas erradas uma pessoa
 * com um token roubado consegue testar? O que sobra de proteção é o limite por minuto da própria rota (`paymentGatewayWriteRateLimit`, 10/min,
 * por USUÁRIO, em memória do processo) e o custo do bcrypt. Provado com Redis real atrás de um proxy (down e blackhole), não com porta falsa.
 *
 * Distinção usada nas asserções: os dois 429 têm o MESMO `code` (RATE_LIMITED_PAYMENT_GATEWAY); a mensagem diferencia — "Muitas tentativas de
 * confirmação de senha" = trancamento do step-up (Redis); "Muitas requisições" = limite por minuto da rota (memória).
 */

const ERRADA = 'SenhaErrada#Redis-fora-7c1d'
const MSG_STEPUP = 'Muitas tentativas de confirmação de senha'
const MSG_ROTA = 'Muitas requisições'

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  issueToken: typeof import('../../src/lib/jwt').issueToken
}

describe('step-up de senha com o Redis fora do ar — quanto sobra de proteção (Redis real atrás de proxy)', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  const direct = new Redis(realRedisUrl) // inspeção do Redis real, FORA do proxy
  const usuarios: string[] = []
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgo')
    const [appMod, prismaMod, redisMod, jwtMod] = await Promise.all([import('../../src/api/app'), import('../../src/lib/prisma'), import('../../src/lib/redis'), import('../../src/lib/jwt')])
    m = { createApp: appMod.createApp, prisma: prismaMod.prisma, redis: redisMod.redis, issueToken: jwtMod.issueToken }
    app = m.createApp()
    await esperarRedisPronto()
  }, 120_000)

  afterAll(async () => {
    const chaves = usuarios.map((id) => `login:fail:${createHash('sha256').update(`stepup:${id}`.trim().toLowerCase()).digest('hex').slice(0, 32)}`)
    if (chaves.length > 0) await direct.del(...chaves).catch(() => {})
    await direct.quit().catch(() => {})
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await proxy.stop()
    await banco?.descartar()
  }, 60_000)

  /** `status === 'ready'` sozinho engana logo depois de `proxy.up()` (o ioredis ainda não notou o socket morto): exige um PING que volta. */
  async function esperarRedisPronto() {
    const limite = Date.now() + 30_000
    for (;;) {
      if (m.redis.status === 'ready') {
        const pong = await Promise.race([m.redis.ping().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 800))])
        if (pong === 'PONG') return
      }
      if (Date.now() > limite) throw new Error(`o Redis da API não ficou utilizável (status=${m.redis.status})`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async function novoAdmin() {
    contador += 1
    const user = await m.prisma.user.create({ data: { role: 'ADMIN', name: `Admin ${contador}`, email: `admin-redis-fora-${contador}-${Math.random().toString(36).slice(2, 7)}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    usuarios.push(user.id)
    return { id: user.id, token: m.issueToken({ id: user.id, role: 'ADMIN', operatorId: null }) }
  }
  const put = (u: { token: string }, currentPassword: string) => request(app).put('/api/admin/payment-gateway').set({ Authorization: `Bearer ${u.token}` }).send({ sopClientId: 'sop-redis-fora', currentPassword })

  /** Dispara `n` tentativas erradas EM SÉRIE e devolve o desfecho de cada uma (403 / 429 do step-up / 429 da rota / outro). */
  async function tentativasErradas(u: { token: string }, n: number) {
    const desfechos: string[] = []
    const t0 = Date.now()
    for (let i = 0; i < n; i += 1) {
      const r = await put(u, `${ERRADA}-${i}`)
      if (r.status === 403) desfechos.push('403')
      else if (r.status === 429 && String(r.body.error).includes(MSG_STEPUP)) desfechos.push('429-stepup')
      else if (r.status === 429 && String(r.body.error).includes(MSG_ROTA)) desfechos.push('429-rota')
      else desfechos.push(`${r.status}?`)
    }
    return { desfechos, ms: Date.now() - t0 }
  }
  const contar = (d: string[], k: string) => d.filter((x) => x === k).length

  it('CONTROLE (Redis saudável): 5 erradas = 403 e a 6ª em diante é 429 do STEP-UP (trancamento por usuário) — a medida de comparação', async () => {
    const admin = await novoAdmin()
    const { desfechos } = await tentativasErradas(admin, 8)
    expect(contar(desfechos, '403')).toBe(5)
    expect(contar(desfechos, '429-stepup')).toBe(3)
    expect(contar(desfechos, '429-rota')).toBe(0)
  })

  it('Redis MORTO (conexão recusada): o step-up NÃO tranca — passam 10 tentativas erradas (403) por minuto, o teto vira o limite da ROTA (429 "Muitas requisições"); a senha certa ainda entra (200)', async () => {
    const admin = await novoAdmin()
    await proxy.down()
    try {
      // dá tempo do ioredis notar a queda (status != ready => assertRedisReady lança => fail-open imediato)
      const limite = Date.now() + 10_000
      while (m.redis.status === 'ready' && Date.now() < limite) await new Promise((r) => setTimeout(r, 50))
      const legitimo = await novoAdmin()
      const entrou = await request(app).put('/api/admin/payment-gateway').set({ Authorization: `Bearer ${legitimo.token}` }).send({ sopClientId: 'sop-redis-fora-ok', currentPassword: SENHA_ADMIN_TESTE })
      expect(entrou.status, JSON.stringify(entrou.body)).toBe(200) // fail-open para quem sabe a senha: o admin legítimo não fica trancado do lado de fora
      const { desfechos, ms } = await tentativasErradas(admin, 14)
      // MEDIDO: sem o Redis passam 10 erradas no 1º minuto (o limite por minuto da rota) — contra 5 por 15 min com o Redis
      expect(contar(desfechos, '403'), `desfechos: ${desfechos.join(',')}`).toBe(10)
      expect(contar(desfechos, '429-stepup')).toBe(0)
      expect(contar(desfechos, '429-rota')).toBe(4)
      expect(ms).toBeLessThan(15_000) // Redis morto não pendura a rota (fail-open rápido)
    } finally {
      await proxy.up()
      await esperarRedisPronto()
    }
  }, 60_000)

  it('Redis TRAVADO (blackhole: aceita e não responde): cada tentativa paga o timeout do throttle (≥ 1 s com os dois timeouts de 500 ms) e passam no máximo 10 por minuto; a rota não pendura', async () => {
    const admin = await novoAdmin()
    await proxy.blackhole()
    try {
      const { desfechos, ms } = await tentativasErradas(admin, 12)
      expect(contar(desfechos, '403'), `desfechos: ${desfechos.join(',')}`).toBe(10)
      expect(contar(desfechos, '429-stepup')).toBe(0)
      // custo por tentativa dentro do 403: reserva (500 ms de timeout) + registro da falha (500 ms): o atacante também fica mais lento
      expect(ms / 10).toBeGreaterThan(800)
      expect(ms).toBeLessThan(40_000)
    } finally {
      await proxy.up()
      await esperarRedisPronto()
    }
  }, 90_000)

  it('ao VOLTAR o Redis o limite por usuário volta a valer do zero (a janela sem proteção não deixa dívida nem trancamento fantasma)', async () => {
    const admin = await novoAdmin()
    const { desfechos } = await tentativasErradas(admin, 7)
    expect(contar(desfechos, '403')).toBe(5)
    expect(contar(desfechos, '429-stepup')).toBe(2)
    // e com a senha certa, depois do trancamento, continua barrado (o trancamento é do usuário, não da conexão)
    const certa = await put(admin, SENHA_ADMIN_TESTE)
    expect(certa.status).toBe(429)
  })
})
