import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { JWT_SECRET_TROCADO } from './helpers/chaveMestra'

/**
 * MUDANÇA DELIBERADA (05/10/2026, chave dos segredos DERIVADA do JWT_SECRET, como no InnoChat) — consequência ESPECÍFICA do InnoFlow, que o InnoChat não tem: os CARTÕES SALVOS dos motoristas guardam o
 * token Cielo cifrado com essa chave. Trocar o JWT_SECRET os torna ilegíveis. Pela rota real:
 *  - o cartão ilegível aparece na lista com `unreadable: true` (a tela pede "cadastre o cartão novamente");
 *  - iniciar sessão com ele => 409 PAYMENT_METHOD_UNREADABLE ANTES de criar PaymentIntent e de chamar o gateway (nada pendurado, nenhum 500/503, nenhum RemoteStart);
 *  - um cartão recadastrado depois da troca funciona; voltar ao JWT_SECRET antigo traz o cartão antigo de volta (nada foi destruído);
 *  - pré-autorização JÁ existente (CAPTURE_PENDING) segue capturável: a captura usa o id do pagamento na Cielo, não o token do cartão.
 * Postgres + Redis reais, banco próprio.
 */

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  createRedisConnection: typeof import('../../src/lib/redis').createRedisConnection
  env: Record<string, unknown>
  issueToken: typeof import('../../src/lib/jwt').issueToken
  encryptPaymentSecret: typeof import('../../src/lib/crypto/paymentSecrets').encryptPaymentSecret
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  getPagamentoPort: typeof import('../../src/services/pagamentos/pagamentoPortInstance').getPagamentoPort
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  capturarSessaoCartao: typeof import('../../src/services/pagamentos/capturarSessaoCartao').capturarSessaoCartao
  fx: typeof import('./helpers/fixtures')
  cartaoFx: typeof import('./helpers/cartaoSessaoFixture')
}

