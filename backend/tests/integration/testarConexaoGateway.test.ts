import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { createUser, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * C2.1 — `POST /api/admin/payment-gateway/test-connection`, Postgres + Redis reais. A "Cielo" e a "Braspag" são servidores HTTP locais (nada sai da máquina);
 * as credenciais vêm do ENV do processo (origem `env`), o que exercita o mesmo caminho de decifrar/URLs sem gravar o singleton `PaymentGatewayConfig`
 * (as outras suítes dependem dele — ver `padrao-singleton-global-em-suite-paralela`).
 */

const SEGREDOS = { merchantKey: 'MKEY-SEGREDO-DO-TESTE-0001', sopSecret: 'SOP-SEGREDO-DO-TESTE-0002', oauthToken: 'OAUTH-TOKEN-DO-TESTE-0003', accessToken: 'ACCESS-TOKEN-DO-TESTE-0004', eco: 'ECO-DA-CIELO-0005' }

type ModoCielo = 'ok200' | 'ok404' | 'chaveErrada400' | 'ip403' | 'fora503' | 'outro400' | 'limite429' | 'lento'
type ModoOauth = 'ok' | 'invalid_client' | 'outro400'
type ModoAccess = 'ok' | 'sem401' | 'erro500'

describe('POST /api/admin/payment-gateway/test-connection (C2.1)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let cielo: Server
  let braspag: Server
  let cieloUrl = ''
  let braspagUrl = ''
  let modoCielo: ModoCielo = 'ok200'
  let modoOauth: ModoOauth = 'ok'
  let modoAccess: ModoAccess = 'ok'
  let chamadasCielo: Array<{ url: string; merchantKey: string | undefined }> = []
  let chamadasBraspag: string[] = []
  let admin: Awaited<ReturnType<typeof createUser>>

  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }

  beforeAll(async () => {
    cielo = createServer((req, res) => {
      chamadasCielo.push({ url: req.url ?? '', merchantKey: req.headers.merchantkey as string | undefined })
      res.setHeader('content-type', 'application/json')
      switch (modoCielo) {
        case 'ok200':
          res.end(JSON.stringify({ Payments: [] }))
          return
        case 'ok404':
          res.statusCode = 404
          res.end(JSON.stringify({ Message: 'not found' }))
          return
        case 'chaveErrada400':
          res.statusCode = 400
          res.end(JSON.stringify([{ Code: 132, Message: `MerchantKey is invalid ${SEGREDOS.eco}` }]))
          return
        case 'ip403':
          res.statusCode = 403
          res.end(JSON.stringify({ Message: SEGREDOS.eco }))
          return
        case 'fora503':
          res.statusCode = 503
          res.end('indisponivel')
          return
        case 'outro400':
          res.statusCode = 400
          res.end(JSON.stringify([{ Code: 126, Message: SEGREDOS.eco }]))
          return
        case 'limite429':
          res.statusCode = 429
          res.end('{}')
          return
        case 'lento':
          return // nunca responde: o timeout do cliente (CIELO_TIMEOUT_MS) é o que encerra
      }
    })
    braspag = createServer((req, res) => {
      chamadasBraspag.push(req.url ?? '')
      res.setHeader('content-type', 'application/json')
      if (req.url?.startsWith('/oauth2/token')) {
        if (modoOauth === 'invalid_client') {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'invalid_client', error_description: SEGREDOS.eco }))
          return
        }
        if (modoOauth === 'outro400') {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'unsupported_grant_type' }))
          return
        }
        res.end(JSON.stringify({ access_token: SEGREDOS.oauthToken, expires_in: 599 }))
        return
      }
      if (modoAccess === 'sem401') {
        res.statusCode = 401
        res.end()
        return
      }
      if (modoAccess === 'erro500') {
        res.statusCode = 500
        res.end(SEGREDOS.eco)
        return
      }
      res.end(JSON.stringify({ AccessToken: SEGREDOS.accessToken, ExpiresIn: 1200 }))
    })
    await Promise.all([
      new Promise<void>((r) => cielo.listen(0, '127.0.0.1', r)),
      new Promise<void>((r) => braspag.listen(0, '127.0.0.1', r)),
    ])
    cieloUrl = `http://127.0.0.1:${(cielo.address() as AddressInfo).port}`
    braspagUrl = `http://127.0.0.1:${(braspag.address() as AddressInfo).port}`
  }, 30_000)

  // Um ADMIN novo por teste: o limite de 6/min é por usuário e este arquivo faz mais de 6 chamadas no total.
  let contadorAdmin = 0
  beforeEach(async () => {
    contadorAdmin += 1
    admin = await createUser({ role: 'ADMIN', label: `admin-testconn-${contadorAdmin}`, suffix })
  })

  afterEach(() => {
    Object.assign(env, baseline)
    process.env.CIELO_API_BASE_URL = processEnvBaseline.api
    process.env.CIELO_API_QUERY_BASE_URL = processEnvBaseline.query
    if (processEnvBaseline.api === undefined) delete process.env.CIELO_API_BASE_URL
    if (processEnvBaseline.query === undefined) delete process.env.CIELO_API_QUERY_BASE_URL
    resetGatewayConfigCacheParaTeste()
    chamadasCielo = []
    chamadasBraspag = []
    modoCielo = 'ok200'
    modoOauth = 'ok'
    modoAccess = 'ok'
  })

  afterAll(async () => {
    await Promise.all([new Promise((r) => cielo.close(r)), new Promise((r) => braspag.close(r))])
    await prisma.$disconnect()
    redis.disconnect()
  })

  /** Credenciais completas no ENV, apontando para os servidores falsos (sandbox: host customizado passa na checagem de coerência). */
  function configurarTudo() {
    const e = env as Record<string, unknown>
    e.CIELO_MERCHANT_ID = 'merchant-id-do-teste'
    e.CIELO_MERCHANT_KEY = SEGREDOS.merchantKey
    e.CIELO_SOP_CLIENT_ID = 'sop-client-id'
    e.CIELO_SOP_CLIENT_SECRET = SEGREDOS.sopSecret
    e.CIELO_SOP_OAUTH_TOKEN_URL = `${braspagUrl}/oauth2/token`
    e.CIELO_SOP_ACCESS_TOKEN_URL = `${braspagUrl}/post/api/public/v2/accesstoken`
    e.CIELO_TIMEOUT_MS = 400
    process.env.CIELO_API_BASE_URL = cieloUrl
    process.env.CIELO_API_QUERY_BASE_URL = cieloUrl
  }

  const testar = (token = admin.token) => request(app).post('/api/admin/payment-gateway/test-connection').set('Authorization', `Bearer ${token}`)
  const passo = (body: { steps: Array<{ step: string }> }, nome: string) => body.steps.find((s) => s.step === nome) as { step: string; status: string; host: string | null; httpStatus: number | null; durationMs: number; message: string }

  function semSegredos(body: unknown) {
    const texto = JSON.stringify(body)
    for (const segredo of Object.values(SEGREDOS)) expect(texto, `vazou ${segredo}`).not.toContain(segredo)
  }

  it('tudo certo: 3 passos OK, ok=true, só o HOST aparece, e a consulta de teste é de leitura (GET) com a MerchantKey no header — nenhum segredo/token volta', async () => {
    configurarTudo()
    const res = await testar()
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ environment: 'sandbox', ok: true })
    expect(new Date(res.body.testedAt).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(res.body.steps.map((s: { step: string }) => s.step)).toEqual(['MERCHANT_CREDENTIALS', 'SOP_OAUTH', 'SOP_ACCESS_TOKEN'])
    for (const s of res.body.steps) {
      expect(s.status).toBe('OK')
      expect(typeof s.durationMs).toBe('number')
    }
    expect(passo(res.body, 'MERCHANT_CREDENTIALS').host).toBe(new URL(cieloUrl).host)
    expect(passo(res.body, 'SOP_OAUTH').host).toBe(new URL(braspagUrl).host)
    expect(chamadasCielo).toHaveLength(1)
    expect(chamadasCielo[0].url).toMatch(/^\/1\/sales\?merchantOrderId=innoflow-teste-conexao-/)
    expect(chamadasCielo[0].merchantKey).toBe(SEGREDOS.merchantKey)
    semSegredos(res.body)
  })

  it('a venda inexistente voltando 404 também prova a credencial (a Cielo valida antes de procurar)', async () => {
    configurarTudo()
    modoCielo = 'ok404'
    const res = await testar()
    expect(passo(res.body, 'MERCHANT_CREDENTIALS')).toMatchObject({ status: 'OK', httpStatus: 404 })
  })

  it.each([
    ['chaveErrada400', 'CREDENTIAL_REJECTED', 400],
    ['ip403', 'IP_NOT_ALLOWED', 403],
    ['fora503', 'UNAVAILABLE', 503],
    ['limite429', 'RATE_LIMITED', 429],
    ['outro400', 'REQUEST_REFUSED', 400],
  ] as const)('Cielo responde %s -> passo MERCHANT_CREDENTIALS = %s (ok=false, sem vazar o corpo da Cielo)', async (modo, status, http) => {
    configurarTudo()
    modoCielo = modo
    const res = await testar()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(passo(res.body, 'MERCHANT_CREDENTIALS')).toMatchObject({ status, httpStatus: http })
    semSegredos(res.body)
  })

  it('403 explica que a causa mais comum é o IP de saída fora da lista de IPs confiáveis e manda conferir ANTES de apagar a credencial; 400/132 cita o ambiente', async () => {
    configurarTudo()
    modoCielo = 'ip403'
    const ip = passo((await testar()).body, 'MERCHANT_CREDENTIALS')
    expect(ip.message).toMatch(/lista de IPs confiáveis/)
    expect(ip.message).toMatch(/ANTES de trocar ou apagar a credencial/)
    modoCielo = 'chaveErrada400'
    const cred = passo((await testar()).body, 'MERCHANT_CREDENTIALS')
    expect(cred.message).toMatch(/AMBIENTE/)
    expect(cred.message).toContain('132')
  })

  it('timeout da Cielo -> UNAVAILABLE (e o teste termina — não pendura)', async () => {
    configurarTudo()
    modoCielo = 'lento'
    const res = await testar()
    expect(res.status).toBe(200)
    expect(passo(res.body, 'MERCHANT_CREDENTIALS').status).toBe('UNAVAILABLE')
  })

  it('SOP: invalid_client no OAuth -> CREDENTIAL_REJECTED e o passo 2 fica SKIPPED (nem é chamado); 400 com outro error -> REQUEST_REFUSED', async () => {
    configurarTudo()
    modoOauth = 'invalid_client'
    const res = await testar()
    expect(passo(res.body, 'SOP_OAUTH')).toMatchObject({ status: 'CREDENTIAL_REJECTED', httpStatus: 400 })
    expect(passo(res.body, 'SOP_ACCESS_TOKEN').status).toBe('SKIPPED')
    expect(chamadasBraspag).toHaveLength(1)
    expect(res.body.ok).toBe(false)
    semSegredos(res.body)

    modoOauth = 'outro400'
    expect(passo((await testar()).body, 'SOP_OAUTH').status).toBe('REQUEST_REFUSED')
  })

  it('SOP passo 2: 401 -> CREDENTIAL_REJECTED; 500 -> UNAVAILABLE (e o token do passo 1 nunca volta)', async () => {
    configurarTudo()
    modoAccess = 'sem401'
    const r401 = await testar()
    expect(passo(r401.body, 'SOP_OAUTH').status).toBe('OK')
    expect(passo(r401.body, 'SOP_ACCESS_TOKEN')).toMatchObject({ status: 'CREDENTIAL_REJECTED', httpStatus: 401 })
    semSegredos(r401.body)
    modoAccess = 'erro500'
    const r500 = await testar()
    expect(passo(r500.body, 'SOP_ACCESS_TOKEN')).toMatchObject({ status: 'UNAVAILABLE', httpStatus: 500 })
    semSegredos(r500.body)
  })

  it('sem credencial nenhuma: tudo NOT_CONFIGURED, ok=false, e NENHUMA chamada de rede', async () => {
    const e = env as Record<string, unknown>
    e.CIELO_MERCHANT_ID = undefined
    e.CIELO_MERCHANT_KEY = undefined
    e.CIELO_SOP_CLIENT_ID = undefined
    e.CIELO_SOP_CLIENT_SECRET = undefined
    const res = await testar()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.steps.map((s: { status: string }) => s.status)).toEqual(['NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED'])
    expect(chamadasCielo).toHaveLength(0)
    expect(chamadasBraspag).toHaveLength(0)
  })

  it('só a credencial da loja (sem par SOP): o passo da loja roda e os do SOP são NOT_CONFIGURED; ok=true (não configurado não é falha)', async () => {
    configurarTudo()
    const e = env as Record<string, unknown>
    e.CIELO_SOP_CLIENT_ID = undefined
    e.CIELO_SOP_CLIENT_SECRET = undefined
    const res = await testar()
    expect(passo(res.body, 'MERCHANT_CREDENTIALS').status).toBe('OK')
    expect(passo(res.body, 'SOP_OAUTH').status).toBe('NOT_CONFIGURED')
    expect(passo(res.body, 'SOP_ACCESS_TOKEN').status).toBe('NOT_CONFIGURED')
    expect(res.body.ok).toBe(true)
  })

  it('ambiente sandbox com URL OFICIAL de produção: MISCONFIGURED e nenhuma chamada sai (cobrança/consulta no host errado é o erro que não pode acontecer)', async () => {
    configurarTudo()
    process.env.CIELO_API_QUERY_BASE_URL = 'https://apiquery.cieloecommerce.cielo.com.br'
    const res = await testar()
    expect(passo(res.body, 'MERCHANT_CREDENTIALS').status).toBe('MISCONFIGURED')
    expect(chamadasCielo).toHaveLength(0)
    expect(res.body.ok).toBe(false)
  })

  it('só ADMIN: sem token 401; OPERATOR e DRIVER 403', async () => {
    expect((await request(app).post('/api/admin/payment-gateway/test-connection')).status).toBe(401)
    const driver = await createUser({ role: 'DRIVER', label: 'driver-testconn', suffix })
    expect((await testar(driver.token)).status).toBe(403)
  })

  it('auditoria: uma linha OTHER com o resumo do resultado, sem segredo', async () => {
    configurarTudo()
    modoCielo = 'ip403'
    const res = await testar()
    expect(res.status).toBe(200)
    const linha = await waitFor(async () => prisma.auditLog.findFirst({ where: { actorUserId: admin.id, action: 'OTHER', actionDetail: { startsWith: 'test_connection' } }, orderBy: { occurredAt: 'desc' } }), { what: 'linha de auditoria do teste' })
    expect(linha).toMatchObject({ outcome: 'SUCCESS', httpStatus: 200, method: 'POST', entityType: 'PaymentGatewayConfig' })
    expect(linha.actionDetail).toBe('test_connection:MERCHANT_CREDENTIALS=IP_NOT_ALLOWED')
    semSegredos(linha)
  })

  it('rate limit próprio (6/min por ADMIN): a 7ª chamada seguida é 429 RATE_LIMITED_PAYMENT_GATEWAY', async () => {
    const outro = await createUser({ role: 'ADMIN', label: 'admin-testconn-rl', suffix })
    const status: number[] = []
    for (let i = 0; i < 7; i++) status.push((await testar(outro.token)).status)
    expect(status.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200])
    expect(status[6]).toBe(429)
  })
})
