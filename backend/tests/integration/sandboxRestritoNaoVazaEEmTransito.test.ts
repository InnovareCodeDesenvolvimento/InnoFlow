import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'

/**
 * QA da Íris (F5.8, rodada Vega-2) — o ALTO-2 (sandbox em `NODE_ENV=production` restrito a testadores) só vale se o bloqueio for CIRÚRGICO:
 * barra COMEÇOS NOVOS de Pix/cartão e NADA além disso. As suítes do Vega provam as 4 entradas barradas, mas deixavam sem teste o outro lado — 4
 * mutantes de "vazamento do bloqueio" sobreviveram:
 *   A5a/A5b  a guarda do cartão estendida também ao começo de sessão com CARTEIRA (o motorista restrito não carregaria nem pagando com saldo!);
 *   A5d      a guarda estendida à CAPTURA do cartão (dinheiro em trânsito: a pré-autorização já feita não pode ficar sem captura);
 *   A5g      a guarda estendida à remoção de cartão (o motorista restrito não conseguiria nem apagar o próprio cartão);
 * e 1 de "guarda a menos" que o desenho promete (defesa em profundidade) e ninguém exercitava: o serviço `iniciarSessaoRemota` chamado direto
 * (A4d). Aqui o motorista NÃO está na lista de testadores (e é isso que o torna "restrito").
 */

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  createRedisConnection: typeof import('../../src/lib/redis').createRedisConnection
  env: Record<string, unknown>
  issueToken: typeof import('../../src/lib/jwt').issueToken
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  resetPaymentSecretsKeyCacheParaTeste: typeof import('../../src/lib/crypto/paymentSecrets').resetPaymentSecretsKeyCacheParaTeste
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  capturarSessaoCartao: typeof import('../../src/services/pagamentos/capturarSessaoCartao').capturarSessaoCartao
  iniciarSessaoRemota: typeof import('../../src/services/sessao/iniciarSessaoRemota').iniciarSessaoRemota
  criarFixtureCartao: typeof import('./helpers/cartaoSessaoFixture').criarFixtureCartao
  createTenant: typeof import('./helpers/fixtures').createTenant
  encryptPaymentSecret: typeof import('../../src/lib/crypto/paymentSecrets').encryptPaymentSecret
}

function dump(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v))
}

