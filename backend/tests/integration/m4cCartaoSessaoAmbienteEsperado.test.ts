import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'

/**
 * QA da Íris (F5.8, rodada Vega-4) — `ambienteEsperado` de `iniciarSessaoRemota` (cartão), PELA ROTA REAL `POST /api/me/sessions/start`. A rodada anterior da Íris provou a recusa só chamando
 * `criarPaymentIntentNoAmbienteEfetivo` direto; o MUTANTE "iniciarSessaoRemota deixa de passar `ambienteEsperado`" SOBREVIVEU (nenhum teste cobria a ligação). Aqui:
 *
 * o cartão é escolhido no ambiente que o CACHE do processo diz (SANDBOX, aquecido) e, antes do INSERT do intent, a config do banco já virou PRODUCTION — exatamente o que um outro
 * processo da API (ou um PUT no meio) causa dentro da janela de 10 s do cache. Sem `ambienteEsperado` o intent seria gravado como PRODUCTION para um cartão tokenizado em SANDBOX e a
 * pré-autorização iria à Cielo de produção com um token de sandbox. Esperado: 503 PAYMENT_GATEWAY_UNAVAILABLE, NENHUM intent, NENHUMA chamada ao gateway, sem RemoteStart.
 * CONTROLE: sem troca, a mesma sessão dá 202 e o intent nasce SANDBOX com o `autorizar` chamado uma vez.
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
  getAmbienteEfetivoParaBanco: typeof import('../../src/services/pagamentos/gatewayConfig').getAmbienteEfetivoParaBanco
  getPagamentoPort: typeof import('../../src/services/pagamentos/pagamentoPortInstance').getPagamentoPort
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  fx: typeof import('./helpers/fixtures')
}

describe('M4c — sessão com cartão: o ambiente esperado (cartão escolhido) é conferido sob o lock, pela rota real — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let tenant: Awaited<ReturnType<Mods['fx']['createTenant']>>
  let fake: { autorizar: (...a: unknown[]) => Promise<unknown> }
  const envBaseline: Record<string, unknown> = {}
  let n = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgs')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, jwtMod, secMod, cfgMod, portMod, fx] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/jwt'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('./helpers/fixtures'),
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
      getAmbienteEfetivoParaBanco: cfgMod.getAmbienteEfetivoParaBanco,
      getPagamentoPort: portMod.getPagamentoPort,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      fx,
    }
    for (const k of ['NODE_ENV', 'CIELO_SANDBOX', 'PAYMENT_ALLOW_FAKE_ADAPTER']) envBaseline[k] = m.env[k]
    app = m.createApp()
    m.resetPagamentoPortCacheParaTeste()
    fake = (await m.getPagamentoPort()) as unknown as typeof fake
    const suffix = fx.uniqueSuffix()
    tenant = await fx.createTenant({ suffix, label: 'm4cs' })
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

  async function motoristaComCartaoSandbox() {
    n += 1
    const user = await m.prisma.user.create({ data: { role: 'DRIVER', name: `Motorista M4c ${n}`, email: `driver-m4cs-${n}-${Math.random().toString(36).slice(2, 7)}@example.com` } })
    const cartao = await m.prisma.paymentMethod.create({ data: { userId: user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.encryptPaymentSecret(`tok-m4cs-${n}`), brand: 'Visa', last4: '4242', isDefault: true, environment: 'SANDBOX' } })
    const conector = await m.prisma.connector.create({ data: { operatorId: tenant.operatorId, chargePointId: tenant.chargePointId, connectorId: 200 + n, type: 'AC_TYPE2', status: 'AVAILABLE' } })
    return { user, cartao, conector, token: m.issueToken({ id: user.id, role: 'DRIVER', operatorId: null }) }
  }

  /** Responde ao RemoteStartTransaction publicado (sem WebSocket OCPP de verdade) e conta quantos chegaram. */
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
  const iniciar = (d: Awaited<ReturnType<typeof motoristaComCartaoSandbox>>) =>
    request(app).post('/api/me/sessions/start').set('Authorization', `Bearer ${d.token}`).send({ ocppIdentity: tenant.ocppIdentity, connectorId: d.conector.connectorId, payment: { mode: 'CARD', paymentMethodId: d.cartao.id } })

  it('CONTROLE: sem troca de ambiente, a sessão com cartão SANDBOX dá 202, o intent nasce SANDBOX e o gateway é chamado uma vez', async () => {
    const d = await motoristaComCartaoSandbox()
    expect(await m.getAmbienteEfetivoParaBanco()).toBe('SANDBOX')
    const autorizar = vi.spyOn(fake, 'autorizar')
    const { resultado } = await comGatewayOcppFalso(() => iniciar(d))
    expect(resultado.status, JSON.stringify(resultado.body)).toBe(202)
    const intent = await m.prisma.paymentIntent.findFirstOrThrow({ where: { userId: d.user.id } })
    expect(intent.environment).toBe('SANDBOX')
    expect(autorizar).toHaveBeenCalledTimes(1)
  }, 60_000)

  it('o ambiente do banco virou PRODUCTION depois de o cartão (SANDBOX) ser escolhido pelo cache: 503, NENHUM intent, o gateway NÃO é chamado e nenhum RemoteStart sai', async () => {
    const d = await motoristaComCartaoSandbox()
    expect(await m.getAmbienteEfetivoParaBanco()).toBe('SANDBOX') // cache quente em SANDBOX: o que a rota lê antes de escolher o cartão
    // outro processo (ou o PUT) comita a troca; ESTE processo ainda tem o cache velho (TTL de 10 s) — nada de invalidarCacheConfigGateway()
    await m.prisma.$executeRaw`UPDATE "PaymentGatewayConfig" SET "environment" = 'production' WHERE "id" = 1`
    const autorizar = vi.spyOn(fake, 'autorizar')
    const { resultado, remoteStarts } = await comGatewayOcppFalso(() => iniciar(d))
    expect(resultado.status, JSON.stringify(resultado.body)).toBe(503)
    expect(resultado.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
    expect(await m.prisma.paymentIntent.count({ where: { userId: d.user.id } })).toBe(0)
    expect(autorizar).not.toHaveBeenCalled()
    expect(remoteStarts).toBe(0)
    expect((await m.prisma.connector.findUniqueOrThrow({ where: { id: d.conector.id } })).status, 'o conector não pode ser reservado/ocupado por uma sessão recusada').toBe('AVAILABLE')
  }, 60_000)
})
