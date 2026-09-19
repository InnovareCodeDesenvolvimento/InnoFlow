import { afterAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomInt } from 'node:crypto'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import Redis from 'ioredis'

// A API fala com o Redis por um proxy TCP DESTA suíte (ver helpers/redisProxy.ts): assim "derrubar o
// Redis" é derrubar o proxy — o Redis compartilhado (outras suítes em paralelo) nunca é tocado. Tem
// que valer ANTES de `lib/env` ser importado, por isso hoisted (e async: o proxy precisa estar de pé).
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
import { prisma } from '../../src/lib/prisma'
import { createUser, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * Throttle de login POR CONTA contra Redis REAL (Órion M7, 2026-09-19) pela rota real
 * `POST /api/auth/login`: backoff, 429 RATE_LIMITED_ACCOUNT, sucesso zerando só as falhas, e o
 * FAIL-OPEN com o Redis fora do ar (o login não pode pendurar nem cair).
 *
 * Isolamento: e-mails únicos por execução e um IP fictício (X-Forwarded-For; a API confia em 2
 * "hops") por teste — o limite por IP (20 falhas/15min, em memória do processo) e as chaves de 15 min
 * do Redis nunca colidem entre testes nem entre rodadas.
 */

const SENHA = 'SenhaCerta#123'
const suffix = uniqueSuffix()
const app = createApp()
const direct = new Redis(realRedisUrl) // inspeção/manipulação do Redis real, FORA do proxy

const usedIps = new Set<string>()
const touchedEmails = new Set<string>()
function freshIp(): string {
  for (;;) {
    const ip = `198.${18 + randomInt(0, 2)}.${randomInt(0, 256)}.${randomInt(1, 255)}`
    if (!usedIps.has(ip)) {
      usedIps.add(ip)
      return ip
    }
  }
}

/** Mesma derivação de `core/auth/loginThrottle.ts` (sha256 do e-mail em minúsculas, 32 hex) — o teste precisa achar a chave para inspecionar TTL/valor. */
const accountId = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)
const lockKey = (email: string) => `login:lock:${accountId(email)}`
const failKey = (email: string) => `login:fail:${accountId(email)}`
const strikesKey = (email: string) => `login:strikes:${accountId(email)}`

function login(email: string, password: string, ip: string) {
  touchedEmails.add(email)
  return request(app).post('/api/auth/login').set('X-Forwarded-For', `${ip}, 10.0.0.1`).send({ email, password })
}

async function novaConta(label: string) {
  const passwordHash = await bcrypt.hash(SENHA, 4)
  const u = await createUser({ role: 'DRIVER', label, suffix, passwordHash })
  touchedEmails.add(u.email)
  return u
}

/** O registro da falha roda em segundo plano DEPOIS da resposta 401 (`void throttleSafely(...)`); espera o efeito aparecer no Redis. */
const aguardarFalhas = (email: string, n: number) => waitFor(async () => Number(await direct.get(failKey(email))) === n, { what: `${n} falha(s) de ${email} no Redis` })
const aguardarLock = (email: string) => waitFor(async () => (await direct.ttl(lockKey(email))) > 0, { what: `trancamento de ${email}` })

afterAll(async () => {
  const keys = [...touchedEmails].flatMap((e) => [lockKey(e), failKey(e), strikesKey(e)])
  if (keys.length > 0) await direct.del(...keys)
  await direct.quit().catch(() => {})
  redis.disconnect()
  await proxy.stop()
})

