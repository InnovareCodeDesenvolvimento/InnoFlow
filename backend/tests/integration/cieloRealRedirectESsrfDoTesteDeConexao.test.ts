import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { CieloHttpClient } from '../../src/services/pagamentos/cieloHttpClient'
import { createUser, uniqueSuffix } from './helpers/fixtures'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa } from './helpers/cenarioCartaoHttp'

/**
 * Íris (C2.1, 04/10/2026) — SSRF e destino das chamadas do TESTE DE CONEXÃO e do cliente HTTP da Cielo.
 *  (1) Os hosts vêm SÓ de config do servidor (env/default por ambiente): nem o corpo, nem a query, nem os cabeçalhos `Host`/`X-Forwarded-*` do pedido do admin mudam o destino;
 *      e o `PUT /payment-gateway` (strict) recusa qualquer campo de URL.
 *  (2) REDIRECIONAMENTO: o `fetch` do Node SEGUE redirecionamentos por padrão e repassa cabeçalhos CUSTOMIZADOS na troca de origem (só o `Authorization` é
 *      removido). `MerchantId`/`MerchantKey` são cabeçalhos customizados: um 30x do host da Cielo (ou de um proxy/URL de env mal configurado) entregaria a MerchantKey ao
 *      destino do redirecionamento. Medido abaixo com um servidor "atacante" de verdade.
 */

