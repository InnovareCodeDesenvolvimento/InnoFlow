import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { issueToken } from '../../src/lib/jwt'
import { logger } from '../../src/lib/logger'
import { encryptPaymentSecret } from '../../src/lib/crypto/paymentSecrets'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { getPagamentoPort, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { avaliarElegibilidadeCartao, limparRiscoDeCartaoParaTeste, mascararIp, registrarRecusaDeCartao, registrarTentativaDeCadastroDeCartao } from '../../src/services/pagamentos/elegibilidadeCartao'
import { cartaoLiberadoParaUsuario, identidadeEhTestador, identidadeVerificada } from '../../src/core/pagamentos/configGateway'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * I-7 (decisão do dono, 04/10/2026), Postgres + Redis reais, FakeAdapter no lugar da Cielo:
 *  - pagar com CARTÃO exige identidade verificada (Google) — em TODAS as entradas de cartão: sessão de tokenização, cadastro e início de recarga com cartão;
 *  - bloqueio por recusas (carding) por usuário/dia, por IP/hora e por cadastros tentados/dia — só cartão; Pix e carteira intactos;
 *  - `GET /api/me/payment-methods` devolve `cardEligibility` e MANTÉM a lista dos cartões já cadastrados.
 */
describe('cartão: identidade verificada + bloqueio por recusas (I-7)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const baseline = { ...env } as Record<string, unknown>
  let fake: FakeAdapter
  let fixture: FixtureCartao
  let connectorNumero = 900

  beforeAll(async () => {
    resetPagamentoPortCacheParaTeste()
    fake = (await getPagamentoPort()) as FakeAdapter
    expect(fake).toBeInstanceOf(FakeAdapter)
    fixture = await criarFixtureCartao(app, suffix, 'i7')
  }, 30_000)
  beforeEach(() => {
    const e = env as Record<string, unknown>
    e.CARD_REQUIRE_VERIFIED_IDENTITY = true
    e.CARD_BLOCK_MAX_REFUSALS_PER_USER_DAY = 3
    // O limite por IP NÃO é restaurado para 10 aqui: todas as requisições HTTP dos testes vêm de 127.0.0.1 e o contador por IP vive no Redis compartilhado (1 h); o `vitest.config.mts` o deixa altíssimo.
    // O teste de IP sobrescreve o limite e usa IPs próprios, passados direto ao serviço.
    e.CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR = baseline.CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR
    e.CARD_BLOCK_MAX_REGISTRATIONS_PER_USER_DAY = 10
  })
  afterEach(() => {
    Object.assign(env, baseline)
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function motorista(label: string, opcoes: { google?: boolean } = {}) {
    const user = await prisma.user.create({
      data: { role: 'DRIVER', name: `Driver ${label} ${suffix}`, email: `i7-${label}-${randomUUID().slice(0, 6)}-${suffix}@example.com`, googleSub: opcoes.google ? `google-${randomUUID()}` : null },
    })
    const pm = await prisma.paymentMethod.create({ data: { userId: user.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(randomUUID()), brand: 'Visa', last4: '4242', isDefault: true } })
    return { id: user.id, pmId: pm.id, auth: { Authorization: `Bearer ${issueToken({ id: user.id, role: 'DRIVER', operatorId: null })}` } }
  }
  type Motorista = Awaited<ReturnType<typeof motorista>>
  const sessao = (m: Motorista) => request(app).post('/api/me/payment-methods/tokenization-session').set(m.auth)
  const cadastrar = (m: Motorista) => request(app).post('/api/me/payment-methods').set(m.auth).send({ cardToken: randomUUID(), brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2031 })
  const listar = (m: Motorista) => request(app).get('/api/me/payment-methods').set(m.auth)
  const iniciarComCartao = (m: Motorista, connectorId = 1) =>
    request(app).post('/api/me/sessions/start').set(m.auth).send({ ocppIdentity: fixture.tenant.ocppIdentity, connectorId, payment: { mode: 'CARD', paymentMethodId: m.pmId } })

  // ------------------------------------------------------------------------------------------------------------------
  describe('regra pura única', () => {
    it('identidadeVerificada = googleSub OU role diferente de DRIVER; cartaoLiberadoParaUsuario usa a MESMA regra; identidadeEhTestador também', () => {
      for (const [usuario, esperado] of [
        [{ role: 'DRIVER', googleSub: null }, false],
        [{ role: 'DRIVER', googleSub: undefined }, false],
        [{ role: 'DRIVER', googleSub: 'g-1' }, true],
        [{ role: 'ADMIN', googleSub: null }, true],
        [{ role: 'OPERATOR', googleSub: null }, true],
        [null, false],
        [undefined, false],
      ] as const) {
        expect(identidadeVerificada(usuario), JSON.stringify(usuario)).toBe(esperado)
        expect(cartaoLiberadoParaUsuario(usuario), JSON.stringify(usuario)).toBe(esperado)
      }
      // o sandbox restrito usa a mesma definição: testador na lista MAS só-senha continua NÃO sendo testador
      const lista = new Set(['t@example.com'])
      expect(identidadeEhTestador({ email: 't@example.com', role: 'DRIVER', googleSub: null }, lista)).toBe(false)
      expect(identidadeEhTestador({ email: 't@example.com', role: 'DRIVER', googleSub: 'g' }, lista)).toBe(true)
    })

    it('mascararIp: IPv4 vira /24, IPv6 /48, IPv4-mapeado é tratado, ausente vira "desconhecido" (nunca o IP cru)', () => {
      expect(mascararIp('203.0.113.77')).toBe('203.0.113.0/24')
      expect(mascararIp('::ffff:198.51.100.9')).toBe('198.51.100.0/24')
      expect(mascararIp('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48')
      expect(mascararIp(undefined)).toBe('desconhecido')
      expect(mascararIp('lixo')).toBe('desconhecido')
    })
  })

  // ------------------------------------------------------------------------------------------------------------------
  describe('identidade verificada', () => {
    it('usuário SÓ-SENHA: bloqueado nas 3 entradas de cartão com 403 CARD_REQUIRES_VERIFIED_IDENTITY (mensagem em PT-BR que cita o Google, o Pix e a carteira)', async () => {
      const m = await motorista('so-senha')
      for (const res of [await sessao(m), await cadastrar(m), await iniciarComCartao(m)]) {
        expect(res.status, JSON.stringify(res.body)).toBe(403)
        expect(res.body.code).toBe('CARD_REQUIRES_VERIFIED_IDENTITY')
        expect(res.body.error).toMatch(/Google/)
        expect(res.body.error).toMatch(/Pix/)
        expect(res.body.error).toMatch(/carteira/)
      }
      expect(await prisma.paymentMethod.count({ where: { userId: m.id } })).toBe(1) // só o que já existia
      expect(await prisma.paymentIntent.count({ where: { userId: m.id } })).toBe(0) // nenhuma tentativa de cobrança
    })

    it('GET /api/me/payment-methods: a lista MANTÉM o cartão já cadastrado (inutilizável) e cardEligibility explica: GOOGLE_LOGIN_REQUIRED', async () => {
      const m = await motorista('lista')
      const res = await listar(m)
      expect(res.status).toBe(200)
      expect(res.body.items).toHaveLength(1)
      expect(res.body.cardEligibility).toEqual({ eligible: false, reason: 'GOOGLE_LOGIN_REQUIRED', blockedUntil: null })
    })

    it('usuário com GOOGLE: sessão de tokenização 200, cadastro 201, lista com cardEligibility { eligible: true }', async () => {
      const m = await motorista('google', { google: true })
      expect((await sessao(m)).status).toBe(200)
      const c = await cadastrar(m)
      expect(c.status, JSON.stringify(c.body)).toBe(201)
      expect((await listar(m)).body.cardEligibility).toEqual({ eligible: true, reason: null, blockedUntil: null })
    })

    it('DRIVER que VINCULA o Google depois passa a poder (a regra olha o banco a cada chamada, sem cache)', async () => {
      const m = await motorista('vincula')
      expect((await sessao(m)).status).toBe(403)
      await prisma.user.update({ where: { id: m.id }, data: { googleSub: `google-${randomUUID()}` } })
      expect((await sessao(m)).status).toBe(200)
      expect((await listar(m)).body.cardEligibility.eligible).toBe(true)
    })

    it('Pix e carteira seguem INTACTOS para o usuário só-senha (criar recarga Pix 201, ler saldo/extrato 200)', async () => {
      const m = await motorista('pix-ok')
      const pix = await request(app).post('/api/me/wallet/topups').set(m.auth).send({ amountCents: 2_000 })
      expect(pix.status, JSON.stringify(pix.body)).toBe(201)
      expect((await request(app).get('/api/me/wallet').set(m.auth)).status).toBe(200)
    })

    it('com CARD_REQUIRE_VERIFIED_IDENTITY=false (dev/CI) o só-senha passa — o padrão é ligado em PRODUÇÃO', async () => {
      ;(env as Record<string, unknown>).CARD_REQUIRE_VERIFIED_IDENTITY = false
      const m = await motorista('flag-off')
      expect((await sessao(m)).status).toBe(200)
      expect((await listar(m)).body.cardEligibility.eligible).toBe(true)
    })
  })

  // ------------------------------------------------------------------------------------------------------------------
  describe('bloqueio por recusas (carding)', () => {
    it('recusas REAIS pelo fluxo de início (Cielo nega -> 402): ao atingir o limite do usuário a próxima tentativa é 429 CARD_TEMPORARILY_BLOCKED com Retry-After e details.blockedUntil', async () => {
      ;(env as Record<string, unknown>).CARD_BLOCK_MAX_REFUSALS_PER_USER_DAY = 2
      const m = await motorista('recusas', { google: true })
      const conector = await prisma.connector.create({ data: { operatorId: fixture.tenant.operatorId, chargePointId: fixture.tenant.chargePointId, connectorId: ++connectorNumero, type: 'AC_TYPE2', status: 'AVAILABLE' } })
      const real = fake.autorizar.bind(fake)
      vi.spyOn(fake, 'autorizar').mockImplementation(async (pedido) => ({ ...(await real(pedido)), status: 'FAILED', returnCode: '51', amountAuthorizedCents: null }))

      expect((await iniciarComCartao(m, conector.connectorId)).status).toBe(402)
      expect((await iniciarComCartao(m, conector.connectorId)).status).toBe(402)

      const aviso = vi.spyOn(logger, 'warn')
      const bloqueada = await iniciarComCartao(m, conector.connectorId)
      expect(bloqueada.status, JSON.stringify(bloqueada.body)).toBe(429)
      expect(bloqueada.body.code).toBe('CARD_TEMPORARILY_BLOCKED')
      expect(bloqueada.body.error).toMatch(/Pix/)
      const ate = new Date(bloqueada.body.details.blockedUntil).getTime()
      expect(ate).toBeGreaterThan(Date.now() + 23 * 3600_000) // janela de 24 h a partir da 1ª recusa
      expect(ate).toBeLessThanOrEqual(Date.now() + 24 * 3600_000 + 5_000)
      expect(Number(bloqueada.headers['retry-after'])).toBeGreaterThan(23 * 3600)
      // nenhuma 3ª chamada à Cielo: o bloqueio vem ANTES de criar intent
      expect(await prisma.paymentIntent.count({ where: { userId: m.id } })).toBe(2)
      void aviso

      // as outras entradas de CARTÃO também; GET mostra o motivo; PIX e carteira seguem
      expect((await sessao(m)).status).toBe(429)
      expect((await cadastrar(m)).status).toBe(429)
      const lista = await listar(m)
      expect(lista.status).toBe(200)
      expect(lista.body.cardEligibility).toMatchObject({ eligible: false, reason: 'TEMPORARILY_BLOCKED' })
      expect(lista.body.items).toHaveLength(1)
      expect((await request(app).post('/api/me/wallet/topups').set(m.auth).send({ amountCents: 2_000 })).status).toBe(201)
    })

    it('recusa pelo 4xx definitivo da Cielo também conta (o mesmo contador do usuário)', async () => {
      const m = await motorista('recusa4xx', { google: true })
      const conector = await prisma.connector.create({ data: { operatorId: fixture.tenant.operatorId, chargePointId: fixture.tenant.chargePointId, connectorId: ++connectorNumero, type: 'AC_TYPE2', status: 'AVAILABLE' } })
      const { CieloHttpError } = await import('../../src/services/pagamentos/cieloHttpClient')
      vi.spyOn(fake, 'autorizar').mockRejectedValue(new CieloHttpError('x', 400, [{ Code: 126, Message: 'x' }]))
      expect((await iniciarComCartao(m, conector.connectorId)).status).toBe(402)
      expect(Number(await redis.get(`card-risk:refusals:user:${m.id}`))).toBe(1)
    })

    it('falha de GATEWAY (503/timeout) NÃO conta como recusa do cartão', async () => {
      const m = await motorista('indisp', { google: true })
      const conector = await prisma.connector.create({ data: { operatorId: fixture.tenant.operatorId, chargePointId: fixture.tenant.chargePointId, connectorId: ++connectorNumero, type: 'AC_TYPE2', status: 'AVAILABLE' } })
      vi.spyOn(fake, 'autorizar').mockRejectedValue(new Error('Cielo fora do ar'))
      expect((await iniciarComCartao(m, conector.connectorId)).status).toBe(503)
      expect(await redis.get(`card-risk:refusals:user:${m.id}`)).toBeNull()
    })

    it('o bloqueio EXPIRA com a janela: depois do TTL o usuário volta a ser elegível', async () => {
      const m = await motorista('expira', { google: true })
      for (let i = 0; i < 3; i++) await registrarRecusaDeCartao({ userId: m.id })
      expect((await avaliarElegibilidadeCartao(m.id)).reason).toBe('TEMPORARILY_BLOCKED')
      await redis.pexpire(`card-risk:refusals:user:${m.id}`, 250)
      await new Promise((r) => setTimeout(r, 400))
      expect(await avaliarElegibilidadeCartao(m.id)).toEqual({ eligible: true, reason: null, blockedUntil: null })
      expect((await sessao(m)).status).toBe(200)
    })

    it('por IP/hora: recusas de VÁRIAS contas do mesmo IP bloqueiam outra conta limpa naquele IP (e só naquele); alerta payment_card_testing_suspected UMA vez, com IP mascarado em /24', async () => {
      ;(env as Record<string, unknown>).CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR = 3
      const ip = `203.0.113.${100 + Math.floor(Math.random() * 100)}`
      const outroIp = `198.51.100.${100 + Math.floor(Math.random() * 100)}`
      const a = await motorista('ip-a', { google: true })
      const b = await motorista('ip-b', { google: true })
      const limpo = await motorista('ip-limpo', { google: true })
      const aviso = vi.spyOn(logger, 'warn')
      await registrarRecusaDeCartao({ userId: a.id, ip })
      await registrarRecusaDeCartao({ userId: b.id, ip })
      expect((await avaliarElegibilidadeCartao(limpo.id, ip)).eligible).toBe(true) // 2 de 3
      await registrarRecusaDeCartao({ userId: a.id, ip })
      await registrarRecusaDeCartao({ userId: a.id, ip }) // passou do limite: o alerta não repete

      const bloqueado = await avaliarElegibilidadeCartao(limpo.id, ip)
      expect(bloqueado).toMatchObject({ eligible: false, reason: 'TEMPORARILY_BLOCKED' })
      const ate = new Date(bloqueado.blockedUntil!).getTime()
      expect(ate).toBeLessThanOrEqual(Date.now() + 3600_000 + 5_000)
      expect(ate).toBeGreaterThan(Date.now() + 50 * 60_000)
      expect((await avaliarElegibilidadeCartao(limpo.id, outroIp)).eligible).toBe(true) // outro IP não sente
      expect((await avaliarElegibilidadeCartao(limpo.id)).eligible).toBe(true) // sem IP, só os contadores do usuário

      const alertas = aviso.mock.calls.filter((c) => (c[0] as { alert?: string }).alert === 'payment_card_testing_suspected' && (c[0] as { escopo?: string }).escopo === 'ip_refusals')
      expect(alertas).toHaveLength(1)
      const campos = alertas[0][0] as Record<string, unknown>
      expect(campos.ipMascarado).toBe(`${ip.split('.').slice(0, 3).join('.')}.0/24`)
      expect(JSON.stringify(campos)).not.toContain(ip) // IP cru nunca no alerta
      expect(campos.userId).toBeUndefined() // o alerta por IP não carrega usuário
      // nenhum IP cru no Redis também (a chave é hash)
      const chaves = await redis.keys('card-risk:refusals:ip:*')
      expect(chaves.some((k) => k.includes(ip))).toBe(false)
      await limparRiscoDeCartaoParaTeste(a.id, ip)
      await limparRiscoDeCartaoParaTeste(b.id)
    })

    it('cadastros TENTADOS: acima do limite diário o cadastro é bloqueado (429), mesmo que cada tentativa tenha falhado; o alerta sai com o usuário e sem IP cru', async () => {
      ;(env as Record<string, unknown>).CARD_BLOCK_MAX_REGISTRATIONS_PER_USER_DAY = 3
      const m = await motorista('cadastros', { google: true })
      const aviso = vi.spyOn(logger, 'warn')
      const ip = '203.0.113.9'
      for (let i = 0; i < 3; i++) {
        // token inválido na Cielo falsa? aqui o Fake aceita; o que importa é a TENTATIVA ser contada
        await registrarTentativaDeCadastroDeCartao({ userId: m.id, ip })
      }
      expect((await cadastrar(m)).status).toBe(429)
      const alerta = aviso.mock.calls.find((c) => (c[0] as { alert?: string }).alert === 'payment_card_testing_suspected' && (c[0] as { escopo?: string }).escopo === 'user_registrations')
      expect(alerta).toBeTruthy()
      expect((alerta![0] as { userId?: string }).userId).toBe(m.id)
      expect(JSON.stringify(alerta![0])).not.toContain(ip)
    })

    it('POST /payment-methods CONTA a tentativa pela rota (3 cadastros reais -> o 4º é 429 com limite 3)', async () => {
      ;(env as Record<string, unknown>).CARD_BLOCK_MAX_REGISTRATIONS_PER_USER_DAY = 3
      const m = await motorista('cadastros-rota', { google: true })
      await prisma.paymentMethod.deleteMany({ where: { userId: m.id } })
      for (let i = 0; i < 3; i++) expect((await cadastrar(m)).status).toBe(201)
      const r = await cadastrar(m)
      expect(r.status, JSON.stringify(r.body)).toBe(429)
      expect(r.body.code).toBe('CARD_TEMPORARILY_BLOCKED')
    })

    it('Redis indisponível NÃO derruba nem bloqueia: o controle de abuso é fail-open (o portão de identidade não depende dele)', async () => {
      const m = await motorista('redis-fora', { google: true })
      vi.spyOn(redis, 'get').mockRejectedValue(new Error('Redis fora'))
      expect(await avaliarElegibilidadeCartao(m.id, '203.0.113.1')).toEqual({ eligible: true, reason: null, blockedUntil: null })
      const so = await motorista('redis-fora-senha')
      expect((await avaliarElegibilidadeCartao(so.id)).reason).toBe('GOOGLE_LOGIN_REQUIRED') // identidade segue valendo sem Redis
    })
  })
})
