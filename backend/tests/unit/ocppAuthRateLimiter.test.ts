import { describe, expect, it } from 'vitest'
import { createOcppAuthRateLimiter, type AuthCounterStore } from '../../src/core/ocpp/authRateLimiter'
import { resolveHandshakeIp } from '../../src/core/ocpp/clientIp'
import { createChargePointSchema, updateChargePointSchema } from '../../src/api/schemas/chargePoint.schema'

/**
 * Store em memória (sem TTL — os testes não avançam a janela). `reserve`/`settleFailure` têm a mesma semântica dos
 * scripts Lua (lib/redisCounter.ts): síncrono = atômico. Três contadores: par, falhas do IP e em andamento do IP.
 */
function memoryStore(): AuthCounterStore & { keys(): string[] } {
  const data = new Map<string, number>()
  const giveBack = (key: string) => {
    const v = data.get(key) ?? 0
    if (v > 1) data.set(key, v - 1)
    else data.delete(key)
  }
  return {
    async reserve(keys, limits) {
      const fails = data.get(keys.ipFailures) ?? 0
      if (fails >= limits.maxIpFailures) return { ok: false, scope: 'ip' }
      const inflight = data.get(keys.ipInflight) ?? 0
      if (inflight >= limits.maxIpInflight) return { ok: false, scope: 'ip' }
      const pair = data.get(keys.pair) ?? 0
      if (pair >= limits.maxPair) return { ok: false, scope: 'identity_ip' }
      data.set(keys.pair, pair + 1)
      data.set(keys.ipInflight, inflight + 1)
      return { ok: true, pairCount: pair + 1, ipFailures: fails }
    },
    async settleFailure(keys) {
      const fails = (data.get(keys.ipFailures) ?? 0) + 1
      data.set(keys.ipFailures, fails)
      giveBack(keys.ipInflight)
      return fails
    },
    async release(keys) {
      for (const k of keys) {
        const v = data.get(k) ?? 0
        if (v > 1) data.set(k, v - 1)
        else data.delete(k)
      }
    },
    async del(keys) {
      for (const k of keys) data.delete(k)
    },
    keys: () => [...data.keys()],
  }
}

const CONFIG = { maxAttemptsPerIdentityIp: 5, maxFailuresPerIp: 30, windowSeconds: 300 }

type Limiter = ReturnType<typeof createOcppAuthRateLimiter>
type Attempt = { identity: string; ip: string }

/** Uma tentativa que FALHA (identidade desconhecida/senha errada): reserva a vaga e a falha fica contada. `null` = barrada pelo portão. */
async function falhar(limiter: Limiter, attempt: Attempt) {
  const gate = await limiter.reserve(attempt)
  return gate.allowed ? limiter.registerFailure(attempt, gate) : null
}

/** "Espia" o portão sem gastar vaga: reserva e devolve na hora. */
async function portao(limiter: Limiter, attempt: Attempt) {
  const gate = await limiter.reserve(attempt)
  if (gate.allowed) await limiter.release(attempt)
  return gate.allowed ? ({ allowed: true } as const) : gate
}