describe('throttle de login por conta — Redis real', () => {
  it('5 falhas trancam a conta: a 6ª tentativa leva 429 RATE_LIMITED_ACCOUNT com Retry-After (~60s) — INCLUSIVE com a senha certa', async () => {
    const u = await novaConta('lock')
    const ip = freshIp()

    for (let i = 1; i <= 5; i++) {
      expect((await login(u.email, `errada-${i}`, ip)).status).toBe(401)
      if (i < 5) await aguardarFalhas(u.email, i)
    }
    await aguardarLock(u.email)

    const errada = await login(u.email, 'errada-6', ip)
    expect(errada.status).toBe(429)
    expect(errada.body).toEqual({ error: 'Muitas tentativas de login para esta conta. Tente novamente mais tarde.', code: 'RATE_LIMITED_ACCOUNT' })
    const retryAfter = Number(errada.headers['retry-after'])
    expect(retryAfter).toBeGreaterThan(50)
    expect(retryAfter).toBeLessThanOrEqual(60)

    // Conta trancada recusa até a senha CERTA (senão o atacante seguiria adivinhando durante o trancamento).
    const certa = await login(u.email, SENHA, ip)
    expect(certa.status).toBe(429)
    expect(certa.body.token).toBeUndefined()

    // O balde de falhas recomeça depois do trancamento; o TTL do lock e as reincidências ficaram no Redis.
    expect(await direct.exists(failKey(u.email))).toBe(0)
    expect(await direct.get(strikesKey(u.email))).toBe('1')
    expect(await direct.ttl(lockKey(u.email))).toBeLessThanOrEqual(60)
  })

  it('o trancamento é POR CONTA: outra conta, do MESMO IP, continua logando', async () => {
    const alvo = await novaConta('alvo')
    const outra = await novaConta('outra')
    const ip = freshIp()
    for (let i = 1; i <= 5; i++) {
      await login(alvo.email, `errada-${i}`, ip)
      if (i < 5) await aguardarFalhas(alvo.email, i)
    }
    await aguardarLock(alvo.email)

    expect((await login(alvo.email, SENHA, ip)).status).toBe(429)
    expect((await login(outra.email, SENHA, ip)).status).toBe(200)
  })

  it('a MESMA conta atacada de vários IPs (brute-force distribuído) tranca do mesmo jeito — é o que o limite por IP não cobre', async () => {
    const u = await novaConta('distribuido')
    for (let i = 1; i <= 5; i++) {
      expect((await login(u.email, `errada-${i}`, freshIp())).status).toBe(401) // cada tentativa de um IP diferente
      if (i < 5) await aguardarFalhas(u.email, i)
    }
    await aguardarLock(u.email)
    expect((await login(u.email, SENHA, freshIp())).status).toBe(429) // até de um IP virgem
  })

  it('o balde é do e-mail em MINÚSCULAS: variar a caixa não dá contador novo', async () => {
    const u = await novaConta('caixa')
    const ip = freshIp()
    const variantes = [u.email, u.email.toUpperCase(), u.email, u.email.toUpperCase(), u.email]
    for (const [i, v] of variantes.entries()) {
      await login(v, `errada-${i}`, ip)
      if (i < 4) await aguardarFalhas(u.email, i + 1)
    }
    await aguardarLock(u.email)
    expect((await login(u.email, SENHA, ip)).status).toBe(429)
  })

  it('e-mail INEXISTENTE também é trancado (a resposta é uniforme: um 429 só para contas reais denunciaria quais existem)', async () => {
    const fantasma = `fantasma-${suffix}@example.com`
    const ip = freshIp()
    for (let i = 1; i <= 5; i++) {
      expect((await login(fantasma, `errada-${i}`, ip)).status).toBe(401)
      if (i < 5) await aguardarFalhas(fantasma, i)
    }
    await aguardarLock(fantasma)
    const res = await login(fantasma, 'qualquer', ip)
    expect(res.status).toBe(429)
    expect(res.body.code).toBe('RATE_LIMITED_ACCOUNT')
  })

  it('BACKOFF: cada reincidência dobra o trancamento (60s -> 120s -> 240s); depois de expirar, a conta volta a logar', async () => {
    const u = await novaConta('backoff')
    const ip = freshIp()
    const esperado = [60, 120, 240]

    for (const [rodada, segundos] of esperado.entries()) {
      for (let i = 1; i <= 5; i++) {
        expect((await login(u.email, `errada-${rodada}-${i}`, ip)).status).toBe(401)
        if (i < 5) await aguardarFalhas(u.email, i)
      }
      await aguardarLock(u.email)
      const ttl = await direct.ttl(lockKey(u.email))
      expect(ttl).toBeGreaterThan(segundos - 8)
      expect(ttl).toBeLessThanOrEqual(segundos)
      expect(await direct.get(strikesKey(u.email))).toBe(String(rodada + 1))

      // "Passou o tempo": tirar a chave de trancamento equivale ao TTL vencer (esperar 60s+ num teste não é determinístico nem barato).
      await direct.del(lockKey(u.email))
    }

    // Trancamento vencido: a senha certa entra de novo.
    expect((await login(u.email, SENHA, ip)).status).toBe(200)
  })

  it('sucesso zera as FALHAS recentes mas NÃO as reincidências (acertar uma vez não "limpa o histórico" do atacante)', async () => {
    const u = await novaConta('sucesso')
    const ip = freshIp()
    for (let i = 1; i <= 5; i++) {
      await login(u.email, `errada-${i}`, ip)
      if (i < 5) await aguardarFalhas(u.email, i)
    }
    await aguardarLock(u.email)
    await direct.del(lockKey(u.email)) // trancamento 1 venceu

    for (let i = 1; i <= 4; i++) {
      await login(u.email, `errada-b${i}`, ip)
      await aguardarFalhas(u.email, i)
    }
    expect((await login(u.email, SENHA, ip)).status).toBe(200) // 4 falhas < 5: ainda deixa entrar
    await waitFor(async () => (await direct.exists(failKey(u.email))) === 0, { what: 'falhas zeradas pelo sucesso' })
    expect(await direct.get(strikesKey(u.email))).toBe('1') // a reincidência continua lembrada

    // 4 falhas de novo depois do sucesso NÃO trancam (o balde recomeçou do zero)...
    for (let i = 1; i <= 4; i++) {
      await login(u.email, `errada-c${i}`, ip)
      await aguardarFalhas(u.email, i)
    }
    expect((await login(u.email, SENHA, ip)).status).toBe(200)
    // ...e a próxima leva de 5 falhas tranca com o tempo da 2ª reincidência (120s), não o da 1ª.
    await waitFor(async () => (await direct.exists(failKey(u.email))) === 0)
    for (let i = 1; i <= 5; i++) {
      await login(u.email, `errada-d${i}`, ip)
      if (i < 5) await aguardarFalhas(u.email, i)
    }
    await aguardarLock(u.email)
    expect(await direct.ttl(lockKey(u.email))).toBeGreaterThan(110)
  })

  it('nenhuma chave do throttle no Redis contém o e-mail em claro', async () => {
    const u = await novaConta('claro')
    await login(u.email, 'errada', freshIp())
    await aguardarFalhas(u.email, 1)
    for (const key of await direct.keys('login:*')) {
      expect(key).not.toContain('@')
      expect(key).not.toContain(suffix)
    }
  })
})

