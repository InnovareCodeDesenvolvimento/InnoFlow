import { execSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PrismaClient } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

/**
 * Configuração do gateway Cielo (F5.5) — ponta a ponta contra Postgres + Redis REAIS.
 *
 * BANCO PRÓPRIO, criado e descartado por este arquivo: `PaymentGatewayConfig` é um SINGLETON GLOBAL e as suítes
 * rodam em paralelo contra o mesmo Postgres — gravar credencial/flags/ambiente aqui no banco compartilhado
 * mudaria o adaptador de pagamento (Cielo de verdade em vez do Fake!) e desligaria cartão/Pix nas outras suítes
 * no meio do teste. Por isso: `CREATE DATABASE` a partir do `DATABASE_URL` da suíte, `prisma migrate deploy`
 * nele, e só DEPOIS `import()` dinâmico dos módulos da aplicação (o `env.ts`/Prisma leem `DATABASE_URL` uma vez,
 * no import). Requer um usuário com CREATEDB (o `postgres` da CI e do dev têm).
 */

// Falha de auditoria FORÇADA sob demanda (resto do tempo é o writeAuditLog de verdade) — prova o fail-closed.
const auditoria = vi.hoisted(() => ({ falhar: false }))
vi.mock('../../src/services/auditoria/writeAuditLog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/auditoria/writeAuditLog')>()
  return {
    ...real,
    writeAuditLog: vi.fn(async (...args: Parameters<typeof real.writeAuditLog>) => {
      if (auditoria.falhar) throw new Error('falha simulada de auditoria (teste fail-closed)')
      return real.writeAuditLog(...args)
    }),
  }
})