describe('cartão salvo ilegível depois de trocar o JWT_SECRET — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let tenant: Awaited<ReturnType<Mods['fx']['createTenant']>>
  let fake: { autorizar: (...a: unknown[]) => Promise<unknown> }
  const envBaseline: Record<string, unknown> = {}
  let n = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pcl')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, jwtMod, secMod, cfgMod, portMod, capMod, fx, cartaoFx] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/jwt'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('../../src/services/pagamentos/capturarSessaoCartao'),
      import('./helpers/fixtures'),
      import('./helpers/cartaoSessaoFixture'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      createRedisConnection: redisMod.createRedisConnection,
      env: envMod.env as unknown as Record<string, unknown>,
      issueToken: jwtMod.issueToken,
      encryptPaymentSecret: secMod.encryptPaymentSecret,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      getPagamentoPort: portMod.getPagamentoPort,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      capturarSessaoCartao: capMod.capturarSessaoCartao,
      fx,
      cartaoFx,
    }
    for (const k of ['NODE_ENV', 'CIELO_SANDBOX', 'PAYMENT_ALLOW_FAKE_ADAPTER', 'JWT_SECRET']) envBaseline[k] = m.env[k]
    app = m.createApp()
    m.resetPagamentoPortCacheParaTeste()
    fake = (await m.getPagamentoPort()) as unknown as typeof fake
    const suffix = fx.uniqueSuffix()
    tenant = await fx.createTenant({ suffix, label: 'pcl' })
    await m.prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { active: true, lastSeenAt: new Date() } })
    await m.prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.paymentGatewayConfig.deleteMany()
    await m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: 'sandbox', cardEnabled: true, pixEnabled: true } })
    m.env.NODE_ENV = 'test'
    m.env.CIELO_SANDBOX = true
    m.env.PAYMENT_ALLOW_FAKE_ADAPTER = true
    m.invalidarCacheConfigGateway()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    Object.assign(m.env, envBaseline)
    m.invalidarCacheConfigGateway()
  })

  async function motoristaComCartao() {
    n += 1
    const user = await m.prisma.user.create({ data: { role: 'DRIVER', name: `Motorista PCL ${n}`, email: `driver-pcl-${n}-${Math.random().toString(36).slice(2, 7)}@example.com` } })
    const cartao = await m.prisma.paymentMethod.create({ data: { userId: user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.encryptPaymentSecret(`tok-pcl-${n}`), brand: 'Visa', last4: '4242', isDefault: true, environment: 'SANDBOX' } })
    const conector = await m.prisma.connector.create({ data: { operatorId: tenant.operatorId, chargePointId: tenant.chargePointId, connectorId: 300 + n, type: 'AC_TYPE2', status: 'AVAILABLE' } })
    return { user, cartao, conector, token: m.issueToken({ id: user.id, role: 'DRIVER', operatorId: null }) }
  }
  type Motorista = Awaited<ReturnType<typeof motoristaComCartao>>

  /** O dono troca o JWT_SECRET: a sessão do motorista cai (token antigo => 401) e ele loga de novo (token novo). */
  function trocarJwtSecretERelogar(d: Motorista) {
    const tokenAntigo = d.token
    m.env.JWT_SECRET = JWT_SECRET_TROCADO
    d.token = m.issueToken({ id: d.user.id, role: 'DRIVER', operatorId: null })
    return tokenAntigo
  }

  async function comGatewayOcppFalso<T>(fn: () => Promise<T>): Promise<{ resultado: T; remoteStarts: number }> {
    const subscriber = m.createRedisConnection()
    const publisher = m.createRedisConnection()
    const canal = `ocpp:cmd:${tenant.chargePointId}`
    let remoteStarts = 0
    await subscriber.subscribe(canal)
    subscriber.on('message', (ch, message) => {
      if (ch !== canal) return
      try {
        const payload = JSON.parse(message) as { correlationId: string; method: string }
        if (payload.method !== 'RemoteStartTransaction') return
        remoteStarts += 1
        publisher.publish(`ocpp:reply:${payload.correlationId}`, JSON.stringify({ correlationId: payload.correlationId, ok: true, result: { status: 'Accepted' } })).catch(() => {})
      } catch {
        // ignora
      }
    })
    try {
      const resultado = await fn()
      await new Promise((r) => setTimeout(r, 300))
      return { resultado, remoteStarts }
    } finally {
      subscriber.disconnect()
      publisher.disconnect()
    }
  }
  const iniciar = (d: Motorista, cartaoId: string = d.cartao.id) =>
    request(app).post('/api/me/sessions/start').set('Authorization', `Bearer ${d.token}`).send({ ocppIdentity: tenant.ocppIdentity, connectorId: d.conector.connectorId, payment: { mode: 'CARD', paymentMethodId: cartaoId } })
  const listar = (d: Motorista) => request(app).get('/api/me/payment-methods').set('Authorization', `Bearer ${d.token}`)

  it('CONTROLE: com o JWT_SECRET de sempre o cartão é legível (unreadable=false) e a sessão inicia (202, gateway chamado uma vez)', async () => {
    const d = await motoristaComCartao()
    const lista = await listar(d)
    expect(lista.status).toBe(200)
    expect(lista.body.items[0]).toMatchObject({ id: d.cartao.id, unreadable: false })
    const autorizar = vi.spyOn(fake, 'autorizar')
    const { resultado } = await comGatewayOcppFalso(() => iniciar(d))
    expect(resultado.status, JSON.stringify(resultado.body)).toBe(202)
    expect(autorizar).toHaveBeenCalledTimes(1)
  })

  it('JWT_SECRET trocado: o cartão salvo vira unreadable=true na lista; iniciar sessão => 409 PAYMENT_METHOD_UNREADABLE, SEM intent, SEM chamada ao gateway, SEM RemoteStart, sem 5xx', async () => {
    const d = await motoristaComCartao()
    const tokenAntigo = trocarJwtSecretERelogar(d)
    expect((await request(app).get('/api/me/payment-methods').set('Authorization', `Bearer ${tokenAntigo}`)).status).toBe(401) // trocar o JWT_SECRET derruba as sessões

    const lista = await listar(d)
    expect(lista.status).toBe(200)
    expect(lista.body.items).toHaveLength(1)
    expect(lista.body.items[0]).toMatchObject({ id: d.cartao.id, unreadable: true })
    expect(JSON.stringify(lista.body)).not.toContain('Ciphertext')

    const autorizar = vi.spyOn(fake, 'autorizar')
    const { resultado, remoteStarts } = await comGatewayOcppFalso(() => iniciar(d))
    expect(resultado.status, JSON.stringify(resultado.body)).toBe(409)
    expect(resultado.body.code).toBe('PAYMENT_METHOD_UNREADABLE')
    expect(String(resultado.body.error ?? resultado.body.message)).toMatch(/cadastrad/i)
    expect(autorizar).not.toHaveBeenCalled()
    expect(remoteStarts).toBe(0)
    expect(await m.prisma.paymentIntent.count({ where: { userId: d.user.id } })).toBe(0) // nada pendurado para o varredor
    // o cartão NÃO foi apagado nem desativado: voltar ao JWT_SECRET antigo o traz de volta
    expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: d.cartao.id } })).active).toBe(true)
  })

  it('cartão recadastrado DEPOIS da troca funciona (202); voltar ao JWT_SECRET antigo faz o cartão antigo voltar a valer', async () => {
    const d = await motoristaComCartao()
    trocarJwtSecretERelogar(d)
    const novo = await m.prisma.paymentMethod.create({ data: { userId: d.user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.encryptPaymentSecret('tok-pcl-novo'), brand: 'Visa', last4: '1111', isDefault: false, environment: 'SANDBOX' } })
    const { resultado } = await comGatewayOcppFalso(() => iniciar(d, novo.id))
    expect(resultado.status, JSON.stringify(resultado.body)).toBe(202)

    m.env.JWT_SECRET = envBaseline.JWT_SECRET
    d.token = m.issueToken({ id: d.user.id, role: 'DRIVER', operatorId: null })
    const lista = await listar(d)
    expect(lista.body.items.find((i: { id: string }) => i.id === d.cartao.id)).toMatchObject({ unreadable: false })
  })

  it('pré-autorização JÁ existente (CAPTURE_PENDING) segue capturável com o JWT_SECRET trocado: a captura não usa o token do cartão (nada fica preso)', async () => {
    const fx = await m.cartaoFx.criarFixtureCartao(app, randomUUID().slice(0, 8), 'pcl')
    const { intent } = await fx.sessaoParada('cap')
    expect(await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'CAPTURE_PENDING' })
    m.env.JWT_SECRET = JWT_SECRET_TROCADO
    m.invalidarCacheConfigGateway()
    const resultado = await m.capturarSessaoCartao(intent.id, fake as never)
    expect(resultado).toMatchObject({ status: 'CAPTURED' })
    expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CAPTURED')
  })
})