describe('ALTO-2 — o bloqueio do sandbox restrito é cirúrgico (carteira, captura em trânsito, remoção de cartão, serviço direto) — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  const envBaseline: Record<string, unknown> = {}
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgv')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, jwtMod, cfgMod, secMod, portMod, capMod, iniMod, fixMod, fxMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/jwt'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('../../src/services/pagamentos/capturarSessaoCartao'),
      import('../../src/services/sessao/iniciarSessaoRemota'),
      import('./helpers/cartaoSessaoFixture'),
      import('./helpers/fixtures'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      createRedisConnection: redisMod.createRedisConnection,
      env: envMod.env as unknown as Record<string, unknown>,
      issueToken: jwtMod.issueToken,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      resetPaymentSecretsKeyCacheParaTeste: secMod.resetPaymentSecretsKeyCacheParaTeste,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      capturarSessaoCartao: capMod.capturarSessaoCartao,
      iniciarSessaoRemota: iniMod.iniciarSessaoRemota,
      criarFixtureCartao: fixMod.criarFixtureCartao,
      createTenant: fxMod.createTenant,
      encryptPaymentSecret: secMod.encryptPaymentSecret,
    }
    app = m.createApp()
    for (const k of ['NODE_ENV', 'CIELO_SANDBOX', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) envBaseline[k] = m.env[k]
  }, 120_000)

  afterAll(async () => {
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.paymentGatewayConfig.deleteMany()
    m.invalidarCacheConfigGateway()
    m.resetPagamentoPortCacheParaTeste()
  })
  afterEach(() => {
    Object.assign(m.env, envBaseline)
    m.invalidarCacheConfigGateway()
    m.resetPaymentSecretsKeyCacheParaTeste()
  })

  async function novoMotorista() {
    contador += 1
    const user = await m.prisma.user.create({ data: { role: 'DRIVER', name: `Motorista ${contador}`, email: `driver-restrito-${contador}-${Math.random().toString(36).slice(2, 7)}@example.com` } })
    return { id: user.id, token: m.issueToken({ id: user.id, role: 'DRIVER', operatorId: null }) }
  }
  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })

  /** Passa o servidor a PRODUÇÃO em sandbox com lista de testadores VAZIA (todo motorista fica restrito) SEM reiniciar o FakeAdapter (ele "sabe" das pré-autorizações). */
  function restringir() {
    m.env.NODE_ENV = 'production'
    m.env.CIELO_SANDBOX = true
    m.env.PAYMENT_ALLOW_FAKE_ADAPTER = true
    m.env.PAYMENT_SANDBOX_TESTER_EMAILS = undefined
    m.invalidarCacheConfigGateway()
  }

  it('A5a/A5b — o motorista RESTRITO inicia sessão com CARTEIRA normalmente (202): o bloqueio é só do cartão/Pix', async () => {
    const tenant = await m.createTenant({ suffix: randomUUID().slice(0, 8), label: 'rst' })
    await m.prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { active: true, lastSeenAt: new Date() } })
    await m.prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
    const motorista = await novoMotorista()
    const carteira = await m.prisma.wallet.create({ data: { userId: motorista.id } })
    await m.prisma.walletEntry.create({ data: { walletId: carteira.id, type: 'TOPUP_PIX', amountCents: 5000, balanceAfterCents: 5000 } })
    restringir()

    // controle: o MESMO motorista leva 409 SANDBOX_RESTRICTED se tentar CARTÃO (prova que ele está mesmo restrito)
    const comCartao = await request(app).post('/api/me/sessions/start').set(auth(motorista)).send({ ocppIdentity: tenant.ocppIdentity, connectorId: 1, payment: { mode: 'CARD', paymentMethodId: 'cabcdefghijklmnopqrstuvwx' } })
    expect(comCartao.status, dump(comCartao.body)).toBe(409)
    expect(comCartao.body.details).toEqual([{ method: 'CARD', reason: 'SANDBOX_RESTRICTED' }])

    // fake gateway OCPP: responde ao RemoteStartTransaction (sem WebSocket)
    const subscriber = m.createRedisConnection()
    const publisher = m.createRedisConnection()
    const canal = `ocpp:cmd:${tenant.chargePointId}`
    await subscriber.subscribe(canal)
    subscriber.on('message', (ch, mensagem) => {
      if (ch !== canal) return
      const p = JSON.parse(mensagem) as { correlationId: string; method: string }
      if (p.method === 'RemoteStartTransaction') publisher.publish(`ocpp:reply:${p.correlationId}`, JSON.stringify({ correlationId: p.correlationId, ok: true, result: { status: 'Accepted' } })).catch(() => {})
    })
    try {
      const comCarteira = await request(app).post('/api/me/sessions/start').set(auth(motorista)).send({ ocppIdentity: tenant.ocppIdentity, connectorId: 1 })
      expect(comCarteira.status, dump(comCarteira.body)).toBe(202)
      expect(comCarteira.body.code).not.toBe('PAYMENT_METHOD_DISABLED')
    } finally {
      subscriber.disconnect()
      publisher.disconnect()
    }
  })

  it('A5d — a CAPTURA de uma pré-autorização JÁ FEITA segue funcionando para o motorista restrito (dinheiro em trânsito não é "começo novo")', async () => {
    // a pré-autorização nasce ANTES da restrição (NODE_ENV=test), a sessão para (CAPTURE_PENDING) e só então o servidor vira "produção em sandbox"
    const fx = await m.criarFixtureCartao(app, randomUUID().slice(0, 8), 'rcap')
    const { intent } = await fx.sessaoParada('cap')
    expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CAPTURE_PENDING')
    restringir()

    const resultado = await m.capturarSessaoCartao(intent.id)
    expect(resultado, 'a captura NÃO pode ser barrada pela restrição de sandbox').not.toBeNull()
    expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CAPTURED')
  })

  it('A5g — o motorista restrito ainda LISTA, marca como padrão e REMOVE os próprios cartões (gerir o que já existe não é "começo novo")', async () => {
    const motorista = await novoMotorista()
    const cartao = async (isDefault: boolean) => m.prisma.paymentMethod.create({ data: { userId: motorista.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.encryptPaymentSecret(`tok-${randomUUID()}`), brand: 'Visa', last4: '4242', environment: 'SANDBOX', isDefault } })
    const a = await cartao(true)
    const b = await cartao(false)
    restringir()

    const lista = await request(app).get('/api/me/payment-methods').set(auth(motorista))
    expect(lista.status, dump(lista.body)).toBe(200)
    expect(lista.body.items).toHaveLength(2)

    const padrao = await request(app).patch(`/api/me/payment-methods/${b.id}`).set(auth(motorista)).send({ isDefault: true })
    expect(padrao.status, dump(padrao.body)).toBe(200)

    const remover = await request(app).delete(`/api/me/payment-methods/${a.id}`).set(auth(motorista))
    expect(remover.status, dump(remover.body)).toBeLessThan(300)
    expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: a.id } })).active).toBe(false)
  })

  it('A4d — o SERVIÇO iniciarSessaoRemota chamado direto com CARTÃO também barra o motorista restrito (defesa em profundidade: um 2º chamador futuro não herda a rota)', async () => {
    const motorista = await novoMotorista()
    restringir()
    await expect(
      m.iniciarSessaoRemota({ chargePointId: 'cp-inexistente', chargePointScope: {}, connectorId: 1, userId: motorista.id, payment: { mode: 'CARD', paymentMethodId: 'cabcdefghijklmnopqrstuvwx' } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_METHOD_DISABLED', details: [{ method: 'CARD', reason: 'SANDBOX_RESTRICTED' }] })
  })
})