const PATH_TOKEN = 'pathtoken-teste-1234'
const ENV_HEADER_SECRET = 'env-header-secret-1'
const BASE_URL = process.env.DATABASE_URL!
const NOME_BANCO = `pgw_${Math.random().toString(36).slice(2, 10)}`
const URL_BANCO = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${NOME_BANCO}$1`)

// Valores secretos ÚNICOS: depois de cada cenário procuramos estes textos em resposta, auditoria e log.
const SEGREDOS = {
  merchantKey: 'MKEY-super-secreta-aaa111',
  sopClientSecret: 'SOPSECRET-super-secreto-bbb222',
  webhookHeaderSecret: 'WHSECRET-super-secreto-ccc333',
}

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  logger: typeof import('../../src/lib/logger').logger
  issueToken: typeof import('../../src/lib/jwt').issueToken
  getPagamentoPort: typeof import('../../src/services/pagamentos/pagamentoPortInstance').getPagamentoPort
  resetPagamentoPortCacheParaTeste: typeof import('../../src/services/pagamentos/pagamentoPortInstance').resetPagamentoPortCacheParaTeste
  isUsandoFakeAdapter: typeof import('../../src/services/pagamentos/pagamentoPortInstance').isUsandoFakeAdapter
  invalidarCacheConfigGateway: typeof import('../../src/services/pagamentos/gatewayConfig').invalidarCacheConfigGateway
  decryptPaymentSecret: typeof import('../../src/lib/crypto/paymentSecrets').decryptPaymentSecret
  creditarTopupPix: typeof import('../../src/services/pagamentos/creditarTopupPix').creditarTopupPix
  FakeAdapter: typeof import('../../src/services/pagamentos/fakeAdapter').FakeAdapter
  ConfiguracaoGatewayIndisponivelError: typeof import('../../src/core/pagamentos/erros').ConfiguracaoGatewayIndisponivelError
}

function dumpSeguro(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v))
}

describe('Configuração do gateway Cielo (F5.5) — Postgres + Redis reais, banco próprio', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let adminPrisma: PrismaClient
  let oauthServer: Server
  let oauthUrl: string
  const logsCapturados: string[] = []
  const envBaseline: Record<string, unknown> = {}
  let contador = 0

  beforeAll(async () => {
    adminPrisma = new PrismaClient({ datasources: { db: { url: BASE_URL } } })
    await adminPrisma.$executeRawUnsafe(`CREATE DATABASE "${NOME_BANCO}"`)
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: URL_BANCO }, stdio: 'pipe', cwd: process.cwd() })

    process.env.DATABASE_URL = URL_BANCO
    process.env.CIELO_WEBHOOK_PATH_TOKEN = PATH_TOKEN
    process.env.CIELO_WEBHOOK_HEADER_SECRET = ENV_HEADER_SECRET
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_SOP_SCRIPT_URL', 'CIELO_SOP_OAUTH_TOKEN_URL', 'PUBLIC_API_BASE_URL', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL']) {
      delete process.env[k]
    }

    // Servidor OAuth falso (SOP) — a única "Cielo" deste teste; nada sai da máquina.
    oauthServer = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ access_token: 'access-token-falso', expires_in: 300 }))
    })
    await new Promise<void>((resolve) => oauthServer.listen(0, '127.0.0.1', resolve))
    oauthUrl = `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}`

    const [appMod, prismaMod, redisMod, envMod, loggerMod, jwtMod, portMod, cfgMod, secMod, creditMod, fakeMod, errosMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/logger'),
      import('../../src/lib/jwt'),
      import('../../src/services/pagamentos/pagamentoPortInstance'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/creditarTopupPix'),
      import('../../src/services/pagamentos/fakeAdapter'),
      import('../../src/core/pagamentos/erros'),
    ])
    m = {
      createApp: appMod.createApp,
      prisma: prismaMod.prisma,
      redis: redisMod.redis,
      env: envMod.env as unknown as Record<string, unknown>,
      logger: loggerMod.logger,
      issueToken: jwtMod.issueToken,
      getPagamentoPort: portMod.getPagamentoPort,
      resetPagamentoPortCacheParaTeste: portMod.resetPagamentoPortCacheParaTeste,
      isUsandoFakeAdapter: portMod.isUsandoFakeAdapter,
      invalidarCacheConfigGateway: cfgMod.invalidarCacheConfigGateway,
      decryptPaymentSecret: secMod.decryptPaymentSecret,
      creditarTopupPix: creditMod.creditarTopupPix,
      FakeAdapter: fakeMod.FakeAdapter,
      ConfiguracaoGatewayIndisponivelError: errosMod.ConfiguracaoGatewayIndisponivelError,
    }
    app = m.createApp()

    for (const k of ['NODE_ENV', 'CIELO_SANDBOX', 'CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'CIELO_SOP_SCRIPT_URL', 'CIELO_SOP_OAUTH_TOKEN_URL', 'PUBLIC_API_BASE_URL', 'PAYMENT_SECRETS_KEY']) {
      envBaseline[k] = m.env[k]
    }

    // Tudo que a aplicação manda para o logger, ANTES do redact (mais estrito que a saída final).
    for (const nivel of ['info', 'warn', 'error', 'debug'] as const) {
      const original = m.logger[nivel].bind(m.logger) as (...a: unknown[]) => void
      vi.spyOn(m.logger, nivel).mockImplementation(((...args: unknown[]) => {
        logsCapturados.push(dumpSeguro(args))
        original(...args)
      }) as never)
    }
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await new Promise<void>((resolve) => oauthServer?.close(() => resolve()))
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await adminPrisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${NOME_BANCO}" WITH (FORCE)`)
    await adminPrisma.$disconnect()
  }, 60_000)

  beforeEach(async () => {
    auditoria.falhar = false
    await m.prisma.paymentGatewayConfig.deleteMany()
    m.invalidarCacheConfigGateway()
    m.resetPagamentoPortCacheParaTeste()
    logsCapturados.length = 0
  })

  afterEach(() => {
    Object.assign(m.env, envBaseline)
  })

  async function novoUsuario(role: 'ADMIN' | 'OPERATOR' | 'DRIVER', label: string) {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    let operatorId: string | null = null
    if (role === 'OPERATOR') {
      const op = await m.prisma.operator.create({ data: { name: `Op ${sufixo}`, email: `op-${sufixo}@example.com` } })
      operatorId = op.id
    }
    const user = await m.prisma.user.create({ data: { role, name: `${label} ${sufixo}`, email: `${label}-${sufixo}@example.com`, operatorId } })
    return { id: user.id, token: m.issueToken({ id: user.id, role, operatorId }), email: user.email }
  }
  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })
  const get = (u: { token: string }) => request(app).get('/api/admin/payment-gateway').set(auth(u))
  const put = (u: { token: string }, body: Record<string, unknown>) => request(app).put('/api/admin/payment-gateway').set(auth(u)).send(body)

  /** Pré-requisitos só-de-servidor presentes (script/OAuth do SOP apontando pro servidor falso). */
  function servidorComPreRequisitosDeCartao() {
    m.env.CIELO_SOP_SCRIPT_URL = 'https://sop.example/script.js'
    m.env.CIELO_SOP_OAUTH_TOKEN_URL = `${oauthUrl}/token`
  }

  async function auditoriaDe(userId: string) {
    return m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
  }

  function expectSemSegredos(...fontes: unknown[]) {
    const texto = fontes.map((f) => (typeof f === 'string' ? f : dumpSeguro(f))).join('\n')
    for (const segredo of Object.values(SEGREDOS)) expect(texto).not.toContain(segredo)
  }

  // ----------------------------------------------------------------------------------------------
  describe('acesso: só ADMIN', () => {
    it('ADMIN lê (200); sem token 401; OPERATOR e DRIVER 403 — e só o OPERATOR gera linha DENIED (entidade PaymentGatewayConfig)', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const operador = await novoUsuario('OPERATOR', 'operador')
      const motorista = await novoUsuario('DRIVER', 'motorista')

      expect((await get(admin)).status).toBe(200)
      expect((await request(app).get('/api/admin/payment-gateway')).status).toBe(401)
      expect((await get(operador)).status).toBe(403)
      expect((await get(motorista)).status).toBe(403)

      expect((await put(operador, { cardEnabled: false })).status).toBe(403)
      expect((await put(motorista, { cardEnabled: false })).status).toBe(403)

      // a linha de auditoria é fire-and-forget (res.on('finish')): espera a do OPERATOR aparecer
      const deadline = Date.now() + 5000
      let linhasOperador = await auditoriaDe(operador.id)
      while (linhasOperador.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
        linhasOperador = await auditoriaDe(operador.id)
      }
      expect(linhasOperador).toHaveLength(1)
      expect(linhasOperador[0]).toMatchObject({ outcome: 'DENIED', httpStatus: 403, entityType: 'PaymentGatewayConfig', action: 'UPDATE', method: 'PUT', path: '/api/admin/payment-gateway' })
      await new Promise((r) => setTimeout(r, 300))
      expect(await auditoriaDe(motorista.id)).toHaveLength(0) // DRIVER em /api/admin nunca infla a tabela imutável
      expect(await auditoriaDe(admin.id)).toHaveLength(0) // GET do admin não audita
      expect(await m.prisma.paymentGatewayConfig.count()).toBe(0) // nenhuma tentativa negada gravou config
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('GET — config efetiva', () => {
    it('sem linha no banco: source "env", reflete o env do servidor, webhookUrl derivada do request, segredos só como "...Set"', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      m.env.CIELO_MERCHANT_ID = 'mid-do-env'
      m.env.CIELO_MERCHANT_KEY = SEGREDOS.merchantKey
      m.env.CIELO_SANDBOX = false

      const res = await get(admin)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        source: 'env',
        environment: 'production',
        merchantId: 'mid-do-env',
        merchantKeySet: true,
        sopClientId: null,
        sopClientSecretSet: false,
        webhookHeaderSecretSet: true,
        webhookHeaderName: 'x-innoelektron-webhook-secret',
        cardEnabled: true,
        pixEnabled: true,
        updatedAt: null,
      })
      expect(res.body.webhookUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/api/webhooks/cielo/${PATH_TOKEN}$`))
      expect(res.body.readiness.pix).toEqual({ ready: true, missing: [] })
      expect(res.body.readiness.card.missing).toEqual(['SOP_CLIENT_ID', 'SOP_CLIENT_SECRET', 'SOP_SCRIPT_URL', 'SOP_OAUTH_TOKEN_URL'])
      expectSemSegredos(res.body)
      expect(Object.keys(res.body).sort()).toEqual(
        ['source', 'environment', 'merchantId', 'merchantKeySet', 'sopClientId', 'sopClientSecretSet', 'webhookHeaderSecretSet', 'webhookUrl', 'webhookHeaderName', 'cardEnabled', 'pixEnabled', 'readiness', 'updatedAt'].sort(),
      )
    })

    it('PUBLIC_API_BASE_URL (env) ganha da derivação pelo request na webhookUrl', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      m.env.PUBLIC_API_BASE_URL = 'https://api.exemplo.com.br'
      const res = await get(admin)
      expect(res.body.webhookUrl).toBe(`https://api.exemplo.com.br/api/webhooks/cielo/${PATH_TOKEN}`)
    })

    it('webhookUrl é null quando o token de caminho do webhook não está configurado no servidor', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const original = m.env.CIELO_WEBHOOK_PATH_TOKEN
      m.env.CIELO_WEBHOOK_PATH_TOKEN = undefined
      try {
        const res = await get(admin)
        expect(res.body.webhookUrl).toBeNull()
        expect(res.body.readiness.pix.missing).toContain('WEBHOOK_PATH_TOKEN')
      } finally {
        m.env.CIELO_WEBHOOK_PATH_TOKEN = original
      }
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('PUT — validação e segredos', () => {
    it('corpo inválido: 400 VALIDATION_ERROR (campo desconhecido, vazio, segredo do webhook < 8, ambiente inválido)', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      for (const body of [{ merchantkey: 'x' }, {}, { webhookHeaderSecret: '1234567' }, { environment: 'staging' }, { confirmProduction: true }, { cardEnabled: 'sim' }]) {
        const res = await put(admin, body)
        expect(res.status, dumpSeguro(body)).toBe(400)
        expect(res.body.code).toBe('VALIDATION_ERROR')
      }
      expect(await m.prisma.paymentGatewayConfig.count()).toBe(0)
    })

    it('PAYMENT_SECRETS_KEY ausente + segredo no corpo => 503 PAYMENT_SECRETS_KEY_MISSING, nada gravado; sem segredo no corpo continua funcionando', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      m.env.PAYMENT_SECRETS_KEY = undefined
      const { resetPaymentSecretsKeyCacheParaTeste } = await import('../../src/lib/crypto/paymentSecrets')
      resetPaymentSecretsKeyCacheParaTeste()
      try {
        const bloqueado = await put(admin, { merchantId: 'mid', merchantKey: SEGREDOS.merchantKey })
        expect(bloqueado.status).toBe(503)
        expect(bloqueado.body.code).toBe('PAYMENT_SECRETS_KEY_MISSING')
        expect(await m.prisma.paymentGatewayConfig.count()).toBe(0)

        const semSegredo = await put(admin, { pixEnabled: false })
        expect(semSegredo.status).toBe(200)
        expect(semSegredo.body.readiness.card.missing).toContain('PAYMENT_SECRETS_KEY')
      } finally {
        m.env.PAYMENT_SECRETS_KEY = envBaseline.PAYMENT_SECRETS_KEY
        resetPaymentSecretsKeyCacheParaTeste()
      }
      expectSemSegredos(logsCapturados)
    })

    it('grava: devolve DTO atualizado só com "...Set"; ciphertext no banco != texto puro e faz round-trip; auditoria e log SEM nenhum segredo (nem cifrado)', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      servidorComPreRequisitosDeCartao()

      const res = await put(admin, {
        merchantId: 'mid-gravado',
        merchantKey: SEGREDOS.merchantKey,
        sopClientId: 'sop-id-gravado',
        sopClientSecret: SEGREDOS.sopClientSecret,
        webhookHeaderSecret: SEGREDOS.webhookHeaderSecret,
        pixEnabled: true,
        cardEnabled: true,
      })
      expect(res.status, dumpSeguro(res.body)).toBe(200)
      expect(res.body).toMatchObject({
        source: 'database',
        environment: 'sandbox',
        merchantId: 'mid-gravado',
        merchantKeySet: true,
        sopClientId: 'sop-id-gravado',
        sopClientSecretSet: true,
        webhookHeaderSecretSet: true,
        cardEnabled: true,
        pixEnabled: true,
      })
      expect(res.body.readiness.card).toEqual({ ready: true, missing: [] })
      expect(res.body.readiness.pix).toEqual({ ready: true, missing: [] })
      expect(typeof res.body.updatedAt).toBe('string')

      const row = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(row.merchantKeyCiphertext).not.toBe(SEGREDOS.merchantKey)
      expect(row.merchantKeyCiphertext).not.toContain(SEGREDOS.merchantKey)
      expect(m.decryptPaymentSecret(row.merchantKeyCiphertext!)).toBe(SEGREDOS.merchantKey)
      expect(m.decryptPaymentSecret(row.sopClientSecretCiphertext!)).toBe(SEGREDOS.sopClientSecret)
      expect(m.decryptPaymentSecret(row.webhookHeaderSecretCiphertext!)).toBe(SEGREDOS.webhookHeaderSecret)

      // GET depois: ainda sem segredo
      const lido = await get(admin)
      expect(lido.body).toMatchObject({ merchantKeySet: true, sopClientSecretSet: true, webhookHeaderSecretSet: true })

      // auditoria: UMA linha (o middleware genérico NÃO duplica), na mesma transação, sem segredo/ciphertext
      await new Promise((r) => setTimeout(r, 400))
      const linhas = await auditoriaDe(admin.id)
      expect(linhas).toHaveLength(1)
      expect(linhas[0]).toMatchObject({ action: 'PAYMENT_CONFIG_CHANGE', outcome: 'SUCCESS', httpStatus: 200, entityType: 'PaymentGatewayConfig', actorRole: 'ADMIN', actorEmail: admin.email })
      const changes = linhas[0].changes as Record<string, unknown>
      expect(changes.merchantKey).toEqual({ changed: true })
      expect(changes.sopClientSecret).toEqual({ changed: true })
      expect(changes.webhookHeaderSecret).toEqual({ changed: true })
      expect(changes.merchantId).toEqual({ from: null, to: 'mid-gravado' })
      expect(changes.source).toEqual({ from: 'env', to: 'database' })
      expect(changes.pixEnabled).toBeDefined()
      expectSemSegredos(res.body, lido.body, linhas, logsCapturados)
      for (const cifrado of [row.merchantKeyCiphertext, row.sopClientSecretCiphertext, row.webhookHeaderSecretCiphertext]) {
        expect(dumpSeguro(linhas)).not.toContain(cifrado!)
        expect(logsCapturados.join('\n')).not.toContain(cifrado!)
        expect(dumpSeguro([res.body, lido.body])).not.toContain(cifrado!)
      }
    })

    it('campo ausente = não mexer: um PUT parcial preserva os segredos já gravados (ciphertext idêntico) e audita só o que mudou', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      await put(admin, { merchantId: 'm1', merchantKey: SEGREDOS.merchantKey })
      const antes = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })

      const res = await put(admin, { merchantId: 'm2' })
      expect(res.status).toBe(200)
      const depois = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(depois.merchantKeyCiphertext).toBe(antes.merchantKeyCiphertext)
      expect(res.body.merchantKeySet).toBe(true)

      await new Promise((r) => setTimeout(r, 300))
      const linhas = await auditoriaDe(admin.id)
      expect(linhas).toHaveLength(2)
      const changes = linhas[1].changes as Record<string, unknown>
      expect(Object.keys(changes)).toEqual(['merchantId'])
      expect(changes.merchantId).toEqual({ from: 'm1', to: 'm2' })
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('auditoria FAIL-CLOSED', () => {
    it('se a auditoria falha, NADA é gravado: primeira gravação não deixa linha; gravação seguinte deixa a config exatamente como estava', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')

      auditoria.falhar = true
      const primeira = await put(admin, { merchantId: 'nao-deve-gravar', merchantKey: SEGREDOS.merchantKey })
      expect(primeira.status).toBe(500)
      expect(await m.prisma.paymentGatewayConfig.count()).toBe(0) // nem a linha semeada sobrevive ao rollback

      auditoria.falhar = false
      expect((await put(admin, { merchantId: 'valor-original', merchantKey: SEGREDOS.merchantKey })).status).toBe(200)
      const antes = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })

      auditoria.falhar = true
      const segunda = await put(admin, { merchantId: 'valor-que-nao-pode-valer', merchantKey: 'OUTRA-CHAVE-que-nao-pode-valer', pixEnabled: true })
      expect(segunda.status).toBe(500)
      auditoria.falhar = false

      const depois = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(depois).toEqual(antes) // idêntica, inclusive updatedAt e ciphertext
      const lido = await get(admin)
      expect(lido.body.merchantId).toBe('valor-original')
      expectSemSegredos(primeira.body, segunda.body, logsCapturados)
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('produção: confirmação + readiness do estado resultante', () => {
    it('sandbox -> production sem confirmProduction: 400 PRODUCTION_CONFIRMATION_REQUIRED e nada muda', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      await put(admin, { merchantId: 'm' }).then((r) => expect(r.status).toBe(409)) // par pela metade é recusado (sem chave em lugar nenhum)
      expect((await put(admin, { pixEnabled: false })).status).toBe(200) // cria a linha (sandbox)
      const antes = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })

      const res = await put(admin, { environment: 'production' })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('PRODUCTION_CONFIRMATION_REQUIRED')
      expect(await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })).toEqual(antes)
    })

    it('com confirmação mas meio habilitado SEM pré-requisitos: 409 GATEWAY_NOT_READY com a lista de requisitos em `details`; com tudo pronto: 200', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      expect((await put(admin, { pixEnabled: false, cardEnabled: false })).status).toBe(200)

      const naoPronto = await put(admin, { environment: 'production', confirmProduction: true, pixEnabled: true })
      expect(naoPronto.status).toBe(409)
      expect(naoPronto.body.code).toBe('GATEWAY_NOT_READY')
      expect(naoPronto.body.details).toEqual(['MERCHANT_ID', 'MERCHANT_KEY'])
      expect((await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })).environment).toBe('sandbox')

      const pronto = await put(admin, { environment: 'production', confirmProduction: true, pixEnabled: true, merchantId: 'mid-prod', merchantKey: SEGREDOS.merchantKey })
      expect(pronto.status, dumpSeguro(pronto.body)).toBe(200)
      expect(pronto.body).toMatchObject({ environment: 'production', pixEnabled: true, cardEnabled: false })

      await new Promise((r) => setTimeout(r, 300))
      const ultima = (await auditoriaDe(admin.id)).at(-1)!
      expect((ultima.changes as Record<string, unknown>).environment).toEqual({ from: 'sandbox', to: 'production' })
    })

    it('habilitar um meio sem pré-requisitos (cartão sem SOP) é 409 mesmo em sandbox', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const res = await put(admin, { merchantId: 'm', merchantKey: SEGREDOS.merchantKey, cardEnabled: true })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('GATEWAY_NOT_READY')
      expect(res.body.details).toEqual(['SOP_CLIENT_ID', 'SOP_CLIENT_SECRET', 'SOP_SCRIPT_URL', 'SOP_OAUTH_TOKEN_URL'])
      expect(await m.prisma.paymentGatewayConfig.count()).toBe(0)
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('banco > env, ambiente -> URLs, credencial trocada passa a valer', () => {
    type Interno = { config: { merchantId: string; sandbox: boolean }; client: { config: { apiBaseUrl: string; apiQueryBaseUrl: string; merchantKey: string } } }

    it('sem linha vale o env; depois de gravar no banco a credencial do BANCO é a usada; trocar de novo vale NA HORA (invalidação), sem esperar o TTL', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      m.env.CIELO_MERCHANT_ID = 'mid-do-env'
      m.env.CIELO_MERCHANT_KEY = 'chave-do-env'

      const doEnv = (await m.getPagamentoPort()) as unknown as Interno
      expect(doEnv.config.merchantId).toBe('mid-do-env')
      expect(doEnv.client.config.merchantKey).toBe('chave-do-env')
      expect(m.isUsandoFakeAdapter()).toBe(false)

      expect((await put(admin, { merchantId: 'mid-A', merchantKey: 'chave-A-12345' })).status).toBe(200)
      const a = (await m.getPagamentoPort()) as unknown as Interno
      expect(a.config.merchantId).toBe('mid-A')
      expect(a.client.config.merchantKey).toBe('chave-A-12345')

      expect((await put(admin, { merchantId: 'mid-B', merchantKey: 'chave-B-12345' })).status).toBe(200)
      const b = (await m.getPagamentoPort()) as unknown as Interno
      expect(b.config.merchantId).toBe('mid-B')
      expect(b.client.config.merchantKey).toBe('chave-B-12345')
      expect(b).not.toBe(a)
    })

    it('o par de credencial não mistura: salvar só o merchantId (chave vinda do env) é recusado; salvar uma flag qualquer preserva a credencial do env', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      m.env.CIELO_MERCHANT_ID = 'mid-do-env'
      m.env.CIELO_MERCHANT_KEY = 'chave-do-env'
      const parcial = await put(admin, { merchantId: 'outro-id' })
      expect(parcial.status).toBe(409)
      expect(parcial.body.details).toEqual(['MERCHANT_KEY'])

      const flag = await put(admin, { pixEnabled: true })
      expect(flag.status).toBe(200)
      expect(flag.body).toMatchObject({ source: 'database', merchantId: 'mid-do-env', merchantKeySet: true, pixEnabled: true, cardEnabled: true }) // semeado: "habilitado = há credenciais"
      expect(((await m.getPagamentoPort()) as unknown as Interno).config.merchantId).toBe('mid-do-env')
    })

    it('o ambiente do banco decide o flag sandbox E as URLs (production => hosts de produção; sandbox => hosts de sandbox)', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      expect((await put(admin, { merchantId: 'm', merchantKey: 'k-12345678', pixEnabled: true })).status).toBe(200)
      const sandbox = (await m.getPagamentoPort()) as unknown as Interno
      expect(sandbox.config.sandbox).toBe(true)
      expect(sandbox.client.config.apiBaseUrl).toBe('https://apisandbox.cieloecommerce.cielo.com.br')
      expect(sandbox.client.config.apiQueryBaseUrl).toBe('https://apiquerysandbox.cieloecommerce.cielo.com.br')

      const res = await put(admin, { environment: 'production', confirmProduction: true })
      expect(res.status, dumpSeguro(res.body)).toBe(200)
      const producao = (await m.getPagamentoPort()) as unknown as Interno
      expect(producao.config.sandbox).toBe(false)
      expect(producao.client.config.apiBaseUrl).toBe('https://api.cieloecommerce.cielo.com.br')
      expect(producao.client.config.apiQueryBaseUrl).toBe('https://apiquery.cieloecommerce.cielo.com.br')
    })

    it('banco diz production mas o servidor tem CIELO_API_BASE_URL EXPLÍCITA de sandbox: recusa em vez de seguir sandbox em silêncio (503 nas rotas)', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const motorista = await novoUsuario('DRIVER', 'motorista')
      expect((await put(admin, { merchantId: 'm', merchantKey: 'k-12345678', pixEnabled: true, environment: 'production', confirmProduction: true })).status).toBe(200)
      process.env.CIELO_API_BASE_URL = 'https://apisandbox.cieloecommerce.cielo.com.br'
      try {
        await expect(m.getPagamentoPort()).rejects.toThrow(/incoerente/i)
        const res = await request(app).post('/api/me/wallet/topups').set(auth(motorista)).send({ amountCents: 2000 })
        expect(res.status).toBe(503)
        expect(res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
      } finally {
        delete process.env.CIELO_API_BASE_URL
      }
    })

    it('a sessão de tokenização devolve o `environment` EFETIVO (banco) e o merchantId do banco', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const motorista = await novoUsuario('DRIVER', 'motorista')
      servidorComPreRequisitosDeCartao()

      const salvar = await put(admin, { merchantId: 'mid-tokenizacao', merchantKey: SEGREDOS.merchantKey, sopClientId: 'sop', sopClientSecret: SEGREDOS.sopClientSecret, cardEnabled: true })
      expect(salvar.status, dumpSeguro(salvar.body)).toBe(200)
      const sandbox = await request(app).post('/api/me/payment-methods/tokenization-session').set(auth(motorista))
      expect(sandbox.status, dumpSeguro(sandbox.body)).toBe(200)
      expect(sandbox.body).toMatchObject({ environment: 'sandbox', merchantId: 'mid-tokenizacao', accessToken: 'access-token-falso' })

      expect((await put(admin, { environment: 'production', confirmProduction: true })).status).toBe(200)
      const producao = await request(app).post('/api/me/payment-methods/tokenization-session').set(auth(motorista))
      expect(producao.status).toBe(200)
      expect(producao.body.environment).toBe('production')
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('flags cardEnabled / pixEnabled bloqueiam só COMEÇOS novos (409 PAYMENT_METHOD_DISABLED)', () => {
    it('cardEnabled=false: tokenization-session, POST payment-methods e sessions/start (CARD) => 409; a carteira continua passando pela guarda', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const motorista = await novoUsuario('DRIVER', 'motorista')
      expect((await put(admin, { cardEnabled: false, pixEnabled: false })).status).toBe(200)

      const sessao = await request(app).post('/api/me/payment-methods/tokenization-session').set(auth(motorista))
      const cadastro = await request(app).post('/api/me/payment-methods').set(auth(motorista)).send({ cardToken: 'token-qualquer', brand: 'Visa' })
      const inicio = await request(app).post('/api/me/sessions/start').set(auth(motorista)).send({ ocppIdentity: 'cp-inexistente', connectorId: 1, payment: { mode: 'CARD', paymentMethodId: 'cabcdefghijklmnopqrstuvwx' } })
      for (const res of [sessao, cadastro, inicio]) {
        expect(res.status, dumpSeguro(res.body)).toBe(409)
        expect(res.body.code).toBe('PAYMENT_METHOD_DISABLED')
        expect(res.body.details).toEqual([{ method: 'CARD', reason: 'GATEWAY_DISABLED' }])
      }

      // carteira não é bloqueada pela flag do cartão: chega até a checagem do carregador (404), não 409 DISABLED
      const carteira = await request(app).post('/api/me/sessions/start').set(auth(motorista)).send({ ocppIdentity: 'cp-inexistente', connectorId: 1, payment: { mode: 'WALLET' } })
      expect(carteira.status).toBe(404)
      expect(carteira.body.code).toBe('CHARGE_POINT_NOT_FOUND')
    })

    it('pixEnabled=false: POST wallet/topups => 409; a flag do cartão ligada não destrava o Pix', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const motorista = await novoUsuario('DRIVER', 'motorista')
      expect((await put(admin, { cardEnabled: false, pixEnabled: false })).status).toBe(200)
      const res = await request(app).post('/api/me/wallet/topups').set(auth(motorista)).send({ amountCents: 2000 })
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ code: 'PAYMENT_METHOD_DISABLED', details: [{ method: 'PIX', reason: 'GATEWAY_DISABLED' }] })
    })

    it('flags ligadas (e SEM linha no banco) deixam passar — preserva o comportamento anterior (Fake em dev/CI)', async () => {
      const motorista = await novoUsuario('DRIVER', 'motorista')
      const semLinha = await request(app).post('/api/me/wallet/topups').set(auth(motorista)).send({ amountCents: 2000 })
      expect(semLinha.status, dumpSeguro(semLinha.body)).toBe(201)
      const sessao = await request(app).post('/api/me/payment-methods/tokenization-session').set(auth(motorista))
      expect(sessao.status).not.toBe(409)

      await m.prisma.paymentGatewayConfig.create({ data: { environment: 'sandbox', cardEnabled: true, pixEnabled: true } })
      m.invalidarCacheConfigGateway()
      const comLinha = await request(app).post('/api/me/wallet/topups').set(auth(motorista)).send({ amountCents: 2000 })
      expect(comLinha.status === 201 || comLinha.status === 409).toBe(true)
      expect(comLinha.body.code).not.toBe('PAYMENT_METHOD_DISABLED')
    })

    it('com o Pix desligado, o que já está em trânsito LIQUIDA: webhook segue aceito (200) e o crédito de um Pix já pago continua funcionando', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const motorista = await novoUsuario('DRIVER', 'motorista')
      const adapter = (await m.getPagamentoPort()) as InstanceType<Mods['FakeAdapter']>
      expect(adapter).toBeInstanceOf(m.FakeAdapter)

      const wallet = await m.prisma.wallet.create({ data: { userId: motorista.id } })
      const pix = await adapter.criarPix({ merchantOrderId: 'em-transito', amountRequestedCents: 3000, cliente: { name: 'Motorista' } })
      const intent = await m.prisma.paymentIntent.create({
        data: { purpose: 'WALLET_TOPUP_PIX', provider: 'CIELO_PIX', userId: motorista.id, walletId: wallet.id, amountRequestedCents: 3000, status: 'PENDING', cieloPaymentId: pix.providerPaymentId, pixQrCode: pix.qrCodeString, pixExpiresAt: pix.expiresAt },
      })

      expect((await put(admin, { cardEnabled: false, pixEnabled: false })).status).toBe(200)

      const webhook = await request(app).post(`/api/webhooks/cielo/${PATH_TOKEN}`).set('x-innoelektron-webhook-secret', ENV_HEADER_SECRET).send({ PaymentId: pix.providerPaymentId, ChangeType: 1 })
      expect(webhook.status).toBe(200)

      adapter.marcarPixComoPago(pix.providerPaymentId)
      const resultado = await m.creditarTopupPix(intent.id, adapter)
      expect(resultado?.totalCreditedCents).toBe(3000)
      expect((await m.prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PAID')
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('webhook: segredo do header vem da config efetiva', () => {
    const post = (header: string | undefined) => {
      const req = request(app).post(`/api/webhooks/cielo/${PATH_TOKEN}`).send({ PaymentId: 'pagamento-desconhecido', ChangeType: 1 })
      return header === undefined ? req : req.set('x-innoelektron-webhook-secret', header)
    }

    it('banco (decifrado) > env: depois de gravar, só o segredo do banco vale; o do env deixa de valer; sem header e header errado = 401', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      expect((await post(ENV_HEADER_SECRET)).status).toBe(200) // sem linha: segredo do env, comportamento atual preservado

      expect((await put(admin, { webhookHeaderSecret: SEGREDOS.webhookHeaderSecret })).status).toBe(200)
      expect((await post(SEGREDOS.webhookHeaderSecret)).status).toBe(200)
      expect((await post(ENV_HEADER_SECRET)).status).toBe(401)
      expect((await post('segredo-errado-1234')).status).toBe(401)
      expect((await post(undefined)).status).toBe(401)
    })

    it('FAIL-CLOSED: segredo do banco que não decifra => 503 (nunca aceita nem o do env), e o adaptador também não cai no Fake', async () => {
      await m.prisma.paymentGatewayConfig.create({ data: { environment: 'sandbox', webhookHeaderSecretCiphertext: 'isto-nao-e-um-ciphertext-valido', merchantId: 'm', merchantKeyCiphertext: 'tambem-corrompido' } })
      m.invalidarCacheConfigGateway()
      expect((await post(ENV_HEADER_SECRET)).status).toBe(503)
      await expect(m.getPagamentoPort()).rejects.toBeInstanceOf(m.ConfiguracaoGatewayIndisponivelError)
      expect(m.isUsandoFakeAdapter()).toBe(false)
    })
  })

  // ----------------------------------------------------------------------------------------------
  describe('concorrência e rate limit', () => {
    it('dois PUTs simultâneos se serializam (FOR UPDATE): nenhum sobrescreve o outro e há duas linhas de auditoria', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const admin2 = await novoUsuario('ADMIN', 'admin2')
      const [r1, r2] = await Promise.all([put(admin, { sopClientId: 'sop-1', pixEnabled: false }), put(admin2, { merchantId: 'm-concorrente', merchantKey: SEGREDOS.merchantKey })])
      expect([r1.status, r2.status]).toEqual([200, 200])
      const row = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(row.sopClientId).toBe('sop-1')
      expect(row.merchantId).toBe('m-concorrente')
      expect(row.merchantKeyCiphertext).not.toBeNull()
      await new Promise((r) => setTimeout(r, 400))
      expect(await auditoriaDe(admin.id)).toHaveLength(1)
      expect(await auditoriaDe(admin2.id)).toHaveLength(1)
    })

    it('rate limit do PUT: 429 RATE_LIMITED_PAYMENT_GATEWAY depois de 10 tentativas/minuto do mesmo ADMIN (por usuário, não por IP)', async () => {
      const admin = await novoUsuario('ADMIN', 'admin')
      const outro = await novoUsuario('ADMIN', 'outro')
      const statuses: number[] = []
      for (let i = 0; i < 11; i += 1) statuses.push((await put(admin, {})).status) // 400 de validação também conta no balde
      expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true)
      expect(statuses[10]).toBe(429)
      expect((await put(outro, {})).status).toBe(400) // outro admin, mesmo IP: balde próprio
    })
  })
})
