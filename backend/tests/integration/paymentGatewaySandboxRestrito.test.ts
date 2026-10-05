import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { JWT_SECRET_TROCADO, OVERRIDE_INVALIDO, trocarJwtSecret } from './helpers/chaveMestra'

/**
 * F5.7 — ALTO-2 (sandbox em servidor de produção restrito a testadores) e M3 (`secretsDecryptable`) contra Postgres + Redis REAIS
 * (banco próprio: `PaymentGatewayConfig` é singleton global). O `NODE_ENV` e as envs de pagamento são mutados no objeto `env` da aplicação
 * (lido a cada chamada) e restaurados a cada teste.
 */

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  logger: typeof import('../../src/lib/logger').logger
  issueToken: typeof import('../../src/lib/jwt').issueToken
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  resetAvisoSegredosIlegiveisParaTeste: typeof import('../../src/services/pagamentos/gatewayConfig').resetAvisoSegredosIlegiveisParaTeste
  resetPaymentSecretsKeyCacheParaTeste: typeof import('../../src/lib/crypto/paymentSecrets').resetPaymentSecretsKeyCacheParaTeste
  getPagamentoPort: typeof import('../../src/services/pagamentos/pagamentoPortInstance').getPagamentoPort
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  ConfiguracaoGatewayIndisponivelError: typeof import('../../src/core/pagamentos/erros').ConfiguracaoGatewayIndisponivelError
  creditarTopupPix: typeof import('../../src/services/pagamentos/creditarTopupPix').creditarTopupPix
  FakeAdapter: typeof import('../../src/services/pagamentos/fakeAdapter').FakeAdapter
}

// Renovados a cada teste (beforeEach): o e-mail é UNIQUE no banco e os testes criam o motorista-testador de novo.
let testerEmail = ''
let TESTADOR_NA_LISTA = ''
const SEGREDOS = { merchantKey: 'MKEY-sandbox-restrito-aaa111', sopClientSecret: 'SOPSECRET-sandbox-restrito-bbb222', webhookHeaderSecret: 'WHSECRET-sandbox-restrito-ccc333-0123456789abcdef' }
const MSG_CARTAO = 'O pagamento com cartão está desativado no momento.'
const MSG_PIX = 'A recarga por Pix está desativada no momento.'

function dump(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v))
}

