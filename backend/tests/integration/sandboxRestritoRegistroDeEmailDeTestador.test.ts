import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'

/**
 * QA da Íris (F5.8, rodada Vega-2) — o RISCO RESIDUAL do ALTO-2 que o Vega admite ("cadastro por e-mail/senha não confirma o e-mail"), medido de verdade
 * pela API pública, num servidor `NODE_ENV=production` em sandbox com a lista `PAYMENT_SANDBOX_TESTER_EMAILS`. A trava depende de o e-mail do
 * motorista logado estar na lista; quem controla "ser dono de um e-mail" aqui é `POST /api/auth/register`, que NÃO confirma o endereço.
 *
 * ACHADO 1 (o pior, SEM pré-condição): a comparação da lista ignora a caixa (`emailEhTestador` faz `trim().toLowerCase()`), mas a unicidade de
 * `User.email` NÃO (índice `User_email_key` sobre `String` comum; o `register` só faz `trim`). Quem sabe o e-mail de um testador que JÁ TEM conta cadastra
 * `TESTADOR@dominio` (outra linha, permitida) e a comparação o trata como o testador: passa na guarda e usa Pix/cartão de sandbox de graça. Basta o
 * e-mail ser conhecido (ele costuma ser o do próprio dono, que está em contato público do negócio).
 * ACHADO 2 (o que o Vega admite): e-mail de testador AINDA SEM conta pode ser registrado por terceiro (sem confirmação do endereço).
 * Causa comum: "estar na lista" é decidido por um texto digitado no cadastro, não por um e-mail PROVADO. Correções baratas (qualquer uma fecha o 1; só a
 * 1ª fecha os dois): exigir `googleSub != null` do testador (o e-mail do Google vem com `email_verified`, ver `autenticarComGoogle.ts`) ou testar por
 * id de usuário; e, no `register`, recusar e-mail que já exista em outra caixa (`mode: 'insensitive'`). Se corrigir, trocar `it.fails` por `it`.
 *
 * CONTROLES (`it` normais): o motorista comum continua barrado (409) e o testador legítimo passa — sem isto os `it.fails` poderiam estar "falhando"
 * por causa de um servidor que não restringe nada.
 */

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
}

describe('ALTO-2 — risco residual: e-mail de testador não é provado (register sem confirmação + unicidade sensível a caixa) — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  const envBaseline: Record<string, unknown> = {}
  let testador = ''

  beforeAll(async () => {
    banco = await criarBancoProprio('pgt')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, cfgMod, portMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
    ])
    m = { createApp: appMod.createApp, prisma: prismaMod.prisma, redis: redisMod.redis, env: envMod.env as unknown as Record<string, unknown>, invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway, resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste }
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
    testador = `dono.${Math.random().toString(36).slice(2, 10)}@example.com`
    m.env.NODE_ENV = 'production'
    m.env.CIELO_SANDBOX = true
    m.env.PAYMENT_ALLOW_FAKE_ADAPTER = true
    m.env.PAYMENT_SANDBOX_TESTER_EMAILS = testador
    m.invalidarCacheConfigGateway()
    m.resetPagamentoPortCacheParaTeste()
  })
  afterEach(() => {
    Object.assign(m.env, envBaseline)
    m.invalidarCacheConfigGateway()
  })

  const registrar = (email: string) => request(app).post('/api/auth/register').send({ name: 'Quem Registrou', email, password: 'Senha-Forte-123' })
  const pix = (token: string) => request(app).post('/api/me/wallet/topups').set({ Authorization: `Bearer ${token}` }).send({ amountCents: 2000 })

  it('CONTROLE: motorista comum (e-mail fora da lista) leva 409 SANDBOX_RESTRICTED e o testador legítimo (e-mail IGUAL) passa', async () => {
    const legitimo = await registrar(testador)
    expect(legitimo.status, JSON.stringify(legitimo.body)).toBe(201)
    expect((await pix(legitimo.body.token)).status).toBe(201)

    const comum = await registrar(`comum.${Math.random().toString(36).slice(2, 10)}@example.com`)
    const barrado = await pix(comum.body.token)
    expect(barrado.status).toBe(409)
    expect(barrado.body.details).toEqual([{ method: 'PIX', reason: 'SANDBOX_RESTRICTED' }])
  })

  it('PROVA (a unicidade é sensível a caixa): o testador JÁ tem conta e o cadastro de "DONO.…@EXAMPLE.COM" é ACEITO como outra conta (201)', async () => {
    expect((await registrar(testador)).status).toBe(201)
    const variante = await registrar(testador.toUpperCase())
    expect(variante.status, 'se isto virar 409 o achado 1 foi corrigido no register').toBe(201)
    const contas = await m.prisma.user.count({ where: { email: { equals: testador, mode: 'insensitive' } } })
    expect(contas).toBe(2)
  })

  it.fails('ACHADO 1: o testador JÁ tem conta; um terceiro que cadastra a mesma caixa-alta NÃO pode ganhar o Pix/cartão de sandbox do testador', async () => {
    expect((await registrar(testador)).status).toBe(201)
    const terceiro = await registrar(testador.toUpperCase())
    const token = terceiro.body.token as string | undefined
    // se o register recusou a variante (correção A), não há token e o teste termina aqui (passa)
    if (!token) return
    expect((await pix(token)).status, 'a variante em caixa alta entrou como testador e usou o sandbox').toBe(409)
  })

  it.fails('ACHADO 2: e-mail de testador AINDA SEM conta, registrado por um terceiro (sem confirmação do endereço), NÃO pode liberar o sandbox', async () => {
    const terceiro = await registrar(testador) // ninguém provou ser dono deste e-mail
    expect(terceiro.status).toBe(201)
    expect((await pix(terceiro.body.token)).status, 'o terceiro passou na guarda só por digitar o e-mail da lista').toBe(409)
  })
})