describe('createOcppAuthRateLimiter (Órion A1)', () => {
  it('REGRESSÃO do lockout: o atacante que erra 5 vezes a identidade PÚBLICA trava só o SEU par — o carregador real (outro IP) segue autenticando', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const atacante = { identity: 'CP-REAL-001', ip: '203.0.113.9' }
    const carregadorReal = { identity: 'CP-REAL-001', ip: '198.51.100.7' }

    for (let i = 0; i < 5; i++) await falhar(limiter, atacante)

    expect(await portao(limiter, atacante)).toEqual({ allowed: false, scope: 'identity_ip' })
    expect(await portao(limiter, carregadorReal)).toEqual({ allowed: true }) // o buraco: antes era 429 também
  })

  it('abaixo do limite do par continua permitido', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    for (let i = 0; i < 4; i++) await falhar(limiter, { identity: 'CP-1', ip: '1.1.1.1' })
    expect(await portao(limiter, { identity: 'CP-1', ip: '1.1.1.1' })).toEqual({ allowed: true })
  })

  it('sucesso ZERA o contador do par (falhas antigas do carregador real não acumulam até bloquear)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const par = { identity: 'CP-1', ip: '1.1.1.1' }
    for (let i = 0; i < 4; i++) await falhar(limiter, par)
    expect((await limiter.reserve(par)).allowed).toBe(true) // a 5ª tentativa: senha certa
    await limiter.registerSuccess(par)
    for (let i = 0; i < 4; i++) await falhar(limiter, par) // 4 de novo: sem o zerar seriam 8
    expect(await portao(limiter, par)).toEqual({ allowed: true })
  })

  it('sucesso NÃO zera o contador global do IP (senão um IP intercalaria sucesso e falha para nunca estourar) — só devolve a SUA vaga', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), { ...CONFIG, maxFailuresPerIp: 6 })
    const ip = '9.9.9.9'
    for (let i = 0; i < 3; i++) await falhar(limiter, { identity: 'CP-A', ip })
    expect((await limiter.reserve({ identity: 'CP-A', ip })).allowed).toBe(true)
    await limiter.registerSuccess({ identity: 'CP-A', ip }) // o sucesso NÃO conta como falha: o global segue em 3
    for (let i = 0; i < 3; i++) await falhar(limiter, { identity: 'CP-B', ip })
    expect(await portao(limiter, { identity: 'CP-C', ip })).toEqual({ allowed: false, scope: 'ip' }) // 3 + 3 = 6
  })

  it('FLOOD de identidades inexistentes do MESMO IP estoura o limite global (cada identidade nova teria o próprio par zerado)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const ip = '203.0.113.50'
    for (let i = 0; i < 30; i++) await falhar(limiter, { identity: `INEXISTENTE-${i}`, ip })

    expect(await portao(limiter, { identity: 'INEXISTENTE-999', ip })).toEqual({ allowed: false, scope: 'ip' })
    expect(await portao(limiter, { identity: 'CP-REAL-001', ip: '198.51.100.7' })).toEqual({ allowed: true }) // outro IP não é afetado
  })

  it('o bloqueio global do IP tem precedência sobre o do par (é ele que protege o banco)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), { ...CONFIG, maxFailuresPerIp: 5 })
    for (let i = 0; i < 5; i++) await falhar(limiter, { identity: 'CP-1', ip: '2.2.2.2' })
    expect(await portao(limiter, { identity: 'CP-1', ip: '2.2.2.2' })).toEqual({ allowed: false, scope: 'ip' })
  })

  it('describeFailure sinaliza o instante EXATO em que o bloqueio ativa (para alertar uma vez, sem spam)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const par = { identity: 'CP-1', ip: '3.3.3.3' }
    const flags: Array<boolean | null> = []
    for (let i = 0; i < 7; i++) flags.push((await falhar(limiter, par))?.identityIpBlockedNow ?? null)
    // as duas últimas foram BARRADAS pelo portão (null): não chegam a ser falhas avaliadas
    expect(flags).toEqual([false, false, false, false, true, null, null])
  })

  it('a chave da identidade é um hash de tamanho fixo (a identidade vem da URL, controlada pelo atacante)', async () => {
    const store = memoryStore()
    const limiter = createOcppAuthRateLimiter(store, CONFIG)
    await falhar(limiter, { identity: 'x'.repeat(5000), ip: '4.4.4.4' })
    expect(Math.max(...store.keys().map((k) => k.length))).toBeLessThan(100)
  })

  it('tentativa BARRADA não cria nem incrementa chave (o flood não incha o Redis nem estende o bloqueio)', async () => {
    const store = memoryStore()
    const limiter = createOcppAuthRateLimiter(store, { ...CONFIG, maxFailuresPerIp: 2 })
    for (let i = 0; i < 2; i++) await falhar(limiter, { identity: `I${i}`, ip: '5.5.5.5' })
    const before = store.keys().length
    expect((await limiter.reserve({ identity: 'NOVA', ip: '5.5.5.5' })).allowed).toBe(false)
    expect(store.keys().length).toBe(before)
  })
})

