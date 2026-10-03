import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import Redis from 'ioredis'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

// A API fala com o Redis por um proxy TCP desta suíte; "derrubar/travar/atrasar o Redis" = mexer no proxy. Tem que valer ANTES de `lib/env` ser importado.
const { proxy, realRedisUrl } = await (async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy, realRedisUrl }
})()

/**
 * QA da Íris (F5.8, rodada Vega-4) — a pergunta que o fail-closed abre: a RESERVA do step-up é um INCR atômico no Redis. Quando o app desiste dela (timeout de 500 ms) e devolve 503,
 * o comando pode AINDA chegar ao Redis depois (Redis lento, ou comando enfileirado/reenviado pelo ioredis na reconexão) — e a vaga fica gasta SEM que ninguém a devolva
 * (`devolverVaga` só existe depois da reserva). Se isso acontecer, uma queda/lentidão do Redis de poucos segundos TRANCA o admin legítimo (5 vagas por 15 min) mesmo com a senha certa,
 * depois que o Redis volta — o oposto do que o 503 "tente em instantes" promete.
 *
 * Medido com Redis real atrás do proxy, 3 modos (morto, travado, lento) e a MESMA conta antes/depois: quantas vagas a conta perdeu e se a senha CERTA entra quando o Redis volta.
 */

const SAIDA = process.env.IRIS_M4C_SAIDA

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  issueToken: typeof import('../../src/lib/jwt').issueToken
}

describe('step-up fail-closed: tentativas recusadas com 503 NÃO podem gastar vaga do limite (Redis real atrás de proxy)', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  const direct = new Redis(realRedisUrl)
  const usuarios: string[] = []
  let contador = 0

  const chaveFalhas = (id: string) => `login:fail:${createHash('sha256').update(`stepup:${id}`.trim().toLowerCase()).digest('hex').slice(0, 32)}`

  beforeAll(async () => {
    banco = await criarBancoProprio('pgg')
    const [appMod, prismaMod, redisMod, jwtMod] = await Promise.all([import('../../src/api/app'), import('../../src/lib/prisma'), import('../../src/lib/redis'), import('../../src/lib/jwt')])
    m = { createApp: appMod.createApp, prisma: prismaMod.prisma, redis: redisMod.redis, issueToken: jwtMod.issueToken }
    app = m.createApp()
    await esperarRedisPronto()
  }, 120_000)

  afterAll(async () => {
    if (usuarios.length > 0) await direct.del(...usuarios.map(chaveFalhas)).catch(() => {})
    await direct.quit().catch(() => {})
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await proxy.stop()
    await banco?.descartar()
  }, 60_000)

  /** `status === 'ready'` sozinho engana logo depois de `proxy.up()`: exige um PING que volta. */
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
    const user = await m.prisma.user.create({ data: { role: 'ADMIN', name: `Admin Vaga ${contador}`, email: `admin-vaga-${contador}-${Math.random().toString(36).slice(2, 7)}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    usuarios.push(user.id)
    return { id: user.id, token: m.issueToken({ id: user.id, role: 'ADMIN', operatorId: null }) }
  }
  const put = (u: { token: string }, sop: string) => request(app).put('/api/admin/payment-gateway').set({ Authorization: `Bearer ${u.token}` }).send({ sopClientId: sop, currentPassword: SENHA_ADMIN_TESTE }).then((r) => r)
  const vagas = async (id: string) => Number((await direct.get(chaveFalhas(id))) ?? 0)

  /** Seis tentativas COM A SENHA CERTA durante a falha (todas 503); espera o Redis voltar e a fila do cliente esvaziar; devolve o desfecho da senha certa depois e as vagas gastas. */
  async function cenario(derrubar: () => Promise<void>, restaurar: () => Promise<void>, rotulo: string) {
    const admin = await novoAdmin()
    expect((await put(admin, 'sop-antes')).status, 'controle: a senha certa entra com o Redis saudável').toBe(200)
    expect(await vagas(admin.id), 'sucesso zera as falhas').toBe(0)
    await derrubar()
    const durante: number[] = []
    for (let i = 0; i < 6; i += 1) durante.push((await put(admin, `sop-durante-${i}`)).status)
    await restaurar()
    await esperarRedisPronto()
    await new Promise((r) => setTimeout(r, 1500)) // deixa chegar ao Redis qualquer comando que o cliente tenha enfileirado/reenviado
    const gastas = await vagas(admin.id)
    const ttlJanelaSeg = await direct.ttl(chaveFalhas(admin.id))
    const depois = await put(admin, `sop-depois-${rotulo}`)
    if (SAIDA) appendFileSync(SAIDA, `[vaga-vazada:${rotulo}] durante=${durante.join(',')} vagas_gastas_no_redis=${gastas} ttl_da_janela=${ttlJanelaSeg}s depois(senha certa)=${depois.status}${depois.status === 429 ? ' retry-after=' + depois.headers['retry-after'] + ' ' + JSON.stringify(depois.body.error) : ''}\n`)
    return { durante, gastas, depois }
  }

  it('Redis MORTO por alguns segundos: depois que volta, a senha CERTA do admin entra (nenhuma das 6 tentativas recusadas com 503 pode ter gasto vaga)', async () => {
    const r = await cenario(() => proxy.down(), () => proxy.up(), 'morto')
    expect(r.durante.every((s) => s === 503 || s === 429)).toBe(true)
    // As vagas gastas no modo 'morto' NÃO são determinísticas (0 numa rodada, 1 em outra: depende de o ioredis ter ou não enfileirado/reenviado o 1º comando antes de notar a queda) — por isso aqui só o DESFECHO é exigido (a conta não pode ficar trancada). O vazamento determinístico (5 vagas) está nos dois casos abaixo.
    expect(r.depois.status).toBe(200)
  }, 120_000)

  // ACHADO A1 da Íris — CORRIGIDO (core/auth/stepUp.ts: a reserva abandonada por timeout tem a vaga devolvida se resolver tarde como allowed). Eram it.fails; agora it, mesmas asserções.
  it('Redis TRAVADO (blackhole): idem', async () => {
    const r = await cenario(() => proxy.blackhole(), () => proxy.up(), 'blackhole')
    expect(r.durante.every((s) => s === 503 || s === 429)).toBe(true)
    expect(r.gastas).toBe(0)
    expect(r.depois.status).toBe(200)
  }, 120_000)

  it('Redis LENTO (vivo, 900 ms por comando): idem — o app desiste em 500 ms mas o INCR chega ao Redis depois', async () => {
    const r = await cenario(async () => proxy.latency(900), async () => proxy.latency(0), 'lento')
    expect(r.durante.every((s) => s === 503 || s === 429)).toBe(true)
    expect(r.gastas, 'o INCR atrasado não pode ficar como vaga gasta de uma tentativa que o app recusou').toBe(0)
    expect(r.depois.status).toBe(200)
  }, 120_000)
})