describe('SSRF / destino das chamadas à Cielo', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  let atacante: Server
  let atacanteUrl = ''
  const recebidoPeloAtacante: Array<{ url: string; headers: IncomingHttpHeaders }> = []
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }
  let contador = 0

  beforeAll(async () => {
    await cielo.iniciar()
    atacante = createServer((req, res) => {
      recebidoPeloAtacante.push({ url: req.url ?? '', headers: req.headers })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ Payments: [] }))
    })
    await new Promise<void>((r) => atacante.listen(0, '127.0.0.1', r))
    atacanteUrl = `http://127.0.0.1:${(atacante.address() as AddressInfo).port}`
  })
  afterEach(() => {
    recebidoPeloAtacante.length = 0
    cielo.zerarRegistro()
  })
  afterAll(async () => {
    await cielo.parar()
    await new Promise((r) => atacante.close(r))
    Object.assign(env, baseline)
    if (processEnvBaseline.api === undefined) delete process.env.CIELO_API_BASE_URL
    else process.env.CIELO_API_BASE_URL = processEnvBaseline.api
    if (processEnvBaseline.query === undefined) delete process.env.CIELO_API_QUERY_BASE_URL
    else process.env.CIELO_API_QUERY_BASE_URL = processEnvBaseline.query
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function novoAdmin() {
    contador += 1
    return createUser({ role: 'ADMIN', label: `admin-ssrf-${contador}`, suffix })
  }

  it('o destino do teste de conexão é SÓ o host configurado no servidor: Host/X-Forwarded-Host forjados, query e corpo com URLs não desviam nada (exatamente 1 GET no host configurado, de leitura)', async () => {
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 800 })
    const admin = await novoAdmin()
    const r = await request(app)
      .post('/api/admin/payment-gateway/test-connection?apiBaseUrl=http://evil.example&url=http://127.0.0.1:1')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Host', 'evil.example')
      .set('X-Forwarded-Host', 'evil.example')
      .set('X-Forwarded-For', '10.9.9.9')
      .send({ apiBaseUrl: 'http://evil.example', CIELO_API_QUERY_BASE_URL: 'http://evil.example', host: 'evil.example' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const passo = r.body.steps.find((s: { step: string }) => s.step === 'MERCHANT_CREDENTIALS')
    expect(passo.host).toBe(new URL(cielo.url).host)
    expect(cielo.chamadas).toHaveLength(1)
    expect(cielo.chamadas[0]).toMatchObject({ metodo: 'GET', rota: 'GET_BY_ORDER' })
    expect(recebidoPeloAtacante).toHaveLength(0)
    expect(JSON.stringify(r.body)).not.toContain('evil.example')
  })

  it('o PUT /payment-gateway é strict: campo de URL/host vem recusado (400) antes de qualquer outra regra — não existe caminho para o admin escolher o destino', async () => {
    const admin = await novoAdmin()
    for (const campo of [{ apiBaseUrl: 'http://evil.example' }, { queryBaseUrl: 'http://evil.example' }, { sopScriptUrl: 'http://evil.example/x.js' }, { oauthTokenUrl: 'http://evil.example' }, { accessTokenUrl: 'http://evil.example' }]) {
      const r = await request(app).put('/api/admin/payment-gateway').set('Authorization', `Bearer ${admin.token}`).send({ ...campo, currentPassword: 'qualquer' })
      expect(r.status, JSON.stringify(campo)).toBe(400)
    }
  })

  it('ambiente "production" com URL de SANDBOX, ou "sandbox" com URL oficial de PRODUÇÃO: o teste não chama ninguém (MISCONFIGURED) — só o host aparece, nunca a URL inteira', async () => {
    const e = env as Record<string, unknown>
    e.CIELO_MERCHANT_ID = 'mid'
    e.CIELO_MERCHANT_KEY = 'mkey-ssrf'
    e.CIELO_SANDBOX = false
    process.env.CIELO_API_BASE_URL = 'https://apisandbox.cieloecommerce.cielo.com.br'
    process.env.CIELO_API_QUERY_BASE_URL = 'https://apiquerysandbox.cieloecommerce.cielo.com.br'
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    const admin = await novoAdmin()
    const r = await request(app).post('/api/admin/payment-gateway/test-connection').set('Authorization', `Bearer ${admin.token}`)
    expect(r.status).toBe(200)
    expect(r.body.steps.find((s: { step: string }) => s.step === 'MERCHANT_CREDENTIALS')).toMatchObject({ status: 'MISCONFIGURED', httpStatus: null })
    expect(JSON.stringify(r.body)).not.toContain('mkey-ssrf')
    expect(cielo.chamadas).toHaveLength(0)
  })

  /**
   * ACHADO (Íris): sem `redirect: 'manual'|'error'`, um 30x entrega o `MerchantId`/`MerchantKey` ao destino do redirecionamento. Exige um host de Cielo/proxy/env
   * mal configurado ou comprometido, então a probabilidade é baixa — mas o que vaza é a credencial que cobra cartão. Correção de uma linha: `redirect: 'error'` (ou
   * 'manual' + tratar como falha) em `CieloHttpClient.request` e nas duas chamadas do SOP. Vira `it` quando corrigido.
   */
  it.fails('(achado) um redirecionamento 302 da Cielo para OUTRA origem NÃO pode levar a MerchantKey junto', async () => {
    cielo.agendar('GET_BY_ORDER', { resposta: { http: 302, corpo: null } })
    // o servidor falso responde 302 sem Location por padrão; aqui montamos o redirecionamento de verdade com um servidor dedicado:
    const redirecionador = createServer((req, res) => {
      res.statusCode = 302
      res.setHeader('location', `${atacanteUrl}${req.url}`)
      res.end()
    })
    await new Promise<void>((r) => redirecionador.listen(0, '127.0.0.1', r))
    try {
      const base = `http://127.0.0.1:${(redirecionador.address() as AddressInfo).port}`
      const client = new CieloHttpClient({ merchantId: 'mid-redirect', merchantKey: 'CHAVE-QUE-NAO-PODE-VAZAR', apiBaseUrl: base, apiQueryBaseUrl: base, timeoutMs: 1500 })
      await client.getByMerchantOrderId('qualquer').catch(() => {})
      const vazou = recebidoPeloAtacante.some((c) => JSON.stringify(c.headers).includes('CHAVE-QUE-NAO-PODE-VAZAR'))
      expect(vazou, 'a MerchantKey chegou ao host do redirecionamento').toBe(false)
    } finally {
      await new Promise((r) => redirecionador.close(r))
    }
  })
})