describe('reserva ANTES de avaliar (rajada paralela — achado da Íris, 2026-09-19)', () => {
  /** Uma tentativa como o handshake: reserva -> "bcrypt" assíncrono -> falha. Devolve se foi AVALIADA (passou do portão). */
  async function tentativaComBcryptLento(limiter: Limiter, attempt: Attempt): Promise<boolean> {
    const gate = await limiter.reserve(attempt)
    if (!gate.allowed) return false
    await new Promise((r) => setTimeout(r, 20)) // o bcrypt de verdade leva dezenas/centenas de ms: tempo de sobra para o furo antigo aparecer
    await limiter.registerFailure(attempt, gate)
    return true
  }

  it('REGRESSÃO: 40 handshakes paralelos no mesmo par, limite 5 -> EXATAMENTE 5 avaliados e 35 barrados (antes: 40 avaliados, 0 barrados)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const par = { identity: 'CP-RAJADA', ip: '6.6.6.6' }
    const avaliadas = (await Promise.all(Array.from({ length: 40 }, () => tentativaComBcryptLento(limiter, par)))).filter(Boolean).length
    expect(avaliadas).toBe(5)
  })

  it('rajada paralela de identidades DIFERENTES do mesmo IP: o global do IP também vale sob concorrência', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), { ...CONFIG, maxFailuresPerIp: 10 })
    const avaliadas = (await Promise.all(Array.from({ length: 50 }, (_, i) => tentativaComBcryptLento(limiter, { identity: `CP-${i}`, ip: '7.7.7.7' })))).filter(Boolean).length
    expect(avaliadas).toBe(10)
  })

  it('erro NOSSO no meio (release) devolve as DUAS vagas: banco fora do ar não vira lockout do carregador', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const par = { identity: 'CP-1', ip: '8.8.8.8' }
    for (let i = 0; i < 40; i++) {
      expect((await limiter.reserve(par)).allowed).toBe(true)
      await limiter.release(par)
    }
  })

  it('o alerta de bloqueio sai da reserva que FECHOU o limite, e só dela', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const par = { identity: 'CP-1', ip: '10.10.10.10' }
    const gates = []
    for (let i = 0; i < 5; i++) gates.push(await limiter.reserve(par))
    const alertas = await Promise.all(gates.map(async (g) => (g.allowed ? (await limiter.registerFailure(par, g)).identityIpBlockedNow : null)))
    expect(alertas).toEqual([false, false, false, false, true])
  })
})