describe('login: o limite por IP conta só FALHAS (Órion M7)', () => {
  it('25 logins BEM-SUCEDIDOS do mesmo IP não gastam o balde (antes: 20 por 15 min, sucessos incluídos); só as falhas contam — a 21ª falha leva 429 RATE_LIMITED_AUTH', async () => {
    const ip = freshIp()
    const bom = await novaConta('so-falhas')
    for (let i = 0; i < 25; i++) expect((await login(bom.email, SENHA, ip)).status).toBe(200)

    // 20 falhas (cada uma numa conta diferente, para não trancar conta nenhuma) passam como 401...
    const contas = await Promise.all(Array.from({ length: 21 }, (_, i) => novaConta(`f${i}`)))
    for (let i = 0; i < 20; i++) expect((await login(contas[i].email, 'errada', ip)).status).toBe(401)
    // ...e só a 21ª falha estoura o limite do IP.
    const estouro = await login(contas[20].email, 'errada', ip)
    expect(estouro.status).toBe(429)
    expect(estouro.body.code).toBe('RATE_LIMITED_AUTH')
  }, 60_000)
})

describe('FAIL-OPEN: Redis fora do ar não derruba nem pendura o login', () => {
  // O ioredis é configurado com `maxRetriesPerRequest: null` (exigência do BullMQ): com o Redis fora ele
  // NÃO falha o comando — enfileira e espera reconectar. Sem o timeout de 500ms de `throttleSafely` o
  // login penduraria junto. O teto abaixo (2s) é ~4x o timeout: o que importa provar é "não pendura".
  const TETO_MS = 2_000

  async function medir<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
    const t0 = Date.now()
    const result = await fn()
    return { ms: Date.now() - t0, result }
  }

  it('Redis MORTO (conexão recusada): login correto = 200 em ~0,5s, login errado = 401 (não 500) — e ao voltar o throttle volta a valer, com o trancamento que estava guardado', async () => {
    const trancada = await novaConta('outage-trancada')
    const ip = freshIp()
    for (let i = 1; i <= 5; i++) {
      await login(trancada.email, `errada-${i}`, ip)
      if (i < 5) await aguardarFalhas(trancada.email, i)
    }
    await aguardarLock(trancada.email)
    expect((await login(trancada.email, SENHA, ip)).status).toBe(429) // linha de base: com Redis, trancada

    const u = await novaConta('outage-morto')
    // aquece: a conexão do proxy está aberta e o comando de checagem passa
    expect((await login(u.email, SENHA, ip)).status).toBe(200)

    await proxy.down()
    try {
      const ok = await medir(() => login(u.email, SENHA, ip))
      expect(ok.result.status).toBe(200)
      expect(ok.result.body.token).toBeTruthy()
      expect(ok.ms).toBeLessThan(TETO_MS)

      const ruim = await medir(() => login(u.email, 'errada', ip))
      expect(ruim.result.status).toBe(401)
      expect(ruim.result.body.code).toBe('INVALID_CREDENTIALS')
      expect(ruim.ms).toBeLessThan(TETO_MS)

      // Consequência ASSUMIDA do fail-open (documentada no código): sem Redis a proteção por conta some — a conta que
      // estava trancada consegue entrar com a senha certa. Prova que o comportamento é o do desenho, não acidente.
      const deTrancada = await medir(() => login(trancada.email, SENHA, ip))
      expect(deTrancada.result.status).toBe(200)
      expect(deTrancada.ms).toBeLessThan(TETO_MS)
      console.log(`[medicao] Redis morto: login ok em ${ok.ms}ms, login errado em ${ruim.ms}ms`)
    } finally {
      await proxy.up()
    }

    // Recuperação: o cliente reconecta sozinho e o trancamento (que continua no Redis real) volta a valer.
    await waitFor(async () => (await login(trancada.email, SENHA, ip)).status === 429, { timeoutMs: 10_000, intervalMs: 300, what: 'throttle voltar depois do Redis' })
  }, 40_000)

  it('Redis TRAVADO (aceita a conexão e não responde — partição de rede): mesmo resultado, sem pendurar', async () => {
    const u = await novaConta('outage-travado')
    const ip = freshIp()
    expect((await login(u.email, SENHA, ip)).status).toBe(200)

    await proxy.blackhole()
    try {
      const ok = await medir(() => login(u.email, SENHA, ip))
      expect(ok.result.status).toBe(200)
      expect(ok.ms).toBeLessThan(TETO_MS)

      const ruim = await medir(() => login(u.email, 'errada', ip))
      expect(ruim.result.status).toBe(401)
      expect(ruim.ms).toBeLessThan(TETO_MS)
      console.log(`[medicao] Redis travado: login ok em ${ok.ms}ms, login errado em ${ruim.ms}ms`)
    } finally {
      await proxy.up()
    }
    await waitFor(async () => (await login(u.email, SENHA, ip)).status === 200, { timeoutMs: 10_000, intervalMs: 300, what: 'login normal depois do Redis' })
  }, 40_000)

  it('vários logins SIMULTÂNEOS com o Redis fora do ar terminam todos (nenhum fica pendurado esperando a fila do ioredis)', async () => {
    const contas = await Promise.all(Array.from({ length: 6 }, (_, i) => novaConta(`outage-par${i}`)))
    const ip = freshIp()
    expect((await login(contas[0].email, SENHA, ip)).status).toBe(200) // aquece

    await proxy.down()
    try {
      const { ms, result } = await medir(() => Promise.all(contas.map((c) => login(c.email, SENHA, ip))))
      expect(result.map((r) => r.status)).toEqual(Array(6).fill(200))
      expect(ms).toBeLessThan(TETO_MS * 2)
    } finally {
      await proxy.up()
    }
    await waitFor(async () => (await prisma.user.count({ where: { id: contas[0].id } })) === 1)
  }, 40_000)
})

