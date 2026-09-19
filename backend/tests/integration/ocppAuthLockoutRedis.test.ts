import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { randomInt } from 'node:crypto'
import bcrypt from 'bcryptjs'
import WebSocket from 'ws'

// O IP do handshake sai do X-Forwarded-For só quando OCPP_TRUST_PROXY_HOPS >= 1 (default 0 = só o
// socket). Sem isto todo cliente do teste seria 127.0.0.1 e não haveria como provar "outro IP".
// Precisa valer ANTES de `lib/env` ser importado (ele faz o parse na importação) — por isso hoisted.
vi.hoisted(() => {
  process.env.OCPP_TRUST_PROXY_HOPS = '1'
})

import { prisma } from '../../src/lib/prisma'
import { redis, createRedisConnection } from '../../src/lib/redis'
import { incrWithTtl } from '../../src/lib/redisCounter'
import { startOcppServer } from '../../src/ocpp/server'
import { createTenant, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * Lockout do gateway OCPP contra REDIS REAL, pelo caminho REAL (handshake WebSocket -> `server.auth`
 * -> `authRateLimit.ts` -> script Lua -> Redis) — Órion A1, 2026-09-19. Os testes unitários provam a
 * regra com um Map; aqui se prova o que o Map não prova: o script Lua no Redis de verdade, o TTL, o
 * hash da identidade, o IP vindo do X-Forwarded-For e o que o carregador legítimo vê na rede.
 *
 * Isolamento (suítes rodam em paralelo no MESMO Redis): identidades únicas por execução e IPs
 * aleatórios na faixa de benchmark 198.18.0.0/15 (RFC 2544) — chaves com TTL de 5 min de uma
 * rodada anterior nunca colidem com a atual. Os limites são os do default do env (5 por par, 30 por IP).
 */

const SEGREDO = 'segredo-do-carregador-teste-01' // 16..40, como o admin exige
const MAX_PAR = 5
const MAX_IP = 30

const suffix = uniqueSuffix()
const usedIps = new Set<string>()
/** IP fictício único nesta execução. */
function freshIp(): string {
  for (;;) {
    const ip = `198.${18 + randomInt(0, 2)}.${randomInt(0, 256)}.${randomInt(1, 255)}`
    if (!usedIps.has(ip)) {
      usedIps.add(ip)
      return ip
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

let port = 0
let server: Awaited<ReturnType<typeof startOcppServer>>

/** Faz o handshake WebSocket do gateway e devolve o status HTTP (101 = aceito). Quem foi aceito fecha na hora. */
function handshake(identity: string, password: string, ip: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${encodeURIComponent(identity)}`, ['ocpp1.6'], {
      headers: { Authorization: `Basic ${Buffer.from(`${identity}:${password}`).toString('base64')}`, 'X-Forwarded-For': ip },
      handshakeTimeout: 10_000,
    })
    ws.once('open', () => {
      ws.once('close', () => resolve(101))
      ws.close()
    })
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    ws.once('error', reject)
  })
}

async function createChargePoint(tenant: { operatorId: string; siteId: string }, label: string): Promise<{ id: string; identity: string }> {
  const identity = `cp-lock-${label}-${suffix}`
  const cp = await prisma.chargePoint.create({
    data: { operatorId: tenant.operatorId, siteId: tenant.siteId, ocppIdentity: identity, basicAuthSecretHash: await bcrypt.hash(SEGREDO, 4) },
  })
  return { id: cp.id, identity }
}

/** Todas as chaves de falha de auth deste IP (par identidade+IP e global do IP), com valor e TTL. */
async function failKeysOf(ip: string): Promise<Array<{ key: string; value: number; ttl: number }>> {
  const keys = await redis.keys(`ocpp:auth:fail:*${ip}`)
  return Promise.all(keys.map(async (key) => ({ key, value: Number(await redis.get(key)), ttl: await redis.ttl(key) })))
}

let tenant: Awaited<ReturnType<typeof createTenant>>

beforeAll(async () => {
  tenant = await createTenant({ suffix, label: 'lock', withCharger: false })
  port = await freePort()
  server = await startOcppServer(port)
}, 30_000)

afterAll(async () => {
  await server?.close({ awaitPending: false }).catch(() => {})
  for (const ip of usedIps) {
    const keys = await redis.keys(`ocpp:auth:fail:*${ip}`)
    if (keys.length > 0) await redis.del(...keys)
  }
  redis.disconnect()
})

describe('lockout OCPP — identidade + IP (Redis real, handshake real)', () => {
  it('REGRESSÃO do lockout: o atacante que erra a senha da identidade PÚBLICA trava só o SEU par — o carregador real, de outro IP, continua conectando', async () => {
    const cp = await createChargePoint(tenant, 'par')
    const atacante = freshIp()
    const carregador = freshIp()

    for (let i = 0; i < MAX_PAR; i++) expect(await handshake(cp.identity, `chute-${i}`, atacante)).toBe(401)

    // O par do atacante está trancado (429, sem nem olhar a senha — nem a CERTA passaria daquele IP)...
    expect(await handshake(cp.identity, 'chute-6', atacante)).toBe(429)
    expect(await handshake(cp.identity, SEGREDO, atacante)).toBe(429)

    // ...mas o carregador legítimo, com a credencial certa, de OUTRO IP, entra (101). Antes da correção: 429 por 5 min.
    expect(await handshake(cp.identity, SEGREDO, carregador)).toBe(101)

    // O atacante trancou a identidade só para ele: uma OUTRA identidade, do mesmo IP dele, ainda passa pelo par
    // (o limite do par não vaza para outras identidades).
    const outro = await createChargePoint(tenant, 'par-outro')
    expect(await handshake(outro.identity, SEGREDO, atacante)).toBe(101)
  })

  it('o Redis guarda exatamente o esperado: contador do par = MAX com TTL (janela de 300s), contador global do IP, e nenhuma chave em claro com a identidade', async () => {
    const cp = await createChargePoint(tenant, 'chaves')
    const ip = freshIp()
    for (let i = 0; i < MAX_PAR; i++) await handshake(cp.identity, `errada-${i}`, ip)

    const keys = await failKeysOf(ip)
    const par = keys.find((k) => k.key.startsWith('ocpp:auth:fail:id:'))!
    const global = keys.find((k) => k.key === `ocpp:auth:fail:ip:${ip}`)!
    expect(par.value).toBe(MAX_PAR)
    expect(global.value).toBe(MAX_PAR)
    for (const k of [par, global]) {
      expect(k.ttl).toBeGreaterThan(0) // NUNCA sem TTL (bloqueio permanente)
      expect(k.ttl).toBeLessThanOrEqual(300)
    }
    expect(par.key).not.toContain(cp.identity) // hash, não a identidade da URL
    expect(keys).toHaveLength(2)
  })

  it('tentativa BLOQUEADA não cria nem incrementa chave (o flood contra um par trancado não incha o Redis nem estende o bloqueio)', async () => {
    const cp = await createChargePoint(tenant, 'bloq')
    const ip = freshIp()
    for (let i = 0; i < MAX_PAR; i++) await handshake(cp.identity, `errada-${i}`, ip)
    const antes = await failKeysOf(ip)

    for (let i = 0; i < 10; i++) expect(await handshake(cp.identity, `mais-${i}`, ip)).toBe(429)

    const depois = await failKeysOf(ip)
    expect(depois.map((k) => [k.key, k.value]).sort()).toEqual(antes.map((k) => [k.key, k.value]).sort())
  })

  it('sucesso zera SÓ o par: falhas antigas do carregador real somem, mas o contador GLOBAL do IP continua (senão um IP intercalaria acerto e erro para sempre)', async () => {
    const cp = await createChargePoint(tenant, 'sucesso')
    const ip = freshIp()
    for (let i = 0; i < MAX_PAR - 1; i++) expect(await handshake(cp.identity, `errada-${i}`, ip)).toBe(401)
    expect((await failKeysOf(ip)).find((k) => k.key.startsWith('ocpp:auth:fail:id:'))?.value).toBe(MAX_PAR - 1)

    expect(await handshake(cp.identity, SEGREDO, ip)).toBe(101)

    const keys = await failKeysOf(ip)
    expect(keys.find((k) => k.key.startsWith('ocpp:auth:fail:id:'))).toBeUndefined() // par zerado
    expect(keys.find((k) => k.key === `ocpp:auth:fail:ip:${ip}`)?.value).toBe(MAX_PAR - 1) // global intacto

    // Consequência prática: depois do sucesso o carregador tem MAX_PAR novas chances antes de trancar.
    for (let i = 0; i < MAX_PAR - 1; i++) expect(await handshake(cp.identity, `errada2-${i}`, ip)).toBe(401)
    expect(await handshake(cp.identity, SEGREDO, ip)).toBe(101)
  })

  it('FLOOD de identidades inexistentes do MESMO IP bate no limite global (cada identidade nova tem o par zerado, só o global freia) — e o carregador legítimo daquele IP também fica de fora', async () => {
    const cp = await createChargePoint(tenant, 'flood')
    const ipFlood = freshIp()
    const ipOutro = freshIp()

    for (let i = 0; i < MAX_IP; i++) expect(await handshake(`fantasma-${suffix}-${i}`, 'x', ipFlood)).toBe(401)

    // A 31ª identidade (nova, par zerado) já é barrada ANTES do banco/bcrypt.
    expect(await handshake(`fantasma-${suffix}-novo`, 'x', ipFlood)).toBe(429)
    // O global tem precedência: até uma identidade real com a senha certa, vindo desse IP, é barrada.
    expect(await handshake(cp.identity, SEGREDO, ipFlood)).toBe(429)

    // Outro IP não sente nada.
    expect(await handshake(cp.identity, SEGREDO, ipOutro)).toBe(101)

    const global = (await failKeysOf(ipFlood)).find((k) => k.key === `ocpp:auth:fail:ip:${ipFlood}`)!
    expect(global.value).toBe(MAX_IP) // as barradas não somaram
    expect(global.ttl).toBeGreaterThan(0)
  })

  it('o X-Forwarded-For forjado NÃO fura o limite quando há proxy confiável (hops=1): vale o último valor, o que o proxy viu', async () => {
    // Com hops=1 o cliente controla só o que vem ANTES do que o proxy acrescentou. Simulamos o proxy mandando "<forjado>, <real>":
    // a chave é o IP real (último), então trocar o valor forjado não dá contador novo.
    const cp = await createChargePoint(tenant, 'xff')
    const real = freshIp()
    const enviar = (senha: string, forjado: string) =>
      new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${cp.identity}`, ['ocpp1.6'], {
          headers: { Authorization: `Basic ${Buffer.from(`${cp.identity}:${senha}`).toString('base64')}`, 'X-Forwarded-For': `${forjado}, ${real}` },
        })
        ws.once('unexpected-response', (_req, res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        ws.once('open', () => {
          ws.close()
          resolve(101)
        })
        ws.once('error', reject)
      })

    for (let i = 0; i < MAX_PAR; i++) expect(await enviar(`errada-${i}`, `203.0.113.${i + 1}`)).toBe(401)
    expect(await enviar('outra', '203.0.113.200')).toBe(429) // IP forjado novo, mesmo IP real -> mesmo par trancado
  })

  it('o gateway continua respondendo depois do bloqueio (sanidade: 429 é resposta do gateway, não queda)', async () => {
    const cp = await createChargePoint(tenant, 'sanidade')
    expect(await handshake(cp.identity, SEGREDO, freshIp())).toBe(101)
  })
})