describe('teto de tentativas EM ANDAMENTO separado do teto de FALHAS do IP (achado da Íris, 2026-09-19: 40 carregadores legítimos atrás de um NAT levavam 429)', () => {
  const COM_TETO = { ...CONFIG, maxConcurrentPerIp: 100 } // as falhas continuam em 30

  /** Um handshake como o real: reserva -> "bcrypt" assíncrono -> sucesso (`ok`) ou falha. Devolve se foi AVALIADO (passou do portão). */
  async function handshakeComBcrypt(limiter: Limiter, attempt: Attempt, ok: boolean): Promise<boolean> {
    const gate = await limiter.reserve(attempt)
    if (!gate.allowed) return false
    await new Promise((r) => setTimeout(r, 20))
    if (ok) await limiter.registerSuccess(attempt)
    else await limiter.registerFailure(attempt, gate)
    return true
  }

  it('REGRESSÃO: 40 carregadores LEGÍTIMOS do mesmo IP em paralelo (limite de falhas 30) entram TODOS e o IP não fica com falha nem chave nenhuma', async () => {
    const store = memoryStore()
    const limiter = createOcppAuthRateLimiter(store, COM_TETO)
    const entraram = await Promise.all(Array.from({ length: 40 }, (_, i) => handshakeComBcrypt(limiter, { identity: `CP-SITE-${i}`, ip: '11.11.11.11' }, true)))
    expect(entraram.every(Boolean)).toBe(true)
    expect(store.keys()).toEqual([]) // o sucesso devolveu a vaga de "em andamento" e zerou o par: nada sobra
  })

  it('o teto de concorrência vale: 150 paralelos com teto 100 -> EXATAMENTE 100 avaliados e 50 barrados no escopo do IP (protege o banco/bcrypt da rajada)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), COM_TETO)
    const gates = await Promise.all(Array.from({ length: 150 }, (_, i) => limiter.reserve({ identity: `CP-${i}`, ip: '12.12.12.12' })))
    expect(gates.filter((g) => g.allowed)).toHaveLength(100)
    for (const g of gates.filter((g) => !g.allowed)) expect(g).toEqual({ allowed: false, scope: 'ip' })
  })

  it('a vaga de "em andamento" volta em TODO desfecho: 500 tentativas em sequência (sucesso, falha e erro nosso) com teto 2 nunca são barradas pela concorrência', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), { ...CONFIG, maxFailuresPerIp: 1_000, maxAttemptsPerIdentityIp: 1_000, maxConcurrentPerIp: 2 })
    for (let i = 0; i < 500; i++) {
      const attempt = { identity: `CP-${i}`, ip: '13.13.13.13' }
      const gate = await limiter.reserve(attempt)
      expect(gate.allowed).toBe(true)
      if (i % 3 === 0) await limiter.registerSuccess(attempt)
      else if (i % 3 === 1 && gate.allowed) await limiter.registerFailure(attempt, gate)
      else await limiter.release(attempt)
    }
  })

  it('as FALHAS continuam bloqueando o IP no limite de falhas (30), mesmo com teto de concorrência alto — só que agora só falha conta', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), COM_TETO)
    const ip = '14.14.14.14'
    for (let i = 0; i < 29; i++) await falhar(limiter, { identity: `FANTASMA-${i}`, ip })
    // 29 falhas + 40 legítimos em paralelo no mesmo IP: ainda entram (não há falha demais, só concorrência)
    const legitimos = await Promise.all(Array.from({ length: 40 }, (_, i) => handshakeComBcrypt(limiter, { identity: `CP-OK-${i}`, ip }, true)))
    expect(legitimos.every(Boolean)).toBe(true)
    expect(await portao(limiter, { identity: 'FANTASMA-29', ip })).toEqual({ allowed: true })
    await falhar(limiter, { identity: 'FANTASMA-29', ip }) // a 30ª falha
    expect(await portao(limiter, { identity: 'CP-QUALQUER', ip })).toEqual({ allowed: false, scope: 'ip' })
  })

  it('CUSTO ACEITO (documentado): uma rajada de tentativas que FALHAM admite até o teto de concorrência antes de o limite de falhas valer — e o IP fica bloqueado depois dela', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), { ...CONFIG, maxFailuresPerIp: 10, maxConcurrentPerIp: 25 })
    const ip = '15.15.15.15'
    const avaliadas = (await Promise.all(Array.from({ length: 60 }, (_, i) => handshakeComBcrypt(limiter, { identity: `CP-${i}`, ip }, false)))).filter(Boolean).length
    expect(avaliadas).toBe(25) // o teto de concorrência, não as 10 falhas
    expect(await portao(limiter, { identity: 'CP-NOVO', ip })).toEqual({ allowed: false, scope: 'ip' }) // 25 falhas >= 10: bloqueado pela janela
  })

  it('o alerta de flood do IP sai da falha que FECHOU o limite de falhas, e só dela (mesmo com rajada de falhas simultâneas)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), { ...CONFIG, maxFailuresPerIp: 5, maxConcurrentPerIp: 20 })
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => falhar(limiter, { identity: `CP-${i}`, ip: '16.16.16.16' })))
    expect(outcomes.filter((o) => o?.ipBlockedNow)).toHaveLength(1)
  })

  it('sem `maxConcurrentPerIp` o teto de concorrência é o de falhas (comportamento rígido anterior)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), { ...CONFIG, maxFailuresPerIp: 10 })
    const gates = await Promise.all(Array.from({ length: 30 }, (_, i) => limiter.reserve({ identity: `CP-${i}`, ip: '17.17.17.17' })))
    expect(gates.filter((g) => g.allowed)).toHaveLength(10)
  })
})

