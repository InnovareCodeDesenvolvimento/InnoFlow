import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
// Banco PRÓPRIO: este arquivo cria Pix PENDING (Cielo falsa) e intents de cartão; no banco COMPARTILHADO eles ficariam para trás e, ~30 min depois, entupiriam o lote de 50 do varredor de
// expiração de `topupPix.test.ts` (achado da rodada 3: 2 falhas só nas rodadas completas seguintes). `vi.hoisted` assíncrono roda antes dos imports estáticos.
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('i7_http_r3')
})

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis, createRedisConnection } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { avaliarElegibilidadeCartao, registrarRecusaDeCartao, registrarTentativaDeCadastroDeCartao, mascararIp } from '../../src/services/pagamentos/elegibilidadeCartao'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { BraspagFalsa, CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa, criarCenarioCartaoHttp, type CenarioCartaoHttp, type Motorista } from './helpers/cenarioCartaoHttp'
import { createUser, uniqueSuffix } from './helpers/fixtures'

/**
 * Íris (rodada 3, 04/10/2026) — REVALIDAÇÃO INDEPENDENTE da I-7 (89f36dd): cartão só com identidade verificada (Google) ou staff, e bloqueio anti-carding.
 * Diferente dos testes da Vega (FakeAdapter, serviços chamados direto), aqui tudo entra pela PORTA HTTP, com o `CieloAdapter` REAL falando por TCP com a Cielo/Braspag
 * FALSAS que CONTAM o que de fato chegou a elas. As provas valem no mundo da Cielo, não na resposta: "bloqueado" = a Cielo recebeu ZERO chamadas.
 */

const IP_BASE = () => `198.18.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`