describe('atomicidade do script Lua (INCR + EXPIRE) no Redis real', () => {
  it('200 incrementos PARALELOS em uma conexão contam exatamente 200 — cada chamada recebe um valor distinto (sem perda, sem duplicata) e a chave nasce com TTL', async () => {
    const key = `test:lua:${suffix}:um`
    const resultados = await Promise.all(Array.from({ length: 200 }, () => incrWithTtl(redis, key, 60)))
    try {
      expect(await redis.get(key)).toBe('200')
      expect([...resultados].sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
      const ttl = await redis.ttl(key)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(60)
    } finally {
      await redis.del(key)
    }
  })

  it('incrementos concorrentes de VÁRIAS conexões (várias réplicas do gateway) também contam exato, e o TTL nunca fica ausente (a chave nunca vira bloqueio permanente)', async () => {
    const key = `test:lua:${suffix}:varias`
    const conexoes = Array.from({ length: 5 }, () => createRedisConnection())
    try {
      const resultados = (await Promise.all(conexoes.flatMap((c) => Array.from({ length: 40 }, () => incrWithTtl(c, key, 60))))).sort((a, b) => a - b)
      expect(resultados).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
      expect(await redis.get(key)).toBe('200')
      const ttl = await redis.ttl(key)
      expect(ttl).toBeGreaterThan(0) // -1 = sem TTL, -2 = sumiu
      expect(ttl).toBeLessThanOrEqual(60)
    } finally {
      await redis.del(key)
      await Promise.all(conexoes.map((c) => c.quit().catch(() => {})))
    }
  })

  it('o TTL é definido só na criação: incrementos seguintes NÃO o renovam (a janela é fixa, o atacante não a estende nem a encurta)', async () => {
    const key = `test:lua:${suffix}:ttl`
    try {
      await incrWithTtl(redis, key, 100)
      await redis.pexpire(key, 20_000) // simula "a janela já andou": restam ~20s
      await incrWithTtl(redis, key, 100)
      await incrWithTtl(redis, key, 100)
      const restante = await redis.pttl(key)
      expect(restante).toBeGreaterThan(0)
      expect(restante).toBeLessThanOrEqual(20_000) // não voltou para 100s
    } finally {
      await redis.del(key)
    }
  })

  it('a janela expira de verdade: depois do TTL a chave some e o contador recomeça em 1', async () => {
    const key = `test:lua:${suffix}:expira`
    await incrWithTtl(redis, key, 1)
    await incrWithTtl(redis, key, 1)
    await waitFor(async () => (await redis.exists(key)) === 0, { timeoutMs: 4_000, what: 'chave expirar' })
    expect(await incrWithTtl(redis, key, 1)).toBe(1)
    await redis.del(key)
  })
})

describe('rajada paralela de tentativas contra o mesmo par (reserva ANTES de avaliar)', () => {
  /**
   * Achado da Íris (2026-09-19), corrigido: `authenticateChargePoint` fazia `check()` (lia o contador) ->
   * banco -> `bcrypt.compare` -> SÓ ENTÃO `registerFailure()` (INCR). Uma rajada de N handshakes paralelos
   * lia 0 nas N tentativas e as N eram avaliadas (medido: 40 paralelos = 40 avaliadas, 0 barradas). Causa
   * raiz: decisão tomada sobre um sinal instantâneo. Agora `reserve` decide E conta num passo atômico
   * (Lua) ANTES do trabalho caro: cada tentativa em andamento já ocupa uma vaga.
   */
  it('rajada de 40 handshakes paralelos com senha errada: EXATAMENTE o limite do par (5) é avaliado (401) e o resto é barrado (429)', async () => {
    const cp = await createChargePoint(tenant, 'rajada')
    const ip = freshIp()
    const N = 40
    const status = await Promise.all(Array.from({ length: N }, (_, i) => handshake(cp.identity, `rajada-${i}`, ip)))
    const avaliadas = status.filter((s) => s === 401).length
    const barradas = status.filter((s) => s === 429).length

    expect(avaliadas).toBe(MAX_PAR)
    expect(barradas).toBe(N - MAX_PAR)

    // O contador fecha exato no limite (a tentativa barrada não incrementa nada) e o global do IP conta as mesmas vagas.
    const chaves = await failKeysOf(ip)
    expect(chaves.find((k) => k.key.startsWith('ocpp:auth:fail:id:'))!.value).toBe(MAX_PAR)
    expect(chaves.find((k) => k.key.startsWith('ocpp:auth:fail:ip:'))!.value).toBe(MAX_PAR)
  })

  it('a rajada trava só o par do atacante: o carregador real, de OUTRO IP, conecta durante e depois dela', async () => {
    const cp = await createChargePoint(tenant, 'rajada-legitimo')
    const atacante = freshIp()
    const legitimo = freshIp()
    const [aposRajada, legitimoDuranteRajada] = await Promise.all([
      Promise.all(Array.from({ length: 30 }, (_, i) => handshake(cp.identity, `errada-${i}`, atacante))),
      handshake(cp.identity, SEGREDO, legitimo),
    ])
    expect(aposRajada.filter((s) => s === 401)).toHaveLength(MAX_PAR)
    expect(legitimoDuranteRajada).toBe(101)
    expect(await handshake(cp.identity, SEGREDO, legitimo)).toBe(101)
    expect(await handshake(cp.identity, SEGREDO, atacante)).toBe(429) // o par do atacante segue trancado, até com a senha certa
  })

  it('rajada MISTA (senhas erradas + a certa, em paralelo, mesmo par): a certa que passa do portão conecta e ZERA o par; nenhuma vaga fica vazada', async () => {
    const cp = await createChargePoint(tenant, 'rajada-mista')
    const ip = freshIp()
    // 3 erradas + 1 certa: cabem nas 5 vagas, nada é barrado
    const status = await Promise.all([handshake(cp.identity, 'x1', ip), handshake(cp.identity, 'x2', ip), handshake(cp.identity, 'x3', ip), handshake(cp.identity, SEGREDO, ip)])
    expect(status.sort()).toEqual([101, 401, 401, 401])
    // Depois do sucesso o par volta a zero (mesmo que a certa tenha terminado antes de alguma errada)
    const par = (await failKeysOf(ip)).find((k) => k.key.startsWith('ocpp:auth:fail:id:'))
    expect(par === undefined || par.value <= 3).toBe(true)
    // O global do IP guarda só as FALHAS (o sucesso devolveu a vaga dele): 3, não 4
    expect((await failKeysOf(ip)).find((k) => k.key.startsWith('ocpp:auth:fail:ip:'))!.value).toBe(3)
  })

  it('erro NOSSO no meio (banco fora do ar) devolve as vagas: o carregador não é bloqueado por indisponibilidade do servidor', async () => {
    const cp = await createChargePoint(tenant, 'erro-banco')
    const ip = freshIp()
    const espionado = vi.spyOn(prisma.chargePoint, 'findUnique').mockRejectedValue(new Error('banco indisponível (simulado)') as never)
    try {
      const status: number[] = []
      for (let i = 0; i < MAX_PAR + 3; i++) status.push(await handshake(cp.identity, SEGREDO, ip)) // em sequência: cada uma devolve a vaga antes da próxima
      expect(status).toEqual(Array(MAX_PAR + 3).fill(500)) // nenhum virou 429: as reservas foram devolvidas
    } finally {
      espionado.mockRestore()
    }
    expect(await failKeysOf(ip)).toEqual([]) // nem chave sobrou
    expect(await handshake(cp.identity, SEGREDO, ip)).toBe(101) // e o carregador conecta assim que o banco volta
  })
})
