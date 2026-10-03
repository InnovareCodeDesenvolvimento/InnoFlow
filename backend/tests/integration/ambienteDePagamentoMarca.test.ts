import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * F5.7 — M4 (marca de ambiente SANDBOX/PRODUCTION em uso) contra Postgres + Redis REAIS, banco próprio (a troca de ambiente grava o singleton
 * `PaymentGatewayConfig`). A Cielo nunca é chamada: o `FakeAdapter` faz o papel dela e as chamadas são ESPIADAS.
 *  (a) todo PaymentIntent/PaymentMethod NOVO nasce com o ambiente efetivo EXPLÍCITO (a coluna tem DEFAULT SANDBOX — provar em PRODUCTION é o que
 *      mostra que ninguém depende do default);
 *  (b) listagem/uso/teto de cartões só do ambiente efetivo; padrão resolvido por (userId, ambiente);
 *  (c) trocar o ambiente com intent VIVO => 409 GATEWAY_HAS_INFLIGHT_PAYMENTS {count};
 *  (d) intent de OUTRO ambiente nunca é consultado/capturado/cancelado/creditado (nem expirado/FAILED por isso).
 */

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  createRedisConnection: typeof import('../../src/lib/redis').createRedisConnection
  env: Record<string, unknown>
  logger: typeof import('../../src/lib/logger').logger
  issueToken: typeof import('../../src/lib/jwt').issueToken
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  getPagamentoPort: typeof import('../../src/services/pagamentos/pagamentoPortInstance').getPagamentoPort
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  resetLogsDeAmbienteDivergenteParaTeste: typeof import('../../src/services/pagamentos/ambienteDoIntent').resetLogsDeAmbienteDivergenteParaTeste
  AmbienteDoIntentDivergenteError: typeof import('../../src/services/pagamentos/ambienteDoIntent').AmbienteDoIntentDivergenteError
  creditarTopupPix: typeof import('../../src/services/pagamentos/creditarTopupPix').creditarTopupPix
  varrerTopupsPixExpirados: typeof import('../../src/services/pagamentos/varrerTopupsPixExpirados').varrerTopupsPixExpirados
  varrerPreAutorizacoesCartao: typeof import('../../src/services/pagamentos/varrerPreAutorizacoesCartao').varrerPreAutorizacoesCartao
  cancelarPreAutorizacaoCartao: typeof import('../../src/services/pagamentos/cancelarPreAutorizacaoCartao').cancelarPreAutorizacaoCartao
  capturarSessaoCartao: typeof import('../../src/services/pagamentos/capturarSessaoCartao').capturarSessaoCartao
  FakeAdapter: typeof import('../../src/services/pagamentos/fakeAdapter').FakeAdapter
  criarFixtureCartao: typeof import('./helpers/cartaoSessaoFixture').criarFixtureCartao
  encryptPaymentSecret: typeof import('../../src/lib/crypto/paymentSecrets').encryptPaymentSecret
}

type Amb = 'SANDBOX' | 'PRODUCTION'

function dump(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v))
}