describe('sandbox restrito a testadores (ALTO-2) e secretsDecryptable (M3) — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  const envBaseline: Record<string, unknown> = {}
  const logsErro: Array<Record<string, unknown>> = []
  let contador = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgr')
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete process.env[k]
    const [appMod, prismaMod, redisMod, envMod, loggerMod, jwtMod, cfgMod, secMod, portMod, errosMod, creditMod, fakeMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/logger'),
      import('../../src/lib/jwt'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('../../src/core/pagamentos/erros'),
      import('../../src/services/pagamentos/creditarTopupPix'),
      import('../../src/services/pagamentos/fakeAdapter'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      env: envMod.env as unknown as Record<string, unknown>,
      logger: loggerMod.logger,
      issueToken: jwtMod.issueToken,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      resetAvisoSegredosIlegiveisParaTeste: cfgMod.resetAvisoSegredosIlegiveisParaTeste,
      resetPaymentSecretsKeyCacheParaTeste: secMod.resetPaymentSecretsKeyCacheParaTeste,
      getPagamentoPort: portMod.getPagamentoPort,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      ConfiguracaoGatewayIndisponivelError: errosMod.ConfiguracaoGatewayIndisponivelError,
      creditarTopupPix: creditMod.creditarTopupPix,
      FakeAdapter: fakeMod.FakeAdapter,
    }
    app = m.createApp()
    for (const k of ['NODE_ENV', 'CIELO_SANDBOX', 'CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'PAYMENT_SECRETS_KEY', 'PAYMENT_SECRETS_KEY_PREVIOUS', 'JWT_SECRET', 'PAYMENT_SANDBOX_TESTER_EMAILS', 'PAYMENT_ALLOW_FAKE_ADAPTER']) envBaseline[k] = m.env[k]
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
    m.invalidarCacheConfigGateway()
    m.resetPagamentoPortCacheParaTeste()
    m.resetAvisoSegredosIlegiveisParaTeste()
    logsErro.length = 0
    testerEmail = `tester.${Math.random().toString(36).slice(2, 10)}@example.com`
    TESTADOR_NA_LISTA = ` ${testerEmail.replace('tester.', 'Tester.').toUpperCase()} ` // caixa e espaços diferentes do e-mail real
  })
  afterEach(() => {
    Object.assign(m.env, envBaseline)
    m.resetPaymentSecretsKeyCacheParaTeste()
  })

  /** `verificado`: identidade provada pelo Google (`googleSub`) — é o que torna um DRIVER elegível a testador (F5.8, ALTO-2: DRIVER só com senha nunca é). */
  async function novoUsuario(role: 'ADMIN' | 'DRIVER', email?: string, opcoes: { verificado?: boolean } = {}) {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    const user = await m.prisma.user.create({
      data: { role, name: `${role} ${sufixo}`, email: email ?? `${role.toLowerCase()}-${sufixo}@example.com`, passwordHash: role === 'ADMIN' ? HASH_SENHA_ADMIN_TESTE : null, googleSub: opcoes.verificado ? `g-${sufixo}` : null },
    })
    return { id: user.id, email: user.email, token: m.issueToken({ id: user.id, role, operatorId: null }) }
  }
  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })
  const get = (u: { token: string }) => request(app).get('/api/admin/payment-gateway').set(auth(u))
  const put = (u: { token: string }, body: Record<string, unknown>) => request(app).put('/api/admin/payment-gateway').set(auth(u)).send({ currentPassword: SENHA_ADMIN_TESTE, ...body })

  /** Servidor de PRODUÇÃO em sandbox (o cenário do ALTO-2). Fake permitido em produção só para o motorista autorizado chegar até o fim (nada é cobrado). */
  function servidorDeProducaoEmSandbox(testadores?: string, opcoes: { resetarAdaptador?: boolean } = {}) {
    m.env.NODE_ENV = 'production'
    m.env.CIELO_SANDBOX = true
    m.env.PAYMENT_ALLOW_FAKE_ADAPTER = true
    m.env.PAYMENT_SANDBOX_TESTER_EMAILS = testadores
    m.invalidarCacheConfigGateway()
    if (opcoes.resetarAdaptador !== false) m.resetPagamentoPortCacheParaTeste()
  }

  /** As 4 ENTRADAS de começo novo que têm a guarda. */
  const entradas = {
    'POST /api/me/payment-methods/tokenization-session': { method: 'CARD', chamar: (u: { token: string }) => request(app).post('/api/me/payment-methods/tokenization-session').set(auth(u)).send({}) },
    'POST /api/me/payment-methods': { method: 'CARD', chamar: (u: { token: string }) => request(app).post('/api/me/payment-methods').set(auth(u)).send({ cardToken: '0b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e', brand: 'Visa' }) },
    'POST /api/me/sessions/start (CARD)': {
      method: 'CARD',
      chamar: (u: { token: string }) => request(app).post('/api/me/sessions/start').set(auth(u)).send({ ocppIdentity: 'carregador-que-nao-existe', connectorId: 1, payment: { mode: 'CARD', paymentMethodId: 'cabcdefghijklmnopqrstuvwx' } }),
    },
    'POST /api/me/wallet/topups': { method: 'PIX', chamar: (u: { token: string }) => request(app).post('/api/me/wallet/topups').set(auth(u)).send({ amountCents: 2000 }) },
  } as const
  const mensagemDe = (metodo: 'CARD' | 'PIX') => (metodo === 'CARD' ? MSG_CARTAO : MSG_PIX)

  // ----------------------------------------------------------------------------------------------
  describe('ALTO-2 — sandbox em NODE_ENV=production', () => {
    for (const [nome, entrada] of Object.entries(entradas)) {
      it(`${nome}: motorista FORA da lista leva 409 PAYMENT_METHOD_DISABLED com details [{ method, reason: "SANDBOX_RESTRICTED" }] e a MESMA mensagem de "desativado"`, async () => {
        servidorDeProducaoEmSandbox(TESTADOR_NA_LISTA)
        const motorista = await novoUsuario('DRIVER')
        const res = await entrada.chamar(motorista)
        expect(res.status, dump(res.body)).toBe(409)
        expect(res.body.code).toBe('PAYMENT_METHOD_DISABLED')
        expect(res.body.details).toEqual([{ method: entrada.method, reason: 'SANDBOX_RESTRICTED' }])
        expect(res.body.error).toBe(mensagemDe(entrada.method))
        // não revela a lista de testadores nem o e-mail de ninguém
        expect(res.body.error).not.toMatch(/testador|tester|sandbox|restri/i)
        expect(dump(res.body)).not.toContain(testerEmail.split('@')[0]!)
      })

      it(`${nome}: lista VAZIA ou AUSENTE = ninguém passa (falha segura)`, async () => {
        for (const lista of [undefined, '', '   ', ' , ']) {
          servidorDeProducaoEmSandbox(lista)
          const motorista = await novoUsuario('DRIVER')
          const res = await entrada.chamar(motorista)
          expect(res.status, `lista=${JSON.stringify(lista)} ${dump(res.body)}`).toBe(409)
          expect(res.body.details).toEqual([{ method: entrada.method, reason: 'SANDBOX_RESTRICTED' }])
        }
      })
    }

    it('TESTADOR da lista (case-insensitive, com espaços) passa a guarda nas 4 entradas', async () => {
      servidorDeProducaoEmSandbox(`outro@example.com, ${TESTADOR_NA_LISTA} `)
      const testador = await novoUsuario('DRIVER', testerEmail, { verificado: true }) // caixa/espaços diferentes da lista

      const sessao = await entradas['POST /api/me/payment-methods/tokenization-session'].chamar(testador)
      expect(sessao.status, dump(sessao.body)).toBe(200)

      const cartao = await entradas['POST /api/me/payment-methods'].chamar(testador)
      expect(cartao.status, dump(cartao.body)).toBe(201)

      const pix = await entradas['POST /api/me/wallet/topups'].chamar(testador)
      expect(pix.status, dump(pix.body)).toBe(201)

      // sessions/start passa pela guarda e só falha adiante (carregador inexistente) — prova que NÃO foi barrado
      const start = await entradas['POST /api/me/sessions/start (CARD)'].chamar(testador)
      expect(start.status, dump(start.body)).toBe(404)
      expect(start.body.code).toBe('CHARGE_POINT_NOT_FOUND')
    })

    it('na MESMA instância: o testador passa e o outro motorista leva 409 (a decisão é por e-mail do motorista logado)', async () => {
      servidorDeProducaoEmSandbox(TESTADOR_NA_LISTA)
      const testador = await novoUsuario('DRIVER', testerEmail.toUpperCase(), { verificado: true })
      const outro = await novoUsuario('DRIVER')
      expect((await entradas['POST /api/me/wallet/topups'].chamar(testador)).status).toBe(201)
      expect((await entradas['POST /api/me/wallet/topups'].chamar(outro)).status).toBe(409)
    })

    it('DRIVER só com senha (sem googleSub) com o e-mail NA LISTA continua barrado nas 4 entradas (F5.8, ALTO-2: o e-mail do cadastro por senha não é confirmado)', async () => {
      servidorDeProducaoEmSandbox(TESTADOR_NA_LISTA)
      const semGoogle = await novoUsuario('DRIVER', testerEmail)
      for (const [nome, entrada] of Object.entries(entradas)) {
        const res = await entrada.chamar(semGoogle)
        expect(res.status, nome + ' ' + dump(res.body)).toBe(409)
        expect(res.body.details).toEqual([{ method: entrada.method, reason: 'SANDBOX_RESTRICTED' }])
      }
    })

    it('NÃO restringe fora de produção: NODE_ENV=test com lista vazia => qualquer motorista passa', async () => {
      servidorDeProducaoEmSandbox(undefined)
      m.env.NODE_ENV = 'test'
      m.resetPagamentoPortCacheParaTeste()
      const motorista = await novoUsuario('DRIVER')
      expect((await entradas['POST /api/me/wallet/topups'].chamar(motorista)).status).toBe(201)
    })

    it('NÃO restringe ambiente PRODUCTION (dinheiro real) em servidor de produção, mesmo com lista vazia', async () => {
      servidorDeProducaoEmSandbox(undefined)
      m.env.CIELO_SANDBOX = false // sem linha no banco: ambiente efetivo = production
      m.invalidarCacheConfigGateway()
      const motorista = await novoUsuario('DRIVER')
      const res = await entradas['POST /api/me/wallet/topups'].chamar(motorista)
      expect(res.status, dump(res.body)).toBe(201)
    })

    it('a decisão usa o ambiente EFETIVO (banco manda): linha do banco "production" desliga a restrição mesmo com CIELO_SANDBOX=true no env', async () => {
      servidorDeProducaoEmSandbox(undefined)
      await m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: 'production', cardEnabled: true, pixEnabled: true } })
      m.invalidarCacheConfigGateway()
      const motorista = await novoUsuario('DRIVER')
      expect((await entradas['POST /api/me/wallet/topups'].chamar(motorista)).status).toBe(201)
      // e o inverso: linha "sandbox" restringe mesmo com CIELO_SANDBOX=false no env
      await m.prisma.paymentGatewayConfig.update({ where: { id: 1 }, data: { environment: 'sandbox' } })
      m.env.CIELO_SANDBOX = false
      m.invalidarCacheConfigGateway()
      expect((await entradas['POST /api/me/wallet/topups'].chamar(motorista)).status).toBe(409)
    })

    it('flag desligada pelo admin continua GATEWAY_DISABLED (o sentido antigo não muda) — e vale para o testador também', async () => {
      servidorDeProducaoEmSandbox(TESTADOR_NA_LISTA)
      await m.prisma.paymentGatewayConfig.create({ data: { id: 1, environment: 'sandbox', cardEnabled: true, pixEnabled: false } })
      m.invalidarCacheConfigGateway()
      const testador = await novoUsuario('DRIVER', testerEmail, { verificado: true })
      const res = await entradas['POST /api/me/wallet/topups'].chamar(testador)
      expect(res.status).toBe(409)
      expect(res.body.details).toEqual([{ method: 'PIX', reason: 'GATEWAY_DISABLED' }])
    })

    it('só bloqueia COMEÇOS: a carteira, o Pix JÁ gerado/pago e a consulta do topup seguem funcionando para o motorista restrito', async () => {
      // 1) nasce um Pix enquanto NÃO é restrito (ex.: antes de virar para produção em sandbox)
      servidorDeProducaoEmSandbox(undefined)
      m.env.NODE_ENV = 'test'
      m.resetPagamentoPortCacheParaTeste()
      const motorista = await novoUsuario('DRIVER')
      const criado = await entradas['POST /api/me/wallet/topups'].chamar(motorista)
      expect(criado.status, dump(criado.body)).toBe(201)
      const intentId = criado.body.id as string

      // 2) agora o servidor passa a ser "produção em sandbox, lista vazia": novo começo é barrado... (sem trocar o FakeAdapter: é ele quem "sabe" do Pix já criado)
      servidorDeProducaoEmSandbox(undefined, { resetarAdaptador: false })
      expect((await entradas['POST /api/me/wallet/topups'].chamar(motorista)).status).toBe(409)

      // 3) ...mas a carteira, a consulta do Pix existente e o CRÉDITO do Pix já pago continuam
      expect((await request(app).get('/api/me/wallet').set(auth(motorista))).status).toBe(200)
      expect((await request(app).get(`/api/me/wallet/topups/${intentId}`).set(auth(motorista))).status).toBe(200)
      const intent = await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })
      const port = (await m.getPagamentoPort()) as InstanceType<Mods['FakeAdapter']>
      port.marcarPixComoPago(intent.cieloPaymentId!)
      const credito = await m.creditarTopupPix(intentId)
      expect(credito, 'o crédito do Pix já pago NÃO pode ser bloqueado pela restrição de sandbox').not.toBeNull()
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).status).toBe('PAID')
    })

    it('GET /api/admin/payment-gateway devolve sandboxRestricted nos 3 cenários (produção+sandbox, produção+production, dev+sandbox)', async () => {
      const admin = await novoUsuario('ADMIN')
      servidorDeProducaoEmSandbox(undefined)
      expect((await get(admin)).body.sandboxRestricted).toBe(true)

      m.env.CIELO_SANDBOX = false
      m.invalidarCacheConfigGateway()
      expect((await get(admin)).body.sandboxRestricted).toBe(false)

      m.env.CIELO_SANDBOX = true
      m.env.NODE_ENV = 'development'
      m.invalidarCacheConfigGateway()
      expect((await get(admin)).body.sandboxRestricted).toBe(false)
    })

    it('a lista de e-mails de testadores nunca aparece em log nem no DTO do admin', async () => {
      servidorDeProducaoEmSandbox(TESTADOR_NA_LISTA)
      const admin = await novoUsuario('ADMIN')
      const res = await get(admin)
      expect(dump(res.body)).not.toContain(testerEmail.split('@')[0]!)
      expect(Object.keys(res.body)).not.toContain('sandboxTesterEmails')
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('M3 — secretsDecryptable', () => {
    async function gravarTresSegredos(admin: { token: string }) {
      m.env.CIELO_SOP_SCRIPT_URL = 'https://sop.example/script.js'
      m.env.CIELO_SOP_OAUTH_TOKEN_URL = 'http://127.0.0.1:1/token'
      return put(admin, { merchantId: 'mid-m3', ...SEGREDOS, sopClientId: 'sop-m3', pixEnabled: false, cardEnabled: false })
    }
    function limparCaches() {
      m.resetPaymentSecretsKeyCacheParaTeste()
      m.invalidarCacheConfigGateway()
      m.resetPagamentoPortCacheParaTeste()
    }
    // MUDANÇA DELIBERADA (chave derivada do JWT_SECRET, como no InnoChat): "a chave trocou" = o JWT_SECRET trocou (e a sessão do admin cai: precisa reemitir o token). "A chave sumiu" = override inválido.
    function trocarJwtSecretDoServidor(admin: { id: string; token: string }) {
      trocarJwtSecret(m.env, JWT_SECRET_TROCADO)
      limparCaches()
      admin.token = m.issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })
    }
    function chaveMestraIndisponivel() {
      m.env.PAYMENT_SECRETS_KEY = OVERRIDE_INVALIDO
      limparCaches()
    }

    it('NULL quando nada está salvo no banco: sem linha (source "env") e linha só com campos não secretos', async () => {
      const admin = await novoUsuario('ADMIN')
      const semLinha = await get(admin)
      expect(semLinha.body).toMatchObject({ source: 'env', secretsDecryptable: null })

      m.env.CIELO_MERCHANT_ID = 'mid-do-env'
      m.env.CIELO_MERCHANT_KEY = 'segredo-do-env' // segredo no ENV não conta: o banco continua sem segredo
      m.invalidarCacheConfigGateway()
      const soNaoSecreto = await put(admin, { sopClientId: 'sop-so-id' })
      expect(soNaoSecreto.status, dump(soNaoSecreto.body)).toBe(200)
      expect(soNaoSecreto.body).toMatchObject({ source: 'database', secretsDecryptable: null })
    })

    it('TRUE com segredos salvos que decifram; FALSE quando a chave muda; reenviar os 3 segredos no mesmo PUT restabelece (TRUE) — e o GET nunca falha no meio', async () => {
      const admin = await novoUsuario('ADMIN')
      const gravou = await gravarTresSegredos(admin)
      expect(gravou.status, dump(gravou.body)).toBe(200)
      expect(gravou.body.secretsDecryptable).toBe(true)
      expect((await get(admin)).body.secretsDecryptable).toBe(true)

      // o JWT_SECRET do servidor muda (a chave dos segredos é derivada dele): os 3 segredos salvos não decifram mais
      trocarJwtSecretDoServidor(admin)
      const ilegivel = await get(admin)
      expect(ilegivel.status, dump(ilegivel.body)).toBe(200) // o GET responde mesmo com o gateway em 503
      expect(ilegivel.body).toMatchObject({ source: 'database', merchantKeySet: true, sopClientSecretSet: true, webhookHeaderSecretSet: true, secretsDecryptable: false })
      expect(dump(ilegivel.body)).not.toContain(SEGREDOS.merchantKey)
      // e o gateway DE FATO está indisponível (fail-closed), por isso o alerta da tela vale
      await expect(m.getPagamentoPort()).rejects.toBeInstanceOf(m.ConfiguracaoGatewayIndisponivelError)

      // reenviar os 3 segredos no mesmo PUT (o PUT não decifra nada) restabelece
      const reenviou = await put(admin, { merchantKey: SEGREDOS.merchantKey, sopClientSecret: SEGREDOS.sopClientSecret, webhookHeaderSecret: SEGREDOS.webhookHeaderSecret })
      expect(reenviou.status, dump(reenviou.body)).toBe(200)
      expect(reenviou.body.secretsDecryptable).toBe(true)
      expect((await get(admin)).body.secretsDecryptable).toBe(true)
    })

    it('FALSE também com UM só segredo ilegível (os outros decifram); reenviar só os que faltam não basta', async () => {
      const admin = await novoUsuario('ADMIN')
      await gravarTresSegredos(admin)
      // corrompe só o segredo do webhook (dado corrompido)
      await m.prisma.paymentGatewayConfig.update({ where: { id: 1 }, data: { webhookHeaderSecretCiphertext: 'dado-corrompido-nao-eh-base64-valido-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } })
      m.invalidarCacheConfigGateway()
      expect((await get(admin)).body.secretsDecryptable).toBe(false)
      const reenviou = await put(admin, { webhookHeaderSecret: SEGREDOS.webhookHeaderSecret })
      expect(reenviou.body.secretsDecryptable).toBe(true)
    })

    it('FALSE se a chave-mestra fica INDISPONÍVEL (override PAYMENT_SECRETS_KEY definido e inválido); o GET segue 200 e o readiness acusa a chave', async () => {
      const admin = await novoUsuario('ADMIN')
      await gravarTresSegredos(admin)
      chaveMestraIndisponivel()
      const res = await get(admin)
      expect(res.status).toBe(200)
      expect(res.body.secretsDecryptable).toBe(false)
      expect(res.body.readiness.card.missing).toContain('PAYMENT_SECRETS_KEY')
    })

    it('loga UMA vez por processo (alert payment_gateway_secrets_undecryptable), sem texto de segredo nem de ciphertext', async () => {
      const admin = await novoUsuario('ADMIN')
      await gravarTresSegredos(admin)
      const antes = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })
      trocarJwtSecretDoServidor(admin)
      for (let i = 0; i < 4; i += 1) expect((await get(admin)).body.secretsDecryptable).toBe(false)
      const avisos = logsErro.filter((l) => l.alert === 'payment_gateway_secrets_undecryptable')
      expect(avisos).toHaveLength(1)
      const texto = dump(logsErro)
      for (const s of Object.values(SEGREDOS)) expect(texto).not.toContain(s)
      expect(texto).not.toContain(antes.merchantKeyCiphertext!)
    })
  })
})
