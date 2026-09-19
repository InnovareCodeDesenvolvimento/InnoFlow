import { describe, expect, it } from 'vitest'
import { createOcppAuthRateLimiter, type AuthCounterStore } from '../../src/core/ocpp/authRateLimiter'
import { resolveHandshakeIp } from '../../src/core/ocpp/clientIp'
import { createChargePointSchema, updateChargePointSchema } from '../../src/api/schemas/chargePoint.schema'

/** Store em memória (sem TTL — os testes não avançam a janela). */
function memoryStore(): AuthCounterStore & { keys(): string[] } {
  const data = new Map<string, number>()
  return {
    async getMany(keys) {
      return keys.map((k) => data.get(k) ?? 0)
    },
    async incrWithTtl(key) {
      const next = (data.get(key) ?? 0) + 1
      data.set(key, next)
      return next
    },
    async del(keys) {
      for (const k of keys) data.delete(k)
    },
    keys: () => [...data.keys()],
  }
}

const CONFIG = { maxAttemptsPerIdentityIp: 5, maxFailuresPerIp: 30, windowSeconds: 300 }

describe('createOcppAuthRateLimiter (Órion A1)', () => {
  it('REGRESSÃO do lockout: o atacante que erra 5 vezes a identidade PÚBLICA trava só o SEU par — o carregador real (outro IP) segue autenticando', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const atacante = { identity: 'CP-REAL-001', ip: '203.0.113.9' }
    const carregadorReal = { identity: 'CP-REAL-001', ip: '198.51.100.7' }

    for (let i = 0; i < 5; i++) await limiter.registerFailure(atacante)

    expect(await limiter.check(atacante)).toEqual({ allowed: false, scope: 'identity_ip' })
    expect(await limiter.check(carregadorReal)).toEqual({ allowed: true }) // o buraco: antes era 429 também
  })

  it('abaixo do limite do par continua permitido', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    for (let i = 0; i < 4; i++) await limiter.registerFailure({ identity: 'CP-1', ip: '1.1.1.1' })
    expect(await limiter.check({ identity: 'CP-1', ip: '1.1.1.1' })).toEqual({ allowed: true })
  })

  it('sucesso ZERA o contador do par (falhas antigas do carregador real não acumulam até bloquear)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const par = { identity: 'CP-1', ip: '1.1.1.1' }
    for (let i = 0; i < 4; i++) await limiter.registerFailure(par)
    await limiter.clearFailures(par)
    for (let i = 0; i < 4; i++) await limiter.registerFailure(par) // 4 de novo: sem o clear seriam 8
    expect(await limiter.check(par)).toEqual({ allowed: true })
  })

  it('sucesso NÃO zera o contador global do IP (senão um IP intercalaria sucesso e falha para nunca estourar)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), { ...CONFIG, maxFailuresPerIp: 6 })
    const ip = '9.9.9.9'
    for (let i = 0; i < 3; i++) await limiter.registerFailure({ identity: 'CP-A', ip })
    await limiter.clearFailures({ identity: 'CP-A', ip })
    for (let i = 0; i < 3; i++) await limiter.registerFailure({ identity: 'CP-B', ip })
    expect(await limiter.check({ identity: 'CP-C', ip })).toEqual({ allowed: false, scope: 'ip' })
  })

  it('FLOOD de identidades inexistentes do MESMO IP estoura o limite global (cada identidade nova teria o próprio par zerado)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const ip = '203.0.113.50'
    for (let i = 0; i < 30; i++) await limiter.registerFailure({ identity: `INEXISTENTE-${i}`, ip })

    expect(await limiter.check({ identity: 'INEXISTENTE-999', ip })).toEqual({ allowed: false, scope: 'ip' })
    expect(await limiter.check({ identity: 'CP-REAL-001', ip: '198.51.100.7' })).toEqual({ allowed: true }) // outro IP não é afetado
  })

  it('o bloqueio global do IP tem precedência sobre o do par (é ele que protege o banco)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), { ...CONFIG, maxFailuresPerIp: 5 })
    for (let i = 0; i < 5; i++) await limiter.registerFailure({ identity: 'CP-1', ip: '2.2.2.2' })
    expect(await limiter.check({ identity: 'CP-1', ip: '2.2.2.2' })).toEqual({ allowed: false, scope: 'ip' })
  })

  it('registerFailure sinaliza o instante EXATO em que o bloqueio ativa (para alertar uma vez, sem spam)', async () => {
    const limiter = createOcppAuthRateLimiter(memoryStore(), CONFIG)
    const par = { identity: 'CP-1', ip: '3.3.3.3' }
    const flags: boolean[] = []
    for (let i = 0; i < 7; i++) flags.push((await limiter.registerFailure(par)).identityIpBlockedNow)
    expect(flags).toEqual([false, false, false, false, true, false, false])
  })

  it('a chave da identidade é um hash de tamanho fixo (a identidade vem da URL, controlada pelo atacante)', async () => {
    const store = memoryStore()
    const limiter = createOcppAuthRateLimiter(store, CONFIG)
    await limiter.registerFailure({ identity: 'x'.repeat(5000), ip: '4.4.4.4' })
    expect(Math.max(...store.keys().map((k) => k.length))).toBeLessThan(100)
  })

  it('check não escreve (tentativa BLOQUEADA não cria chave nova — o flood não incha o Redis)', async () => {
    const store = memoryStore()
    const limiter = createOcppAuthRateLimiter(store, { ...CONFIG, maxFailuresPerIp: 2 })
    for (let i = 0; i < 2; i++) await limiter.registerFailure({ identity: `I${i}`, ip: '5.5.5.5' })
    const before = store.keys().length
    await limiter.check({ identity: 'NOVA', ip: '5.5.5.5' })
    expect(store.keys().length).toBe(before)
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