describe('resolveHandshakeIp', () => {
  it('hops=0 (padrão): só o socket — o X-Forwarded-For forjável é IGNORADO', () => {
    expect(resolveHandshakeIp('203.0.113.9', '1.2.3.4, 5.6.7.8', 0)).toBe('203.0.113.9')
  })

  it('hops=1 (um proxy): o último valor do X-Forwarded-For (o que o proxy viu)', () => {
    expect(resolveHandshakeIp('10.0.0.5', '198.51.100.7', 1)).toBe('198.51.100.7')
  })

  it('hops=1 e o cliente tenta forjar (manda XFF próprio; o proxy acrescenta o IP real): vale o IP real, não o forjado', () => {
    expect(resolveHandshakeIp('10.0.0.5', '1.1.1.1, 198.51.100.7', 1)).toBe('198.51.100.7')
  })

  it('hops=2 (dois proxies): o penúltimo valor', () => {
    expect(resolveHandshakeIp('10.0.0.5', '198.51.100.7, 10.0.0.9', 2)).toBe('198.51.100.7')
  })

  it('hops MAIOR que o real deixa o cliente forjar — por isso o default é 0 (documenta o risco)', () => {
    expect(resolveHandshakeIp('10.0.0.5', '1.1.1.1, 198.51.100.7', 2)).toBe('1.1.1.1')
  })

  it('cadeia mais curta que os hops -> o elemento mais à esquerda (o que o proxy mais externo viu)', () => {
    expect(resolveHandshakeIp('10.0.0.5', '198.51.100.7', 5)).toBe('198.51.100.7')
    expect(resolveHandshakeIp('10.0.0.5', undefined, 2)).toBe('10.0.0.5')
  })

  it('normaliza IPv4 mapeado em IPv6 e aceita o header como array', () => {
    expect(resolveHandshakeIp('::ffff:203.0.113.9', undefined, 0)).toBe('203.0.113.9')
    expect(resolveHandshakeIp('10.0.0.5', ['198.51.100.7'], 1)).toBe('198.51.100.7')
  })

  it('sem endereço algum -> "unknown" (nunca lança)', () => {
    expect(resolveHandshakeIp(undefined, undefined, 0)).toBe('unknown')
  })
})

describe('basicAuthSecret do carregador: 16..40 (Órion A1)', () => {
  const base = { siteId: 'cjld2cjxh0000qzrmn831i7rn', ocppIdentity: 'CP-1' }

  it('criação exige 16..40', () => {
    expect(createChargePointSchema.safeParse({ ...base, basicAuthSecret: 'a'.repeat(15) }).success).toBe(false)
    expect(createChargePointSchema.safeParse({ ...base, basicAuthSecret: 'a'.repeat(16) }).success).toBe(true)
    expect(createChargePointSchema.safeParse({ ...base, basicAuthSecret: 'a'.repeat(40) }).success).toBe(true)
    expect(createChargePointSchema.safeParse({ ...base, basicAuthSecret: 'a'.repeat(41) }).success).toBe(false)
  })

  it('edição: opcional, mas se vier segue a mesma regra (não dá para "trocar" por um segredo fraco)', () => {
    expect(updateChargePointSchema.safeParse({}).success).toBe(true)
    expect(updateChargePointSchema.safeParse({ basicAuthSecret: 'curta' }).success).toBe(false)
    expect(updateChargePointSchema.safeParse({ basicAuthSecret: 'a'.repeat(20) }).success).toBe(true)
  })

  it('multibyte acima de 72 bytes é recusado (bcrypt truncaria em silêncio)', () => {
    expect(createChargePointSchema.safeParse({ ...base, basicAuthSecret: 'ç'.repeat(40) }).success).toBe(false) // 80 bytes
  })
})
