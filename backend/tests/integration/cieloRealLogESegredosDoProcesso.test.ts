import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis, createRedisConnection } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { encryptPaymentSecret } from '../../src/lib/crypto/paymentSecrets'
import { createApp } from '../../src/api/app'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { BraspagFalsa, CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa, criarCenarioCartaoHttp } from './helpers/cenarioCartaoHttp'
import { createTenant, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * Íris (C2.1/C2.2, 04/10/2026) — LOG REAL do servidor e dos fluxos de pagamento da Cielo, com `NODE_ENV=production`, `LOG_LEVEL=info` e `pino-pretty` de verdade, contra uma
 * Cielo/Braspag FALSAS que ECOAM o payload nos erros (como a Cielo real pode fazer) e devolvem um corpo completo com PAN mascarado/Holder em `GET /1/card/{token}`.
 * Dois tipos de processo-filho:
 *   - o SERVIDOR (`src/entrypoints/api.ts`): cadastro de cartão (inclui `GET /1/card/{token}`), sessão de tokenização (OAuth + accesstoken), pré-autorização, void por
 *     RemoteStart recusado, teste de conexão, webhook;
 *   - FLUXOS (`helpers/cieloFluxoProcesso.ts`): captura, cancelamento, varredor — o que roda no worker.
 * O stdout/stderr INTEIRO de todos é varrido atrás de cada segredo/identificador/corpo. CONTROLES POSITIVOS provam que o log existe (senão "não vazou" seria vazio).
 */

const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_real_log')
})


const SEGREDOS = {
  merchantKey: 'merchant-key-iris-real-0001',
  sopSecret: 'SOP-SECRET-LOG-REAL-qq11',
  oauthToken: 'OAUTH-TOKEN-FALSO-PASSO-1',
  accessToken: 'ACCESS-TOKEN-FALSO-PASSO-2',
  webhookHeader: 'WEBHOOK-HEADER-SEGREDO-LOG-REAL-0123456789abcd',
  webhookPath: 'webhook-path-token-log-real-0123456789abcdef',
  holder: 'MOTORISTA FALSO',
  cardNumberMascarado: '453904******4242',
  eco: 'ECO-DE-PAYLOAD-NA-ERRO-DA-CIELO',
}
const TOKEN_CARTAO_200 = 'CARDTOKEN-CADASTRO-200-aaaa-1111'
const TOKEN_CARTAO_404 = 'CARDTOKEN-CADASTRO-404-bbbb-2222'
const TOKEN_CARTAO_500 = 'CARDTOKEN-CADASTRO-500-cccc-3333'
const TOKEN_NO_CAPTURE = 'TOKEN-DE-CARTAO-IRIS-log-real-captura'
const CONTROLE_POSITIVO = 'CONTROLEPOSITIVO-LOG-REAL-visivel'