describe('rajada paralela de logins errados contra UMA conta (check-then-act)', () => {
  /**
   * FURO CONHECIDO (achado da Íris, 2026-09-19 — NÃO corrigido aqui): `/login` faz `throttle.check()`
   * (lê a chave de trancamento) -> bcrypt -> SÓ DEPOIS `registerFailure()` (em segundo plano, depois da
   * resposta). Uma rajada paralela lê "não trancada" em todas as tentativas e as N são avaliadas: o
   * limite de 5 vira o tamanho da rajada. O contador conta certo (Lua atômico); o buraco é o portão.
   * `loginRateLimit` (por IP) tem o mesmo desenho (conta na RESPOSTA). Desejado: reservar a tentativa
   * antes de avaliar. `it.fails` = comportamento desejado descrito; vire `it` ao corrigir.
   */
  it.fails('15 senhas erradas EM PARALELO contra a mesma conta: só ~o limite de falhas chega a ser avaliado (FURO CONHECIDO: hoje todas são avaliadas)', async () => {
    const u = await novaConta('rajada')
    const ip = freshIp()
    const N = 15 // abaixo dos 20 do limite por IP, para o teste medir SÓ o throttle por conta
    const respostas = await Promise.all(Array.from({ length: N }, (_, i) => login(u.email, `rajada-${i}`, ip)))
    const avaliadas = respostas.filter((r) => r.status === 401).length
    expect(avaliadas).toBeLessThanOrEqual(10) // limite 5, tolerância 2x
  }, 60_000)
})
