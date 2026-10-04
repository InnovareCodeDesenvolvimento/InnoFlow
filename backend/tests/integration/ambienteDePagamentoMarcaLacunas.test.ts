import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'

/**
 * QA da Íris (F5.8, rodada Vega-2) — 3 mutantes do M4 (marca de ambiente dos cartões) que SOBREVIVERAM às suítes do Vega, mortos aqui:
 *   C3c  a conferência do teto de 5 cartões DENTRO da transação foi removida (só a "checagem rápida" antes da Cielo ficou) — ninguém exercitava a 2ª
 *        conferência, que é a que fecha a janela em que outro cadastro entra durante a verificação do token na Cielo;
 *   C4b  PATCH (marcar padrão) zerando o padrão de TODOS os ambientes — o teste do Vega só olhava o POST;
 *   C4c  a promoção do "próximo padrão" ao remover o cartão padrão ignorando o ambiente — o mais novo de OUTRO ambiente viraria padrão aqui (e o ambiente
 *        de origem ficaria com dois padrões).
 */

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  issueToken: typeof import('../../src/lib/jwt').issueToken
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  getPagamentoPort: typeof import('../../src/services/pagamentos/pagamentoPortInstance').getPagamentoPort
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  FakeAdapter: typeof import('../../src/services/pagamentos/fakeAdapter').FakeAdapter
  encryptPaymentSecret: typeof import('../../src/lib/crypto/paymentSecrets').encryptPaymentSecret
}

type Amb = 'SANDBOX' | 'PRODUCTION'

describe('M4 — lacunas dos cartões por ambiente (teto transacional, padrão no PATCH, promoção no DELETE) — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let fake: InstanceType<Mods['FakeAdapter']>
  const envBaseline: Record<string, unknown> = {}
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgm')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, jwtMod, cfgMod, portMod, fakeMod, secMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/jwt'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('../../src/services/pagamentos/fakeAdapter'),
      import('../../src/lib/crypto/paymentSecrets'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      env: envMod.env as unknown as Record<string, unknown>,
      issueToken: jwtMod.issueToken,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      getPagamentoPort: portMod.getPagamentoPort,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      FakeAdapter: fakeMod.FakeAdapter,
      encryptPaymentSecret: secMod.encryptPaymentSecret,
    }
    app = m.createApp()
    for (const k of ['NODE_ENV', 'CIELO_SANDBOX']) envBaseline[k] = m.env[k]
    m.resetPagamentoPortCacheParaTeste()
    fake = (await m.getPagamentoPort()) as InstanceType<Mods['FakeAdapter']>
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.paymentGatewayConfig.deleteMany()
    efetivo('SANDBOX')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    Object.assign(m.env, envBaseline)
    m.invalidarCacheConfigGateway()
  })

  function efetivo(amb: Amb) {
    m.env.CIELO_SANDBOX = amb === 'SANDBOX'
    m.invalidarCacheConfigGateway()
  }
  async function novoMotorista() {
    contador += 1
    const user = await m.prisma.user.create({ data: { role: 'DRIVER', name: `Motorista ${contador}`, email: `driver-m4l-${contador}-${Math.random().toString(36).slice(2, 7)}@example.com` } })
    return { id: user.id, token: m.issueToken({ id: user.id, role: 'DRIVER', operatorId: null }) }
  }
  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })
  async function cartao(userId: string, environment: Amb, opcoes: { isDefault?: boolean; criadoHa?: number } = {}) {
    return m.prisma.paymentMethod.create({
      data: {
        userId,
        type: 'CREDIT_CARD',
        cieloCardTokenCiphertext: m.encryptPaymentSecret(`tok-${randomUUID()}`),
        brand: 'Visa',
        last4: '4242',
        environment,
        isDefault: opcoes.isDefault ?? false,
        createdAt: new Date(Date.now() - (opcoes.criadoHa ?? 0)),
      },
    })
  }
  const padraoPorAmbiente = async (userId: string) => {
    const linhas = await m.prisma.paymentMethod.findMany({ where: { userId, active: true, isDefault: true } })
    return { SANDBOX: linhas.filter((l) => l.environment === 'SANDBOX').map((l) => l.id), PRODUCTION: linhas.filter((l) => l.environment === 'PRODUCTION').map((l) => l.id) }
  }

  it('C3c — outro cadastro entra DURANTE a verificação do token na Cielo e completa o teto: a conferência DENTRO da transação barra o 6º (409 TOO_MANY_PAYMENT_METHODS) e nada é gravado', async () => {
    const u = await novoMotorista()
    for (let i = 0; i < 4; i += 1) await cartao(u.id, 'SANDBOX', { isDefault: i === 0 })
    vi.spyOn(fake, 'consultarCartaoTokenizado').mockImplementation(async (cardToken: string) => {
      await cartao(u.id, 'SANDBOX') // a "outra aba" cadastrou o 5º enquanto esta requisição falava com a Cielo (a checagem rápida já tinha visto 4)
      return { cardToken, brand: 'Visa', last4: '4242', holderName: 'TESTE', expiryMonth: 12, expiryYear: 2030 }
    })
    const res = await request(app).post('/api/me/payment-methods').set(auth(u)).send({ cardToken: `${randomUUID()}`, brand: 'Visa' })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.code).toBe('TOO_MANY_PAYMENT_METHODS')
    expect(await m.prisma.paymentMethod.count({ where: { userId: u.id, active: true, environment: 'SANDBOX' } })).toBe(5) // nunca 6
  })

  it('C4b — PATCH (marcar como padrão) em PRODUCTION NÃO tira o padrão do SANDBOX: continua um padrão por ambiente', async () => {
    const u = await novoMotorista()
    const s1 = await cartao(u.id, 'SANDBOX', { isDefault: true })
    const p1 = await cartao(u.id, 'PRODUCTION', { isDefault: true })
    const p2 = await cartao(u.id, 'PRODUCTION')
    efetivo('PRODUCTION')
    const res = await request(app).patch(`/api/me/payment-methods/${p2.id}`).set(auth(u)).send({ isDefault: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await padraoPorAmbiente(u.id)).toEqual({ SANDBOX: [s1.id], PRODUCTION: [p2.id] })
    void p1
  })

  it('C4c — remover o cartão padrão de PRODUCTION promove o mais novo DE PRODUCTION (não o mais novo de qualquer ambiente); o SANDBOX segue com o seu único padrão', async () => {
    const u = await novoMotorista()
    const s1 = await cartao(u.id, 'SANDBOX', { isDefault: true, criadoHa: 10_000 })
    const p1 = await cartao(u.id, 'PRODUCTION', { isDefault: true, criadoHa: 9_000 })
    const p2 = await cartao(u.id, 'PRODUCTION', { criadoHa: 8_000 })
    await cartao(u.id, 'SANDBOX', { criadoHa: 1_000 }) // s2: o mais NOVO de todos, mas de outro ambiente
    efetivo('PRODUCTION')
    const res = await request(app).delete(`/api/me/payment-methods/${p1.id}`).set(auth(u))
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
    expect(await padraoPorAmbiente(u.id)).toEqual({ SANDBOX: [s1.id], PRODUCTION: [p2.id] })
  })
})