describe('marca de ambiente de pagamento (M4) — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let fake: InstanceType<Mods['FakeAdapter']>
  const envBaseline: Record<string, unknown> = {}
  const logsErro: Array<Record<string, unknown>> = []
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pga')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, loggerMod, jwtMod, cfgMod, portMod, ambMod, credMod, varrMod, preMod, cancMod, capMod, fakeMod, fixMod, secMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/logger'),
      import('../../src/lib/jwt'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('../../src/services/pagamentos/ambienteDoIntent'),
      import('../../src/services/pagamentos/creditarTopupPix'),
      import('../../src/services/pagamentos/varrerTopupsPixExpirados'),
      import('../../src/services/pagamentos/varrerPreAutorizacoesCartao'),
      import('../../src/services/pagamentos/cancelarPreAutorizacaoCartao'),
      import('../../src/services/pagamentos/capturarSessaoCartao'),
      import('../../src/services/pagamentos/fakeAdapter'),
      import('./helpers/cartaoSessaoFixture'),
      import('../../src/lib/crypto/paymentSecrets'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      createRedisConnection: redisMod.createRedisConnection,
      env: envMod.env as unknown as Record<string, unknown>,
      logger: loggerMod.logger,
      issueToken: jwtMod.issueToken,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      getPagamentoPort: portMod.getPagamentoPort,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      resetLogsDeAmbienteDivergenteParaTeste: ambMod.resetLogsDeAmbienteDivergenteParaTeste,
      AmbienteDoIntentDivergenteError: ambMod.AmbienteDoIntentDivergenteError,
      creditarTopupPix: credMod.creditarTopupPix,
      varrerTopupsPixExpirados: varrMod.varrerTopupsPixExpirados,
      varrerPreAutorizacoesCartao: preMod.varrerPreAutorizacoesCartao,
      cancelarPreAutorizacaoCartao: cancMod.cancelarPreAutorizacaoCartao,
      capturarSessaoCartao: capMod.capturarSessaoCartao,
      FakeAdapter: fakeMod.FakeAdapter,
      criarFixtureCartao: fixMod.criarFixtureCartao,
      encryptPaymentSecret: secMod.encryptPaymentSecret,
    }
    app = m.createApp()
    for (const k of ['NODE_ENV', 'CIELO_SANDBOX']) envBaseline[k] = m.env[k]
    m.resetPagamentoPortCacheParaTeste()
    fake = (await m.getPagamentoPort()) as InstanceType<Mods['FakeAdapter']> // NODE_ENV=test e sem credencial => FakeAdapter (singleton do processo)
    const original = m.logger.error.bind(m.logger) as (...a: unknown[]) => void
    vi.spyOn(m.logger, 'error').mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === 'object' && args[0]) logsErro.push(args[0] as Record<string, unknown>)
      original(...args)
    }) as never)
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
    m.resetLogsDeAmbienteDivergenteParaTeste()
    logsErro.length = 0
  })
  afterEach(() => {
    Object.assign(m.env, envBaseline)
    m.invalidarCacheConfigGateway()
  })

  /** Ambiente efetivo SEM linha no banco: vem de `CIELO_SANDBOX`. Não reseta o FakeAdapter (é ele que "sabe" dos Pix criados). */
  function efetivo(amb: Amb) {
    m.env.CIELO_SANDBOX = amb === 'SANDBOX'
    m.invalidarCacheConfigGateway()
  }

  async function novoUsuario(role: 'ADMIN' | 'DRIVER') {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    const user = await m.prisma.user.create({
      data: { role, name: `${role} ${sufixo}`, email: `${role.toLowerCase()}-${sufixo}@example.com`, passwordHash: role === 'ADMIN' ? HASH_SENHA_ADMIN_TESTE : null },
    })
    return { id: user.id, token: m.issueToken({ id: user.id, role, operatorId: null }) }
  }
  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })
  const cadastrarCartao = (u: { token: string }, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/me/payment-methods').set(auth(u)).send({ cardToken: `mocktok.${randomUUID()}`, brand: 'Visa', ...extra })
  const listarCartoes = (u: { token: string }) => request(app).get('/api/me/payment-methods').set(auth(u))
  const putConfig = (u: { token: string }, body: Record<string, unknown>) =>
    request(app).put('/api/admin/payment-gateway').set(auth(u)).send({ currentPassword: SENHA_ADMIN_TESTE, ...body })

  /** Cartão direto no banco, com o ambiente que o teste quiser (o que a API gravaria sob aquele ambiente). */
  async function cartaoNoBanco(userId: string, environment: Amb, isDefault = false) {
    return m.prisma.paymentMethod.create({
      data: { userId, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.encryptPaymentSecret(`tok-${randomUUID()}`), brand: 'Visa', last4: '4242', environment, isDefault },
    })
  }
  async function carteira(userId: string) {
    return (await m.prisma.wallet.findUnique({ where: { userId } })) ?? m.prisma.wallet.create({ data: { userId } })
  }

  // ----------------------------------------------------------------------------------------------
  describe('(a) tudo que NASCE leva o ambiente efetivo explícito', () => {
    for (const amb of ['SANDBOX', 'PRODUCTION'] as const) {
      it(`Pix (POST /api/me/wallet/topups) sob ${amb} => PaymentIntent.environment = ${amb}`, async () => {
        efetivo(amb)
        const motorista = await novoUsuario('DRIVER')
        const res = await request(app).post('/api/me/wallet/topups').set(auth(motorista)).send({ amountCents: 2000 })
        expect(res.status, dump(res.body)).toBe(201)
        const intent = await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: res.body.id } })
        expect(intent.environment).toBe(amb)
      })

      it(`cartão (POST /api/me/payment-methods) sob ${amb} => PaymentMethod.environment = ${amb}`, async () => {
        efetivo(amb)
        const motorista = await novoUsuario('DRIVER')
        const res = await cadastrarCartao(motorista)
        expect(res.status, dump(res.body)).toBe(201)
        expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: res.body.id } })).environment).toBe(amb)
      })
    }

    it('o ambiente do BANCO (PaymentGatewayConfig.environment, minúsculo) manda e é mapeado na borda: linha "production" => marca PRODUCTION mesmo com CIELO_SANDBOX=true', async () => {
      await m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: 'production', cardEnabled: true, pixEnabled: true } })
      m.invalidarCacheConfigGateway()
      m.env.CIELO_SANDBOX = true
      const motorista = await novoUsuario('DRIVER')
      const pix = await request(app).post('/api/me/wallet/topups').set(auth(motorista)).send({ amountCents: 2000 })
      expect(pix.status, dump(pix.body)).toBe(201)
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: pix.body.id } })).environment).toBe('PRODUCTION')
      const cartao = await cadastrarCartao(motorista)
      expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: cartao.body.id } })).environment).toBe('PRODUCTION')
    })

    it('pré-autorização de cartão (POST /api/me/sessions/start CARD) sob PRODUCTION => PaymentIntent.environment = PRODUCTION', async () => {
      efetivo('PRODUCTION')
      const fx = await m.criarFixtureCartao(app, randomUUID().slice(0, 8), 'm4a')
      const motorista = await novoUsuario('DRIVER')
      const cartao = await cadastrarCartao(motorista)
      expect(cartao.status, dump(cartao.body)).toBe(201)

      // Fake gateway OCPP: aceita o RemoteStartTransaction publicado (sem WebSocket) — mesmo recurso da fixture de cartão.
      const subscriber = m.createRedisConnection()
      const publisher = m.createRedisConnection()
      const canal = `ocpp:cmd:${fx.tenant.chargePointId}`
      await subscriber.subscribe(canal)
      subscriber.on('message', (ch, mensagem) => {
        if (ch !== canal) return
        const p = JSON.parse(mensagem) as { correlationId: string; method: string }
        if (p.method === 'RemoteStartTransaction') publisher.publish(`ocpp:reply:${p.correlationId}`, JSON.stringify({ correlationId: p.correlationId, ok: true, result: { status: 'Accepted' } })).catch(() => {})
      })
      try {
        const res = await request(app).post('/api/me/sessions/start').set(auth(motorista)).send({ ocppIdentity: fx.tenant.ocppIdentity, connectorId: 1, payment: { mode: 'CARD', paymentMethodId: cartao.body.id } })
        expect(res.status, dump(res.body)).toBe(202)
        const intent = await m.prisma.paymentIntent.findFirstOrThrow({ where: { userId: motorista.id, purpose: 'SESSION_CARD_CAPTURE' } })
        expect(intent.environment).toBe('PRODUCTION')
        expect(intent.status).toBe('AUTHORIZED')
      } finally {
        subscriber.disconnect()
        publisher.disconnect()
      }
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('(b) cartões: só os do ambiente efetivo', () => {
    it('GET lista SÓ os do ambiente efetivo (cartão do outro ambiente é invisível)', async () => {
      const motorista = await novoUsuario('DRIVER')
      const sb = await cartaoNoBanco(motorista.id, 'SANDBOX', true)
      const pr = await cartaoNoBanco(motorista.id, 'PRODUCTION', true)

      efetivo('SANDBOX')
      expect((await listarCartoes(motorista)).body.items.map((i: { id: string }) => i.id)).toEqual([sb.id])
      efetivo('PRODUCTION')
      expect((await listarCartoes(motorista)).body.items.map((i: { id: string }) => i.id)).toEqual([pr.id])
    })

    it('uso em sessions/start: cartão do OUTRO ambiente => 404 PAYMENT_METHOD_NOT_FOUND, sem criar PaymentIntent nem chamar a Cielo', async () => {
      const motorista = await novoUsuario('DRIVER')
      const sb = await cartaoNoBanco(motorista.id, 'SANDBOX', true)
      efetivo('PRODUCTION')
      const autorizar = vi.spyOn(fake, 'autorizar')
      const fx = await m.criarFixtureCartao(app, randomUUID().slice(0, 8), 'm4b') // carregador ONLINE: a checagem do cartão vem depois da do carregador
      const res = await request(app).post('/api/me/sessions/start').set(auth(motorista)).send({ ocppIdentity: fx.tenant.ocppIdentity, connectorId: 1, payment: { mode: 'CARD', paymentMethodId: sb.id } })
      expect(res.status, dump(res.body)).toBe(404)
      expect(res.body.code).toBe('PAYMENT_METHOD_NOT_FOUND')
      expect(autorizar).not.toHaveBeenCalled()
      expect(await m.prisma.paymentIntent.count({ where: { userId: motorista.id } })).toBe(0)
      autorizar.mockRestore()
    })

    it('teto de 5 cartões conta SÓ os do ambiente efetivo: 5 de sandbox não ocupam vaga em production, e o 6º de production leva 409', async () => {
      const motorista = await novoUsuario('DRIVER')
      for (let i = 0; i < 5; i += 1) await cartaoNoBanco(motorista.id, 'SANDBOX', i === 0)
      efetivo('SANDBOX')
      expect((await cadastrarCartao(motorista)).status).toBe(409) // 6º em sandbox

      efetivo('PRODUCTION')
      for (let i = 0; i < 5; i += 1) expect((await cadastrarCartao(motorista)).status, `cartão ${i + 1} de production`).toBe(201)
      const sexto = await cadastrarCartao(motorista)
      expect(sexto.status).toBe(409)
      expect(sexto.body.code).toBe('TOO_MANY_PAYMENT_METHODS')
    })

    it('o padrão é por (usuário, ambiente): cadastrar o 1º cartão de production como padrão NÃO tira o padrão do sandbox; um padrão por ambiente', async () => {
      const motorista = await novoUsuario('DRIVER')
      const sbPadrao = await cartaoNoBanco(motorista.id, 'SANDBOX', true)

      efetivo('PRODUCTION')
      const pr = await cadastrarCartao(motorista) // 1º cartão do ambiente => vira padrão do ambiente
      expect(pr.status).toBe(201)
      expect(pr.body.isDefault).toBe(true)
      expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: sbPadrao.id } })).isDefault).toBe(true) // o do sandbox continua padrão do sandbox

      const pr2 = await cadastrarCartao(motorista, { makeDefault: true })
      expect(pr2.body.isDefault).toBe(true)
      const [a, b] = await Promise.all([m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: pr.body.id } }), m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: pr2.body.id } })])
      expect([a.isDefault, b.isDefault]).toEqual([false, true]) // trocou DENTRO do ambiente
      expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: sbPadrao.id } })).isDefault).toBe(true) // e o sandbox seguiu intacto
      const linhasPadrao = await m.prisma.paymentMethod.count({ where: { userId: motorista.id, isDefault: true } })
      expect(linhasPadrao).toBe(2) // 1 por ambiente: o banco NÃO garante "um padrão por usuário"
    })

    it('PATCH (marcar padrão) e DELETE em cartão do OUTRO ambiente => 404 e nada muda; no ambiente certo funcionam e a promoção do próximo padrão fica dentro do ambiente', async () => {
      const motorista = await novoUsuario('DRIVER')
      const sbA = await cartaoNoBanco(motorista.id, 'SANDBOX', true)
      efetivo('PRODUCTION')
      expect((await request(app).patch(`/api/me/payment-methods/${sbA.id}`).set(auth(motorista)).send({ isDefault: true })).status).toBe(404)
      expect((await request(app).delete(`/api/me/payment-methods/${sbA.id}`).set(auth(motorista))).status).toBe(404)
      expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: sbA.id } })).active).toBe(true)

      const pr1 = await cartaoNoBanco(motorista.id, 'PRODUCTION', true)
      const pr2 = await cartaoNoBanco(motorista.id, 'PRODUCTION', false)
      expect((await request(app).delete(`/api/me/payment-methods/${pr1.id}`).set(auth(motorista))).status).toBe(204)
      // o padrão removido promove o próximo DO MESMO ambiente (nunca o cartão de sandbox)
      expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: pr2.id } })).isDefault).toBe(true)
      expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: sbA.id } })).isDefault).toBe(true)
    })

    it('trocar o ambiente em CIMA do cadastro (efetivo muda durante a verificação na Cielo) => 503, nada gravado (token verificado num host não é rotulado com o outro)', async () => {
      const motorista = await novoUsuario('DRIVER')
      efetivo('SANDBOX')
      const verificar = vi.spyOn(fake, 'consultarCartaoTokenizado').mockImplementation(async (cardToken: string) => {
        efetivo('PRODUCTION') // o admin vira o gateway no meio da verificação
        return { cardToken, brand: 'Visa', last4: '4242', holderName: 'TESTE', expiryMonth: 12, expiryYear: 2030 }
      })
      const res = await cadastrarCartao(motorista)
      verificar.mockRestore()
      expect(res.status, dump(res.body)).toBe(503)
      expect(res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
      expect(await m.prisma.paymentMethod.count({ where: { userId: motorista.id } })).toBe(0)
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('(c) trocar o ambiente do gateway com PaymentIntent VIVO', () => {
    // Os intents ficam no banco entre os testes (mesmo banco): aposenta os vivos dos testes anteriores para a contagem do 409 ser exata.
    beforeEach(async () => {
      await m.prisma.paymentIntent.updateMany({ where: { status: { in: ['CREATED', 'AUTHORIZED', 'PENDING', 'CAPTURE_PENDING'] } }, data: { status: 'EXPIRED' } })
    })

    async function intent(userId: string, status: string, environment: Amb, purpose: 'WALLET_TOPUP_PIX' | 'SESSION_CARD_CAPTURE' = 'WALLET_TOPUP_PIX') {
      const extra = purpose === 'WALLET_TOPUP_PIX' ? { walletId: (await carteira(userId)).id, provider: 'CIELO_PIX' as const } : { provider: 'CIELO_CARD' as const, returnCode: '00' }
      return m.prisma.paymentIntent.create({ data: { purpose, userId, amountRequestedCents: 1000, status: status as never, environment, ...extra } })
    }
    /** Linha do banco no ambiente dado, com os dois meios desligados (sem pré-requisito a cumprir) — só o ambiente está em jogo. */
    async function gatewayEm(amb: 'sandbox' | 'production') {
      await m.prisma.paymentGatewayConfig.deleteMany()
      await m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: amb, cardEnabled: false, pixEnabled: false } })
      m.invalidarCacheConfigGateway()
    }

    for (const status of ['CREATED', 'PENDING', 'AUTHORIZED'] as const) {
      it(`intent ${status} do ambiente atual bloqueia sandbox -> production: 409 GATEWAY_HAS_INFLIGHT_PAYMENTS com details OBJETO { count } e NADA gravado`, async () => {
        await gatewayEm('sandbox')
        const admin = await novoUsuario('ADMIN')
        const motorista = await novoUsuario('DRIVER')
        await intent(motorista.id, status, 'SANDBOX', status === 'AUTHORIZED' ? 'SESSION_CARD_CAPTURE' : 'WALLET_TOPUP_PIX')
        await intent(motorista.id, status, 'SANDBOX', status === 'AUTHORIZED' ? 'SESSION_CARD_CAPTURE' : 'WALLET_TOPUP_PIX')
        const antes = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })

        const res = await putConfig(admin, { environment: 'production', confirmProduction: true })
        expect(res.status, dump(res.body)).toBe(409)
        expect(res.body.code).toBe('GATEWAY_HAS_INFLIGHT_PAYMENTS')
        expect(res.body.details).toEqual({ count: 2 }) // OBJETO, não array
        expect((await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })).environment).toBe(antes.environment)
      })
    }

    it('CAPTURE_PENDING (sessão de cartão parada, captura ainda não feita) também bloqueia', async () => {
      const admin = await novoUsuario('ADMIN')
      const fx = await m.criarFixtureCartao(app, randomUUID().slice(0, 8), 'm4c')
      const { intent: pendente } = await fx.sessaoParada('cap') // ANTES de desligar os meios (a sessão de cartão exige o cartão habilitado)
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: pendente.id } })).status).toBe('CAPTURE_PENDING')
      await gatewayEm('sandbox')
      const res = await putConfig(admin, { environment: 'production', confirmProduction: true })
      expect(res.status, dump(res.body)).toBe(409)
      expect(res.body.code).toBe('GATEWAY_HAS_INFLIGHT_PAYMENTS')
      expect(res.body.details.count).toBeGreaterThanOrEqual(1)
    })

    it('vale nas DUAS direções: production -> sandbox com intent vivo de PRODUCTION também é 409', async () => {
      await gatewayEm('production')
      const admin = await novoUsuario('ADMIN')
      const motorista = await novoUsuario('DRIVER')
      await intent(motorista.id, 'PENDING', 'PRODUCTION')
      const res = await putConfig(admin, { environment: 'sandbox' })
      expect(res.status, dump(res.body)).toBe(409)
      expect(res.body.details).toEqual({ count: 1 })
    })

    it('intents TERMINAIS (PAID/CAPTURED/FAILED/VOIDED/EXPIRED/DENIED/CANCELLED) e vivos do OUTRO ambiente NÃO bloqueiam: a troca passa (e continua exigindo confirmProduction)', async () => {
      await gatewayEm('sandbox')
      const admin = await novoUsuario('ADMIN')
      const motorista = await novoUsuario('DRIVER')
      for (const s of ['PAID', 'FAILED', 'EXPIRED']) await intent(motorista.id, s, 'SANDBOX')
      for (const s of ['VOIDED', 'DENIED', 'CANCELLED']) await intent(motorista.id, s, 'SANDBOX', 'SESSION_CARD_CAPTURE')
      await intent(motorista.id, 'PENDING', 'PRODUCTION') // vivo, mas do ambiente DESTINO — não é do ambiente atual

      const semConfirmacao = await putConfig(admin, { environment: 'production' })
      expect(semConfirmacao.status).toBe(400)
      expect(semConfirmacao.body.code).toBe('PRODUCTION_CONFIRMATION_REQUIRED')

      const res = await putConfig(admin, { environment: 'production', confirmProduction: true })
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.environment).toBe('production')
    })

    it('PUT que NÃO muda o ambiente (mesmo valor, ou só outro campo) passa mesmo com intent vivo', async () => {
      await gatewayEm('sandbox')
      const admin = await novoUsuario('ADMIN')
      const motorista = await novoUsuario('DRIVER')
      await intent(motorista.id, 'PENDING', 'SANDBOX')
      expect((await putConfig(admin, { environment: 'sandbox' })).status).toBe(200)
      expect((await putConfig(admin, { sopClientId: 'sop-so-um-campo' })).status).toBe(200)
    })

    it('depois que os vivos liquidam, a troca passa (e volta no outro sentido)', async () => {
      await gatewayEm('sandbox')
      const admin = await novoUsuario('ADMIN')
      const motorista = await novoUsuario('DRIVER')
      const vivo = await intent(motorista.id, 'PENDING', 'SANDBOX')
      expect((await putConfig(admin, { environment: 'production', confirmProduction: true })).status).toBe(409)
      await m.prisma.paymentIntent.update({ where: { id: vivo.id }, data: { status: 'EXPIRED' } })
      expect((await putConfig(admin, { environment: 'production', confirmProduction: true })).status).toBe(200)
      expect((await putConfig(admin, { environment: 'sandbox' })).status).toBe(200)
    })

    it('1ª gravação (linha semeada a partir do env): a regra usa o ambiente EFETIVO de antes — env em sandbox + intent SANDBOX vivo bloqueia', async () => {
      const admin = await novoUsuario('ADMIN')
      const motorista = await novoUsuario('DRIVER')
      efetivo('SANDBOX')
      await intent(motorista.id, 'PENDING', 'SANDBOX')
      const res = await putConfig(admin, { environment: 'production', confirmProduction: true })
      expect(res.status, dump(res.body)).toBe(409)
      expect(await m.prisma.paymentGatewayConfig.count()).toBe(0) // o INSERT semeado voltou junto (rollback)
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('(d) intent de OUTRO ambiente: a Cielo NÃO é chamada e nada é decidido', () => {
    const alertasDeDivergencia = () => logsErro.filter((l) => l.alert === 'payment_intent_environment_mismatch')

    it('creditarTopupPix: Pix PENDING de SANDBOX com o gateway em PRODUCTION => não consulta, não credita, continua PENDING, alerta logado (uma vez por janela)', async () => {
      efetivo('SANDBOX')
      const motorista = await novoUsuario('DRIVER')
      const criado = await request(app).post('/api/me/wallet/topups').set(auth(motorista)).send({ amountCents: 2000 })
      expect(criado.status).toBe(201)
      const intentId = criado.body.id as string
      const cieloId = (await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).cieloPaymentId!
      fake.marcarPixComoPago(cieloId) // pago de verdade no "banco" — mas o ambiente efetivo agora é outro

      efetivo('PRODUCTION')
      const consultar = vi.spyOn(fake, 'consultarPix')
      expect(await m.creditarTopupPix(intentId)).toBeNull()
      expect(await m.creditarTopupPix(intentId)).toBeNull() // 2ª chamada na mesma janela: continua sem consultar, sem 2º alerta
      expect(consultar).not.toHaveBeenCalled()
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).status).toBe('PENDING')
      expect(await m.prisma.walletEntry.count({ where: { referenceId: intentId } })).toBe(0)
      const alertas = alertasDeDivergencia()
      expect(alertas).toHaveLength(1)
      expect(alertas[0]).toMatchObject({ alert: 'payment_intent_environment_mismatch', paymentIntentId: intentId, intentEnvironment: 'SANDBOX', effectiveEnvironment: 'PRODUCTION' })

      // volta o ambiente: o MESMO intent credita normalmente (nada foi decidido nesse meio-tempo)
      efetivo('SANDBOX')
      expect(await m.creditarTopupPix(intentId)).not.toBeNull()
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).status).toBe('PAID')
      consultar.mockRestore()
    })

    it('varrerTopupsPixExpirados: Pix vencido de outro ambiente NÃO é consultado nem marcado EXPIRED', async () => {
      const motorista = await novoUsuario('DRIVER')
      const wallet = await carteira(motorista.id)
      const vencido = await m.prisma.paymentIntent.create({
        data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: motorista.id, walletId: wallet.id, amountRequestedCents: 1000, status: 'PENDING', environment: 'SANDBOX', cieloPaymentId: `fake-${randomUUID()}`, pixExpiresAt: new Date(Date.now() - 3600_000) },
      })
      efetivo('PRODUCTION')
      const consultar = vi.spyOn(fake, 'consultarPix')
      await m.varrerTopupsPixExpirados(fake)
      expect(consultar).not.toHaveBeenCalledWith(vencido.cieloPaymentId)
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: vencido.id } })).status).toBe('PENDING')
      expect(alertasDeDivergencia().some((a) => a.paymentIntentId === vencido.id)).toBe(true)
      consultar.mockRestore()
    })

    it('cancelarPreAutorizacaoCartao: pré-auth AUTHORIZED de outro ambiente NÃO é cancelada na Cielo e segue AUTHORIZED', async () => {
      const motorista = await novoUsuario('DRIVER')
      const pre = await m.prisma.paymentIntent.create({
        data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: motorista.id, amountRequestedCents: 1000, status: 'AUTHORIZED', environment: 'SANDBOX', cieloPaymentId: `fake-${randomUUID()}`, returnCode: '00', amountAuthorizedCents: 1000, authorizedAt: new Date(Date.now() - 3600_000) },
      })
      efetivo('PRODUCTION')
      const cancelar = vi.spyOn(fake, 'cancelar')
      await m.cancelarPreAutorizacaoCartao(pre.id, fake)
      expect(cancelar).not.toHaveBeenCalled()
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: pre.id } })).status).toBe('AUTHORIZED')
      expect(alertasDeDivergencia().some((a) => a.paymentIntentId === pre.id)).toBe(true)
      cancelar.mockRestore()
    })

    it('varrerPreAutorizacoesCartao: AUTHORIZED abandonada e CREATED velha de outro ambiente são PULADAS (nada cancelado, nada reconsultado, NENHUM FAILED por "sem resposta")', async () => {
      const motorista = await novoUsuario('DRIVER')
      const velho = new Date(Date.now() - 24 * 3600_000)
      const abandonada = await m.prisma.paymentIntent.create({
        data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: motorista.id, amountRequestedCents: 1000, status: 'AUTHORIZED', environment: 'SANDBOX', cieloPaymentId: `fake-${randomUUID()}`, returnCode: '00', amountAuthorizedCents: 1000, authorizedAt: velho },
      })
      const created = await m.prisma.paymentIntent.create({
        data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: motorista.id, amountRequestedCents: 1000, status: 'CREATED', environment: 'SANDBOX', createdAt: velho },
      })
      efetivo('PRODUCTION')
      const cancelar = vi.spyOn(fake, 'cancelar')
      const consultarPedido = vi.spyOn(fake, 'consultarPorPedido')
      const r = await m.varrerPreAutorizacoesCartao(fake)
      expect(cancelar).not.toHaveBeenCalled()
      expect(consultarPedido).not.toHaveBeenCalledWith(created.id)
      expect(r).toEqual({ canceladasAbandonadas: 0, resolvidasCreated: 0 })
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: abandonada.id } })).status).toBe('AUTHORIZED')
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('CREATED')
      cancelar.mockRestore()
      consultarPedido.mockRestore()
    })

    it('capturarSessaoCartao: CAPTURE_PENDING de outro ambiente LANÇA (retentável), não consulta nem captura, não vira FAILED nem dívida; ao voltar o ambiente, captura normalmente', async () => {
      const fx = await m.criarFixtureCartao(app, randomUUID().slice(0, 8), 'm4d')
      const { intent: pendente } = await fx.sessaoParada('cap')
      const antes = await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: pendente.id } })
      expect(antes).toMatchObject({ status: 'CAPTURE_PENDING', environment: 'SANDBOX' })

      efetivo('PRODUCTION')
      const consultar = vi.spyOn(fake, 'consultar')
      const capturar = vi.spyOn(fake, 'capturar')
      await expect(m.capturarSessaoCartao(pendente.id, fake)).rejects.toBeInstanceOf(m.AmbienteDoIntentDivergenteError)
      expect(consultar).not.toHaveBeenCalled()
      expect(capturar).not.toHaveBeenCalled()
      const depois = await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: pendente.id } })
      expect(depois.status).toBe('CAPTURE_PENDING')
      expect(await m.prisma.debt.count({ where: { paymentIntentId: pendente.id } })).toBe(0)
      expect(alertasDeDivergencia().some((a) => a.paymentIntentId === pendente.id)).toBe(true)

      efetivo('SANDBOX')
      const resultado = await m.capturarSessaoCartao(pendente.id, fake)
      expect(resultado).toMatchObject({ status: 'CAPTURED' })
      expect(consultar).toHaveBeenCalled()
      consultar.mockRestore()
      capturar.mockRestore()
    })

    it('intent do MESMO ambiente segue normal (controle: o guarda não bloqueia o caminho feliz) — Pix creditado sob PRODUCTION quando nasceu em PRODUCTION', async () => {
      efetivo('PRODUCTION')
      const motorista = await novoUsuario('DRIVER')
      const criado = await request(app).post('/api/me/wallet/topups').set(auth(motorista)).send({ amountCents: 2000 })
      expect(criado.status).toBe(201)
      const intentId = criado.body.id as string
      fake.marcarPixComoPago((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).cieloPaymentId!)
      expect(await m.creditarTopupPix(intentId)).not.toBeNull()
      expect(alertasDeDivergencia()).toHaveLength(0)
    })
  })
})