function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('log REAL (production + pino-pretty) dos fluxos Cielo — nenhum segredo, CardToken nem corpo cru da Cielo em stdout/stderr', () => {
  const cielo = new CieloFalsaHttp()
  const braspag = new BraspagFalsa()
  const suffix = uniqueSuffix()
  let api: ChildProcess | undefined
  let base = ''
  let saidaApi = ''
  let saidaFluxos = ''
  let adminToken = ''
  let driverToken = ''
  let driverId = ''
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }

  function envDosFilhos(porta?: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      ...(porta ? { PORT: String(porta) } : {}),
      DATABASE_URL: banco.url,
      CIELO_MERCHANT_ID: 'merchant-id-iris-real',
      CIELO_MERCHANT_KEY: SEGREDOS.merchantKey,
      CIELO_SANDBOX: 'false',
      CIELO_API_BASE_URL: cielo.url,
      CIELO_API_QUERY_BASE_URL: cielo.url,
      CIELO_TIMEOUT_MS: '1500',
      CIELO_SOP_CLIENT_ID: 'sop-client-id-log-real',
      CIELO_SOP_CLIENT_SECRET: SEGREDOS.sopSecret,
      CIELO_SOP_OAUTH_TOKEN_URL: `${braspag.url}/oauth2/token`,
      CIELO_SOP_ACCESS_TOKEN_URL: `${braspag.url}/post/api/public/v2/accesstoken`,
      CIELO_WEBHOOK_PATH_TOKEN: SEGREDOS.webhookPath,
      CIELO_WEBHOOK_HEADER_SECRET: SEGREDOS.webhookHeader,
    }
  }

  async function esperarSentinela(get: () => string, marca: string, timeoutMs = 25_000) {
    const limite = Date.now() + timeoutMs
    while (!get().includes(marca)) {
      if (Date.now() > limite) throw new Error(`a marca ${marca} nunca apareceu no log:\n${get().slice(-1500)}`)
      await sleep(50)
    }
  }

  /** Requisição SENTINELA: valor único num header fora do redact; o log é ordenado, então quando aparece tudo o que veio antes já está em `saidaApi`. */
  async function logApiAssentado(): Promise<string> {
    const sentinela = `SENTINELA-${Math.random().toString(36).slice(2, 12)}`
    await fetch(`${base}/health`, { headers: { 'x-sentinela': sentinela } })
    await esperarSentinela(() => saidaApi, sentinela)
    return saidaApi
  }

  async function rodarFluxo(acao: string, argumento?: string): Promise<void> {
    const filho = spawn(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'tests/integration/helpers/cieloFluxoProcesso.ts', acao, ...(argumento ? [argumento] : [])], {
      env: envDosFilhos(),
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let saida = ''
    filho.stdout!.on('data', (c: Buffer) => (saida += c.toString()))
    filho.stderr!.on('data', (c: Buffer) => (saida += c.toString()))
    await new Promise<void>((resolve) => filho.once('exit', () => resolve()))
    saidaFluxos += `\n===== fluxo ${acao} =====\n${saida}`
    if (!saida.includes(`SENTINELA-FIM-${acao}`)) throw new Error(`o fluxo ${acao} não terminou:\n${saida.slice(-1500)}`)
  }

  beforeAll(async () => {
    await cielo.iniciar()
    await braspag.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 1500, sandbox: false })

    const admin = await prisma.user.create({ data: { role: 'ADMIN', name: 'Admin Log Real', email: `admin-logreal-${suffix}@example.com` } })
    const driver = await prisma.user.create({ data: { role: 'DRIVER', name: 'Motorista Log Real', email: `driver-logreal-${suffix}@example.com` } })
    driverId = driver.id
    adminToken = jwt.sign({ userId: admin.id, role: 'ADMIN', operatorId: null }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '1h' })
    driverToken = jwt.sign({ userId: driver.id, role: 'DRIVER', operatorId: null }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '1h' })

    const porta = await portaLivre()
    base = `http://127.0.0.1:${porta}`
    api = spawn(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/entrypoints/api.ts'], { env: envDosFilhos(porta), cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    api.stdout!.on('data', (c: Buffer) => (saidaApi += c.toString()))
    api.stderr!.on('data', (c: Buffer) => (saidaApi += c.toString()))
    const limite = Date.now() + 60_000
    for (;;) {
      if (api.exitCode !== null) throw new Error(`o servidor saiu (exit ${api.exitCode}):\n${saidaApi}`)
      try {
        const r = await fetch(`${base}/health`)
        if (r.status === 200 || r.status === 503) break
      } catch {
        // subindo
      }
      if (Date.now() > limite) throw new Error(`o servidor não subiu em 60s:\n${saidaApi}`)
      await sleep(300)
    }
  }, 120_000)

  afterAll(async () => {
    if (api && api.exitCode === null) {
      const saiu = new Promise<void>((resolve) => api!.once('exit', () => resolve()))
      api.kill()
      await Promise.race([saiu, sleep(5000)])
    }
    await cielo.parar()
    await braspag.parar()
    Object.assign(env, baseline)
    if (processEnvBaseline.api === undefined) delete process.env.CIELO_API_BASE_URL
    else process.env.CIELO_API_BASE_URL = processEnvBaseline.api
    if (processEnvBaseline.query === undefined) delete process.env.CIELO_API_QUERY_BASE_URL
    else process.env.CIELO_API_QUERY_BASE_URL = processEnvBaseline.query
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    await prisma.$disconnect()
    redis.disconnect()
    await banco.descartar()
  }, 60_000)

  const post = (path: string, token: string, corpo?: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-controle-positivo': CONTROLE_POSITIVO }, body: corpo === undefined ? undefined : JSON.stringify(corpo) })

  function procurarSegredos(texto: string, segredos: Record<string, string>): string[] {
    return Object.entries(segredos).filter(([, v]) => texto.includes(v)).map(([k]) => k)
  }

  it('TESTE DE CONEXÃO (servidor real): 200 com status por passo mesmo com credencial errada, 403 = IP_NOT_ALLOWED, 6/min por ADMIN (7ª = 429), só ADMIN — e nenhum segredo/token na resposta', async () => {
    const respostas: string[] = []
    const chamar = async () => {
      const r = await post('/api/admin/payment-gateway/test-connection', adminToken)
      const texto = await r.text()
      respostas.push(texto)
      return { status: r.status, corpo: JSON.parse(texto) as { ok: boolean; environment: string; steps: Array<{ step: string; status: string; httpStatus: number | null; host: string | null; message: string }> } }
    }
    const ok = await chamar()
    expect(ok.status).toBe(200)
    expect(ok.corpo.ok).toBe(true)
    expect(ok.corpo.environment).toBe('production')
    expect(ok.corpo.steps.map((s) => `${s.step}=${s.status}`)).toEqual(['MERCHANT_CREDENTIALS=OK', 'SOP_OAUTH=OK', 'SOP_ACCESS_TOKEN=OK'])

    // credencial da loja errada: 400 com código 132 na Cielo => HTTP 200 da NOSSA rota, com status CREDENTIAL_REJECTED (não é erro HTTP)
    cielo.agendar('GET_BY_ORDER', { resposta: { http: 400, corpo: [{ Code: 132, Message: `MerchantKey is invalid ${SEGREDOS.eco}` }] } })
    const errada = await chamar()
    expect(errada.status).toBe(200)
    expect(errada.corpo.ok).toBe(false)
    expect(errada.corpo.steps.find((s) => s.step === 'MERCHANT_CREDENTIALS')).toMatchObject({ status: 'CREDENTIAL_REJECTED', httpStatus: 400 })

    cielo.agendar('GET_BY_ORDER', { resposta: { http: 403, corpo: { Message: SEGREDOS.eco } } })
    const ip = await chamar()
    expect(ip.status).toBe(200)
    expect(ip.corpo.steps.find((s) => s.step === 'MERCHANT_CREDENTIALS')).toMatchObject({ status: 'IP_NOT_ALLOWED', httpStatus: 403 })

    braspag.modoOauth = 'invalid_client'
    const sop = await chamar()
    braspag.modoOauth = 'ok'
    expect(sop.corpo.steps.find((s) => s.step === 'SOP_OAUTH')).toMatchObject({ status: 'CREDENTIAL_REJECTED' })
    expect(sop.corpo.steps.find((s) => s.step === 'SOP_ACCESS_TOKEN')).toMatchObject({ status: 'SKIPPED' })

    await chamar()
    await chamar() // 6ª
    const setima = await post('/api/admin/payment-gateway/test-connection', adminToken)
    expect(setima.status).toBe(429)
    respostas.push(await setima.text())

    const dr = await post('/api/admin/payment-gateway/test-connection', driverToken)
    expect(dr.status).toBe(403)
    expect((await fetch(`${base}/api/admin/payment-gateway/test-connection`, { method: 'POST' })).status).toBe(401)

    expect(procurarSegredos(respostas.join('\n'), SEGREDOS)).toEqual([])
    expect(respostas.join('\n')).not.toContain('merchant-key')

    // AUDITORIA do teste: uma linha OTHER por chamada que rodou (a 429/403/401 não rodam), com o resumo por passo e SEM segredo/token/eco.
    const linhas = await waitFor(
      async () => {
        const l = await prisma.auditLog.findMany({ where: { action: 'OTHER', actionDetail: { startsWith: 'test_connection' } }, orderBy: { occurredAt: 'asc' } })
        return l.length >= 6 ? l : null
      },
      { timeoutMs: 15_000, what: 'linhas de auditoria do teste de conexão' },
    )
    expect(linhas).toHaveLength(6)
    expect(linhas.map((l) => l.actionDetail)).toEqual([
      'test_connection:ok',
      'test_connection:MERCHANT_CREDENTIALS=CREDENTIAL_REJECTED',
      'test_connection:MERCHANT_CREDENTIALS=IP_NOT_ALLOWED',
      'test_connection:SOP_OAUTH=CREDENTIAL_REJECTED',
      'test_connection:ok',
      'test_connection:ok',
    ])
    expect(procurarSegredos(JSON.stringify(linhas), SEGREDOS)).toEqual([])
    expect(linhas.every((l) => l.changes === null && l.outcome === 'SUCCESS' && l.method === 'POST')).toBe(true)
  }, 60_000)

  it('SESSÃO DE TOKENIZAÇÃO (OAuth + accesstoken) e CADASTRO DE CARTÃO com GET /1/card/{token} em 3 formas (200 com corpo completo, 404 com eco, 500 com eco): 201 em todos', async () => {
    const sessao = await post('/api/me/payment-methods/tokenization-session', driverToken)
    expect(sessao.status).toBe(200)
    const corpoSessao = (await sessao.json()) as { accessToken: string }
    expect(corpoSessao.accessToken).toBe(SEGREDOS.accessToken) // é de propósito: vai ao NAVEGADOR (passo 2); o que não pode é ir ao log
    expect(JSON.stringify(corpoSessao)).not.toContain(SEGREDOS.oauthToken)

    // 200 com corpo completo (PAN mascarado + Holder): enriquecimento
    cielo.agendar('GET_CARD', { resposta: { http: 200, corpo: { CardNumber: SEGREDOS.cardNumberMascarado, Holder: SEGREDOS.holder, ExpirationDate: '12/2031', Brand: 'Visa', CardToken: TOKEN_CARTAO_200 } } })
    const r200 = await post('/api/me/payment-methods', driverToken, { cardToken: TOKEN_CARTAO_200, brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2031 })
    expect(r200.status, await r200.clone().text()).toBe(201)

    cielo.agendar('GET_CARD', { resposta: { http: 404, corpo: [{ Code: 404, Message: `Token ${TOKEN_CARTAO_404} ${SEGREDOS.eco}` }] } })
    const r404 = await post('/api/me/payment-methods', driverToken, { cardToken: TOKEN_CARTAO_404, brand: 'Master', last4: '1111', expiryMonth: 1, expiryYear: 2032 })
    expect(r404.status, await r404.clone().text()).toBe(201)

    cielo.agendar('GET_CARD', { resposta: { http: 500, bruto: `erro interno ${TOKEN_CARTAO_500} ${SEGREDOS.cardNumberMascarado} ${SEGREDOS.eco}` } })
    const r500 = await post('/api/me/payment-methods', driverToken, { cardToken: TOKEN_CARTAO_500, brand: 'Elo', last4: '2222', expiryMonth: 2, expiryYear: 2033 })
    expect(r500.status, await r500.clone().text()).toBe(201)

    // nenhum token cru volta ao cliente na lista
    const lista = await fetch(`${base}/api/me/payment-methods`, { headers: { authorization: `Bearer ${driverToken}` } })
    const textoLista = await lista.text()
    for (const t of [TOKEN_CARTAO_200, TOKEN_CARTAO_404, TOKEN_CARTAO_500]) expect(textoLista).not.toContain(t)
  }, 60_000)

  it('PRÉ-AUTORIZAÇÃO no servidor real: erro 400 da Cielo que ECOA o CardToken e a MerchantKey, e RemoteStart RECUSADO (dispara consulta + void) — log sem token/segredo', async () => {
    const tenant = await createTenant({ suffix, label: 'logreal' })
    await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { active: true, lastSeenAt: new Date() } })
    await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
    const metodo = await prisma.paymentMethod.create({
      data: { userId: driverId, environment: 'PRODUCTION', type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(TOKEN_NO_CAPTURE), brand: 'Visa', last4: '4242', isDefault: false },
    })
    const c1 = await prisma.connector.create({ data: { operatorId: tenant.operatorId, chargePointId: tenant.chargePointId, connectorId: 201, type: 'AC_TYPE2', status: 'AVAILABLE' } })
    const c2 = await prisma.connector.create({ data: { operatorId: tenant.operatorId, chargePointId: tenant.chargePointId, connectorId: 202, type: 'AC_TYPE2', status: 'AVAILABLE' } })

    const subscriber = createRedisConnection()
    const publisher = createRedisConnection()
    const canal = `ocpp:cmd:${tenant.chargePointId}`
    await subscriber.subscribe(canal)
    subscriber.on('message', (ch, mensagem) => {
      if (ch !== canal) return
      const p = JSON.parse(mensagem) as { correlationId: string; method: string }
      if (p.method !== 'RemoteStartTransaction') return
      publisher.publish(`ocpp:reply:${p.correlationId}`, JSON.stringify({ correlationId: p.correlationId, ok: true, result: { status: 'Rejected' } })).catch(() => {})
    })
    try {
      const iniciar = (connectorId: number) => post('/api/me/sessions/start', driverToken, { ocppIdentity: tenant.ocppIdentity, connectorId, payment: { mode: 'CARD', paymentMethodId: metodo.id } })

      // (a) a Cielo recusa o payload e ECOA o token e a chave na mensagem de erro
      cielo.agendar('POST_SALE', { processar: false, resposta: { http: 400, corpo: [{ Code: 126, Message: `CardToken ${TOKEN_NO_CAPTURE} inválido; MerchantKey ${SEGREDOS.merchantKey}; Holder ${SEGREDOS.holder}` }] } })
      const a = await iniciar(c1.connectorId)
      expect(a.status).toBe(503)

      // (b) autorizada normalmente, mas o carregador RECUSA o RemoteStart: a API consulta e cancela (PUT void) na hora
      const b = await iniciar(c2.connectorId)
      expect(b.status, await b.clone().text()).toBe(202)
      await sleep(1500) // dá tempo ao ACK Rejected -> consulta -> void
    } finally {
      subscriber.disconnect()
      publisher.disconnect()
    }
    expect(cielo.contar('PUT_VOID')).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('WEBHOOK no servidor real: ping 200, notificação válida 200, segredo errado 401 e nome antigo do header 401 — o segredo e o token do caminho não aparecem', async () => {
    const url = `${base}/api/webhooks/cielo/${SEGREDOS.webhookPath}`
    const h = (extra: Record<string, string>) => ({ 'content-type': 'application/json', 'x-controle-positivo': CONTROLE_POSITIVO, ...extra })
    expect((await fetch(url, { method: 'POST', headers: h({}), body: '{}' })).status).toBe(200) // ping
    expect((await fetch(url, { method: 'POST', headers: h({ InnoFlowWebhookSecret: SEGREDOS.webhookHeader }), body: JSON.stringify({ PaymentId: 'pay-desconhecido-log', ChangeType: 1 }) })).status).toBe(200)
    expect((await fetch(url, { method: 'POST', headers: h({ InnoFlowWebhookSecret: 'segredo-errado-xyz' }), body: JSON.stringify({ PaymentId: 'p', ChangeType: 1 }) })).status).toBe(401)
    expect((await fetch(url, { method: 'POST', headers: h({ 'x-innoelektron-webhook-secret': 'VALOR-QUALQUER-NO-NOME-ANTIGO' }), body: JSON.stringify({ PaymentId: 'p', ChangeType: 1 }) })).status).toBe(401) // nome ANTIGO do header (valor de isca: o segredo real sob um nome FORA da lista de redact sai em claro no log — ver o teste de ordem do webhook)
    expect((await fetch(`${base}/api/webhooks/cielo/token-errado`, { method: 'POST', headers: h({ InnoFlowWebhookSecret: SEGREDOS.webhookHeader }), body: '{}' })).status).toBe(404)
  })

  it('FLUXOS do worker em processo próprio: captura (com Tid > 64 e eco de segredo no erro), cancelamento, varredor, consulta do CardToken e sessão de tokenização', async () => {
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 1500, sandbox: false })
    const cen = await criarCenarioCartaoHttp(createApp(), suffix, 'logreal-fluxos', { ambiente: 'PRODUCTION' })
    try {
      const a = await cen.sessaoParada('fluxo-a')
      cielo.agendar('PUT_CAPTURE', { processar: true, corpoRespostaCru: { Status: 2, ReturnCode: '6', Tid: 'T'.repeat(90), Holder: SEGREDOS.holder } })
      await rodarFluxo('capturar', a.intentId)

      const b = await cen.sessaoParada('fluxo-b')
      cielo.agendar('PUT_CAPTURE', { processar: false, resposta: { http: 400, corpo: [{ Code: 308, Message: `captura recusada ${TOKEN_NO_CAPTURE} ${SEGREDOS.merchantKey}` }] } })
      await rodarFluxo('capturar', b.intentId) // falha: o erro vai ao log do fluxo

      const c = await cen.autorizadaAbandonada('fluxo-c')
      cielo.agendar('PUT_VOID', { processar: false, resposta: { http: 400, corpo: [{ Code: 309, Message: `void recusado ${TOKEN_NO_CAPTURE} ${SEGREDOS.merchantKey}` }] } })
      await rodarFluxo('cancelar', c.intentId)

      const d = await cen.autorizadaAbandonada('fluxo-d')
      await cen.envelhecer(d.intentId, 30)
      cielo.agendar('PUT_VOID', { processar: false, corpoRespostaCru: { Status: 1, ReturnCode: '40', Holder: SEGREDOS.holder } })
      await rodarFluxo('varrer')

      cielo.agendar('GET_CARD', { resposta: { http: 200, corpo: { CardNumber: SEGREDOS.cardNumberMascarado, Holder: SEGREDOS.holder, ExpirationDate: '12/2031', Brand: 'Visa' } } })
      await rodarFluxo('consultarCartao', 'CARDTOKEN-FLUXO-consulta-dddd-4444')
      cielo.agendar('GET_CARD', { resposta: { http: 500, bruto: `boom CARDTOKEN-FLUXO-consulta-eeee-5555 ${SEGREDOS.eco}` } })
      await rodarFluxo('consultarCartao', 'CARDTOKEN-FLUXO-consulta-eeee-5555')
      await rodarFluxo('sessaoTokenizacao')
      braspag.modoOauth = 'invalid_client'
      await rodarFluxo('sessaoTokenizacao')
      braspag.modoOauth = 'ok'
      await rodarFluxo('testarConexao')
    } finally {
      await cen.fechar()
    }
    expect(saidaFluxos).toContain('SENTINELA-FIM-capturar')
  }, 180_000)

  it('VARREDURA FINAL do stdout/stderr de TODOS os processos: nenhum segredo, token, CardToken, Holder, PAN mascarado nem eco da Cielo — e os controles positivos provam que o log existe', async () => {
    const logApi = await logApiAssentado()
    const tudo = `${logApi}\n${saidaFluxos}`

    // CONTROLES POSITIVOS (sem eles "não vazou" poderia ser só "não logou nada")
    expect(logApi).toContain(CONTROLE_POSITIVO) // o servidor loga os headers fora da lista de redact
    expect(logApi).toContain('request completed')
    expect(logApi).toContain('[redacted]')
    expect(logApi).toContain('/1/card/***') // o caminho do GET /1/card/{token} aparece MASCARADO no log da Cielo
    expect(saidaFluxos).toContain('[cielo]') // os fluxos de fato logaram pelo cliente da Cielo
    expect(saidaFluxos).toContain('/1/card/***')
    expect(tudo).toContain('payment_cielo_identifier_truncated') // alerta do Tid > 64 (só o nome do campo)
    expect(tudo).toContain('payment_gateway_credential_rejected') // credencial recusada vira alerta (invalid_client / 132)

    const vazados = procurarSegredos(tudo, SEGREDOS)
    const NL = String.fromCharCode(10)
    const linhasVazadas = tudo.split(NL).filter((l) => Object.values(SEGREDOS).some((v) => l.includes(v))).map((l) => l.slice(0, 400))
    expect(vazados, `segredos no log: ${vazados.join(', ')}${NL}${linhasVazadas.join(NL)}`).toEqual([])
    for (const t of [TOKEN_CARTAO_200, TOKEN_CARTAO_404, TOKEN_CARTAO_500, TOKEN_NO_CAPTURE, 'CARDTOKEN-FLUXO-consulta-dddd-4444', 'CARDTOKEN-FLUXO-consulta-eeee-5555']) {
      expect(tudo, `CardToken vazou: ${t}`).not.toContain(t)
    }
    expect(tudo).not.toContain('T'.repeat(65)) // o Tid de 90 caracteres nunca é logado, nem truncado
    expect(tudo).not.toMatch(/"?(Holder|CardNumber|SecurityCode)"?\s*[:=]\s*"?[A-Za-z0-9*]/)
    expect(tudo).not.toContain(adminToken)
    expect(tudo).not.toContain(driverToken)
    // corpo cru da Cielo (qualquer das mensagens de erro ecoadas)
    expect(tudo).not.toContain('captura recusada')
    expect(tudo).not.toContain('void recusado')
  }, 60_000)
})