describe('I-7 pela porta HTTP (adaptador real + Cielo/Braspag falsas por TCP, Postgres e Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  const braspag = new BraspagFalsa()
  let cen: CenarioCartaoHttp
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }
  const e = env as Record<string, unknown>

  beforeAll(async () => {
    await cielo.iniciar()
    await braspag.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 600 })
    e.CIELO_SOP_CLIENT_ID = 'sop-client-r3'
    e.CIELO_SOP_CLIENT_SECRET = 'sop-secret-r3'
    e.CIELO_SOP_OAUTH_TOKEN_URL = `${braspag.url}/oauth2/token`
    e.CIELO_SOP_ACCESS_TOKEN_URL = `${braspag.url}/post/api/public/v2/accesstoken`
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    cen = await criarCenarioCartaoHttp(app, suffix, 'i7r3')
  }, 30_000)

  beforeEach(() => {
    cielo.zerarRegistro()
    braspag.passos.length = 0
    e.CARD_REQUIRE_VERIFIED_IDENTITY = true
    e.CARD_BLOCK_MAX_REFUSALS_PER_USER_DAY = 3
    e.CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR = baseline.CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR // alto nos testes (o IP 127.0.0.1 é compartilhado por todas as suítes); o teste de IP o reduz
    e.CARD_BLOCK_MAX_REGISTRATIONS_PER_USER_DAY = 10
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    Object.assign(env, baseline)
    process.env.CIELO_API_BASE_URL = processEnvBaseline.api
    process.env.CIELO_API_QUERY_BASE_URL = processEnvBaseline.query
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    await cielo.parar()
    await braspag.parar()
    await cen.fechar()
    await prisma.$disconnect()
    redis.disconnect()
    await banco.descartar()
  })

  /** Motorista com cartão salvo; `google` => `googleSub` (identidade verificada). Cada um sai de um IP próprio (via X-Forwarded-For, `trust proxy` = 2). */
  async function motorista(label: string, opcoes: { google?: boolean; ip?: string } = {}): Promise<Motorista & { ip: string }> {
    const m = await cen.novoMotorista(label)
    if (opcoes.google) await prisma.user.update({ where: { id: m.user.id }, data: { googleSub: `google-${randomUUID()}` } })
    return { ...m, ip: opcoes.ip ?? IP_BASE() }
  }
  const com = (m: { token: string; ip: string }) => ({ Authorization: `Bearer ${m.token}`, 'X-Forwarded-For': `${m.ip}, 10.0.0.9` })
  const tokenizacao = (m: { token: string; ip: string }) => request(app).post('/api/me/payment-methods/tokenization-session').set(com(m)).send({})
  const cadastro = (m: { token: string; ip: string }, n = 0) =>
    request(app).post('/api/me/payment-methods').set(com(m)).send({ cardToken: randomUUID(), brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2031, makeDefault: n === 0 })
  const lista = (m: { token: string; ip: string }) => request(app).get('/api/me/payment-methods').set(com(m))
  const topupPix = (m: { token: string; ip: string }) => request(app).post('/api/me/wallet/topups').set(com(m)).send({ amountCents: 1500 })

  /** Start com cartão salvo; o gateway OCPP falso aceita o RemoteStart. Devolve a resposta crua. */
  async function iniciarCartao(m: Motorista & { ip: string }, conector: number) {
    const subscriber = createRedisConnection()
    const publisher = createRedisConnection()
    const channel = `ocpp:cmd:${cen.tenant.chargePointId}`
    await subscriber.subscribe(channel)
    subscriber.on('message', (ch, message) => {
      if (ch !== channel) return
      const p = JSON.parse(message) as { correlationId: string; method: string }
      if (p.method === 'RemoteStartTransaction') publisher.publish(`ocpp:reply:${p.correlationId}`, JSON.stringify({ correlationId: p.correlationId, ok: true, result: { status: 'Accepted' } })).catch(() => {})
    })
    try {
      return await request(app)
        .post('/api/me/sessions/start')
        .set(com(m))
        .send({ ocppIdentity: cen.tenant.ocppIdentity, connectorId: conector, payment: { mode: 'CARD', paymentMethodId: m.paymentMethod.id } })
    } finally {
      await new Promise((r) => setTimeout(r, 120))
      subscriber.disconnect()
      publisher.disconnect()
    }
  }

  const recusarProximaAutorizacao = () => cielo.agendar('POST_SALE', { venda: { status: 3, returnCode: '57' } })
  const chaveUsuario = (id: string) => `card-risk:refusals:user:${id}`
  const alertas = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0] as { alert?: string; [k: string]: unknown }).filter((o) => o?.alert === 'payment_card_testing_suspected')

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('(a1) portão de identidade em TODAS as entradas de cartão — e Pix/carteira intactos', () => {
    it('motorista SÓ-SENHA: sessão de tokenização, cadastro e início com cartão => 403 CARD_REQUIRES_VERIFIED_IDENTITY; a Cielo e a Braspag recebem ZERO chamadas e nada é criado', async () => {
      const m = await motorista('solo')
      const conector = await cen.novoConector()
      const cartoesAntes = await prisma.paymentMethod.count({ where: { userId: m.user.id } })
      const intentsAntes = await prisma.paymentIntent.count({ where: { userId: m.user.id } })

      for (const res of [await tokenizacao(m), await cadastro(m), await iniciarCartao(m, conector)]) {
        expect(res.status, JSON.stringify(res.body)).toBe(403)
        expect(res.body.code).toBe('CARD_REQUIRES_VERIFIED_IDENTITY')
        expect(res.headers['retry-after']).toBeUndefined()
      }
      expect(cielo.chamadas).toHaveLength(0)
      expect(braspag.passos).toHaveLength(0)
      expect(await prisma.paymentMethod.count({ where: { userId: m.user.id } })).toBe(cartoesAntes)
      expect(await prisma.paymentIntent.count({ where: { userId: m.user.id } })).toBe(intentsAntes)
      // o portão de identidade NÃO conta como tentativa (nada foi tentado): nenhum contador de risco nasce
      expect(await redis.get(chaveUsuario(m.user.id))).toBeNull()
      expect(await redis.get(`card-risk:registrations:user:${m.user.id}`)).toBeNull()
    })

    it('motorista COM Google: tokenização 200 (Braspag viu OAuth + accesstoken), cadastro 201 e início com cartão 202 (a Cielo recebeu a pré-autorização)', async () => {
      const m = await motorista('google', { google: true })
      const conector = await cen.novoConector()
      const t = await tokenizacao(m)
      expect(t.status, JSON.stringify(t.body)).toBe(200)
      expect(braspag.passos.map((p) => p.passo)).toEqual(['oauth', 'accesstoken'])
      const c = await cadastro(m)
      expect(c.status, JSON.stringify(c.body)).toBe(201)
      const s = await iniciarCartao(m, conector)
      expect(s.status, JSON.stringify(s.body)).toBe(202)
      expect(cielo.contar('POST_SALE')).toBe(1)
    })

    it('STAFF (ADMIN/OPERATOR) é elegível sem Google; DRIVER só-senha não; DRIVER com Google sim', async () => {
      const admin = await createUser({ role: 'ADMIN', label: 'i7r3-admin', suffix })
      const operador = await createUser({ role: 'OPERATOR', label: 'i7r3-op', suffix, operatorId: cen.tenant.operatorId })
      const solo = await motorista('staff-ctl')
      const google = await motorista('staff-ctl-g', { google: true })
      expect((await avaliarElegibilidadeCartao(admin.id)).eligible).toBe(true)
      expect((await avaliarElegibilidadeCartao(operador.id)).eligible).toBe(true)
      expect(await avaliarElegibilidadeCartao(solo.user.id)).toEqual({ eligible: false, reason: 'GOOGLE_LOGIN_REQUIRED', blockedUntil: null })
      expect((await avaliarElegibilidadeCartao(google.user.id)).eligible).toBe(true)
      // usuário inexistente (token de conta apagada) NÃO é elegível (fail-closed no portão de identidade)
      expect((await avaliarElegibilidadeCartao(`inexistente-${randomUUID()}`)).eligible).toBe(false)
    })

    it('Pix e carteira seguem para QUEM NÃO É ELEGÍVEL ao cartão: Pix 201 e início com CARTEIRA 202 (o portão é só de cartão)', async () => {
      const m = await motorista('pix-solo')
      const pix = await topupPix(m)
      expect(pix.status, JSON.stringify(pix.body)).toBe(201)
      const carteira = await prisma.wallet.findUniqueOrThrow({ where: { userId: m.user.id } }).catch(() => prisma.wallet.create({ data: { userId: m.user.id } }))
      await prisma.walletEntry.create({ data: { walletId: carteira.id, type: 'ADJUSTMENT_CREDIT', amountCents: 50_000, balanceAfterCents: 50_000, referenceType: 'MANUAL', description: 'saldo i7 r3' } })
      const conector = await cen.novoConector()
      const subscriber = createRedisConnection()
      const publisher = createRedisConnection()
      const channel = `ocpp:cmd:${cen.tenant.chargePointId}`
      await subscriber.subscribe(channel)
      subscriber.on('message', (ch, message) => {
        const p = JSON.parse(message) as { correlationId: string; method: string }
        if (ch === channel && p.method === 'RemoteStartTransaction') publisher.publish(`ocpp:reply:${p.correlationId}`, JSON.stringify({ correlationId: p.correlationId, ok: true, result: { status: 'Accepted' } })).catch(() => {})
      })
      try {
        const res = await request(app).post('/api/me/sessions/start').set(com(m)).send({ ocppIdentity: cen.tenant.ocppIdentity, connectorId: conector, payment: { mode: 'WALLET' } })
        expect(res.status, JSON.stringify(res.body)).toBe(202)
      } finally {
        await new Promise((r) => setTimeout(r, 120))
        subscriber.disconnect()
        publisher.disconnect()
      }
    })

    it('GET /api/me/payment-methods MANTÉM os cartões já cadastrados de quem não é elegível e traz cardEligibility (GOOGLE_LOGIN_REQUIRED); com Google, eligible', async () => {
      const solo = await motorista('lista-solo')
      const r1 = await lista(solo)
      expect(r1.status).toBe(200)
      expect(r1.body.items).toHaveLength(1)
      expect(r1.body.items[0]).toMatchObject({ id: solo.paymentMethod.id, last4: '4242' })
      expect(r1.body.cardEligibility).toEqual({ eligible: false, reason: 'GOOGLE_LOGIN_REQUIRED', blockedUntil: null })
      const g = await motorista('lista-g', { google: true })
      expect((await lista(g)).body.cardEligibility).toEqual({ eligible: true, reason: null, blockedUntil: null })
    })

    it('CONTROLE: com a flag DESLIGADA (padrão fora de produção) o só-senha passa — o 403 de cima vem do portão, não de outra coisa', async () => {
      e.CARD_REQUIRE_VERIFIED_IDENTITY = false
      const m = await motorista('flag-off')
      const t = await tokenizacao(m)
      expect(t.status, JSON.stringify(t.body)).toBe(200)
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('(a2) bloqueio anti-carding: 3 recusas/usuário/dia', () => {
    it('3 recusas da Cielo => 402 x3; a 4ª tentativa => 429 CARD_TEMPORARILY_BLOCKED com Retry-After e blockedUntil, SEM nenhuma chamada nova à Cielo; tokenização e cadastro também 429; Pix e carteira intactos; lista traz TEMPORARILY_BLOCKED', async () => {
      const m = await motorista('carding', { google: true })
      for (let i = 0; i < 3; i++) {
        recusarProximaAutorizacao()
        const res = await iniciarCartao(m, await cen.novoConector())
        expect(res.status, `tentativa ${i + 1}: ${JSON.stringify(res.body)}`).toBe(402)
        expect(res.body.code).toBe('CARD_AUTHORIZATION_DENIED')
      }
      expect(cielo.contar('POST_SALE')).toBe(3)
      expect(await redis.get(chaveUsuario(m.user.id))).toBe('3')

      const antes = Date.now()
      const quarta = await iniciarCartao(m, await cen.novoConector())
      expect(quarta.status, JSON.stringify(quarta.body)).toBe(429)
      expect(quarta.body.code).toBe('CARD_TEMPORARILY_BLOCKED')
      const retry = Number(quarta.headers['retry-after'])
      expect(retry).toBeGreaterThan(86_300)
      expect(retry).toBeLessThanOrEqual(86_400)
      const ate = new Date(quarta.body.details.blockedUntil).getTime()
      expect(ate).toBeGreaterThan(antes + 86_300_000)
      expect(ate).toBeLessThanOrEqual(Date.now() + 86_400_000)
      expect(cielo.contar('POST_SALE')).toBe(3) // a Cielo NÃO foi consultada de novo

      for (const res of [await tokenizacao(m), await cadastro(m)]) {
        expect(res.status).toBe(429)
        expect(res.body.code).toBe('CARD_TEMPORARILY_BLOCKED')
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
      }
      expect(braspag.passos).toHaveLength(0)

      expect((await topupPix(m)).status).toBe(201) // Pix intacto
      const elegibilidade = (await lista(m)).body.cardEligibility
      expect(elegibilidade).toMatchObject({ eligible: false, reason: 'TEMPORARILY_BLOCKED' })
      expect(typeof elegibilidade.blockedUntil).toBe('string')

      // outro motorista (outro IP) não é afetado
      const outro = await motorista('carding-outro', { google: true })
      expect((await tokenizacao(outro)).status).toBe(200)
    })

    it('a janela é FIXA a partir da 1ª recusa: TTL ~24 h na 1ª e a 2ª NÃO o renova', async () => {
      const m = await motorista('janela', { google: true })
      recusarProximaAutorizacao()
      expect((await iniciarCartao(m, await cen.novoConector())).status).toBe(402)
      const ttl1 = await redis.pttl(chaveUsuario(m.user.id))
      expect(ttl1).toBeGreaterThan(86_400_000 - 10_000)
      expect(ttl1).toBeLessThanOrEqual(86_400_000)
      await new Promise((r) => setTimeout(r, 1_100))
      recusarProximaAutorizacao()
      expect((await iniciarCartao(m, await cen.novoConector())).status).toBe(402)
      const ttl2 = await redis.pttl(chaveUsuario(m.user.id))
      expect(await redis.get(chaveUsuario(m.user.id))).toBe('2')
      expect(ttl2).toBeLessThan(ttl1 - 900) // passou ~1 s e o TTL não foi reiniciado
    })

    it('4xx DEFINITIVO da Cielo (400/126) CONTA como recusa; indisponibilidade (503, 500, timeout, conexão derrubada) NÃO conta — não se pune o motorista pela nossa queda', async () => {
      const m = await motorista('contagem', { google: true })
      cielo.agendar('POST_SALE', { processar: false, resposta: { http: 400, corpo: [{ Code: 126, Message: 'x' }] } })
      expect((await iniciarCartao(m, await cen.novoConector())).status).toBe(402)
      expect(await redis.get(chaveUsuario(m.user.id))).toBe('1')

      const m2 = await motorista('contagem-queda', { google: true })
      cielo.agendar(
        'POST_SALE',
        { processar: false, resposta: { http: 503, bruto: 'x' } },
        { processar: false, resposta: { http: 500, bruto: 'x' } },
        { processar: false, resposta: { http: 502, bruto: 'x' } },
        { processar: false, resposta: 'derrubar' },
        { processar: false, resposta: 'travar' },
      )
      for (let i = 0; i < 5; i++) expect((await iniciarCartao(m2, await cen.novoConector())).status).toBe(503)
      expect(await redis.get(chaveUsuario(m2.user.id))).toBeNull()
      expect((await avaliarElegibilidadeCartao(m2.user.id)).eligible).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('(a3) bloqueio por IP (10 recusas/hora) e por cadastros (10/dia)', () => {
    it('10 recusas de 10 USUÁRIOS DIFERENTES no mesmo IP bloqueiam o 11º usuário (limpo) desse IP — e só dele; o alerta sai UMA vez, sem dado pessoal e com o IP mascarado /24', async () => {
      e.CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR = 10
      const ip = IP_BASE()
      const aviso = vi.spyOn(logger, 'warn')
      for (let i = 0; i < 10; i++) {
        const m = await motorista(`ip-${i}`, { google: true, ip })
        recusarProximaAutorizacao()
        expect((await iniciarCartao(m, await cen.novoConector())).status).toBe(402)
      }
      const emitidos = alertas(aviso)
      aviso.mockRestore()
      expect(emitidos).toHaveLength(1)
      expect(emitidos[0]).toMatchObject({ escopo: 'ip_refusals', limite: 10, ipMascarado: `${ip.split('.').slice(0, 3).join('.')}.0/24` })
      expect(emitidos[0]).not.toHaveProperty('userId')
      expect(JSON.stringify(emitidos[0])).not.toContain(ip) // IP cru fora do alerta

      const limpo = await motorista('ip-limpo', { google: true, ip })
      const bloqueado = await tokenizacao(limpo)
      expect(bloqueado.status, JSON.stringify(bloqueado.body)).toBe(429)
      expect(bloqueado.body.code).toBe('CARD_TEMPORARILY_BLOCKED')
      expect(Number(bloqueado.headers['retry-after'])).toBeGreaterThan(3_500)
      expect(Number(bloqueado.headers['retry-after'])).toBeLessThanOrEqual(3_600)
      // as TRÊS entradas de cartão olham o IP (não só a tokenização): cadastro e início com cartão também recebem 429 e não tocam a Cielo
      const postsAntes = cielo.contar('POST_SALE')
      for (const res of [await cadastro(limpo), await iniciarCartao(limpo, await cen.novoConector())]) {
        expect(res.status, JSON.stringify(res.body)).toBe(429)
        expect(res.body.code).toBe('CARD_TEMPORARILY_BLOCKED')
      }
      expect(cielo.contar('POST_SALE')).toBe(postsAntes)
      expect((await lista(limpo)).body.cardEligibility).toMatchObject({ eligible: false, reason: 'TEMPORARILY_BLOCKED' })
      const outroIp = await motorista('ip-outro', { google: true })
      expect((await tokenizacao(outroIp)).status).toBe(200)
      // nenhuma chave do Redis guarda o IP cru
      const chaves = await redis.keys('card-risk:*')
      expect(chaves.some((c) => c.includes(ip))).toBe(false)
    })

    it('usuário bloqueado (24 h) E IP bloqueado (1 h) ao mesmo tempo: vale o MAIOR prazo (24 h), não o menor', async () => {
      e.CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR = 2
      const ip = IP_BASE()
      const m = await motorista('maior-prazo', { google: true, ip })
      for (let i = 0; i < 3; i++) {
        recusarProximaAutorizacao()
        expect((await iniciarCartao(m, await cen.novoConector())).status).toBe(i < 2 ? 402 : 429) // a 3ª já cai no bloqueio do IP (2/h)
      }
      // força também o contador do usuário acima do limite (3) por serviço, mantendo o do IP (1 h)
      for (let i = 0; i < 3; i++) await registrarRecusaDeCartao({ userId: m.user.id })
      const res = await tokenizacao(m)
      expect(res.status).toBe(429)
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(86_300) // 24 h do usuário, não a 1 h do IP
    })

    it('10 cadastros TENTADOS/dia: as tentativas CONTAM mesmo quando falham (teto de 5 cartões => 409) e a 11ª é barrada pelo bloqueio (429 CARD_TEMPORARILY_BLOCKED)', async () => {
      const m = await motorista('cadastros', { google: true }) // já tem 1 cartão salvo
      // 4 cadastros novos (201) levam ao teto de 5; a partir daí, 409 — e cada tentativa, 201 ou 409, soma no contador.
      expect([(await cadastro(m, 0)).status, (await cadastro(m, 1)).status, (await cadastro(m, 2)).status, (await cadastro(m, 3)).status]).toEqual([201, 201, 201, 201])
      expect((await cadastro(m, 4)).status).toBe(409)
      expect(await redis.get(`card-risk:registrations:user:${m.user.id}`)).toBe('5')
      // Pelo HTTP o `meCreatePaymentMethodRateLimit` (8 por janela) chega ANTES dos 10 do I-7: soma-se o resto pelo serviço (o que 3 horas de tentativas fariam).
      for (let i = 0; i < 4; i++) await registrarTentativaDeCadastroDeCartao({ userId: m.user.id })
      expect(await redis.get(`card-risk:registrations:user:${m.user.id}`)).toBe('9')
      expect((await cadastro(m, 5)).status).toBe(409) // 10ª tentativa: ainda passa pelo portão (contador 9 < 10) e conta
      const onze = await cadastro(m, 6)
      expect(onze.status, JSON.stringify(onze.body)).toBe(429)
      expect(onze.body.code).toBe('CARD_TEMPORARILY_BLOCKED')
      expect(await redis.get(`card-risk:registrations:user:${m.user.id}`)).toBe('10') // a barrada NÃO conta de novo
    })

    it('CARACTERIZAÇÃO: só pelo HTTP, a 9ª tentativa de cadastro em sequência cai no rate limit existente (RATE_LIMITED_PAYMENT_METHOD, 8/janela), antes do bloqueio do I-7 — o teto de 10/dia do I-7 só é alcançável ao longo de várias janelas', async () => {
      const m = await motorista('cadastros-rl', { google: true })
      const codigos: Array<string | undefined> = []
      for (let i = 0; i < 9; i++) codigos.push((await cadastro(m, i)).body.code)
      expect(codigos[8]).toBe('RATE_LIMITED_PAYMENT_METHOD')
      expect(await redis.get(`card-risk:registrations:user:${m.user.id}`)).toBe('8')
    })

    it('ALERTA uma vez por janela: recusas além do limite (serviço) não repetem `payment_card_testing_suspected`', async () => {
      const aviso = vi.spyOn(logger, 'warn')
      const id = `alerta-${randomUUID()}`
      for (let i = 0; i < 6; i++) await registrarRecusaDeCartao({ userId: id })
      const emitidos = alertas(aviso)
      aviso.mockRestore()
      expect(emitidos).toHaveLength(1)
      expect(emitidos[0]).toMatchObject({ escopo: 'user_refusals', limite: 3, userId: id })
      await redis.del(chaveUsuario(id))
    })

    it('mascararIp: IPv4 vira /24, IPv4-mapeado idem, IPv6 vira /48, lixo/ausente vira "desconhecido" (nunca o IP cru)', () => {
      expect(mascararIp('203.0.113.77')).toBe('203.0.113.0/24')
      expect(mascararIp('::ffff:203.0.113.77')).toBe('203.0.113.0/24')
      expect(mascararIp('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48')
      expect(mascararIp(undefined)).toBe('desconhecido')
      expect(mascararIp('não-é-ip')).toBe('desconhecido')
      expect(mascararIp('203.0.113.77.9')).toBe('desconhecido')
    })
  })
})
