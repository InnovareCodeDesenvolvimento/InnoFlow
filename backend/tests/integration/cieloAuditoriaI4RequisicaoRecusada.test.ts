import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { uniqueSuffix } from './helpers/fixtures'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa, criarCenarioCartaoHttp, type CenarioCartaoHttp } from './helpers/cenarioCartaoHttp'

/**
 * I-4 (auditoria): erro 4xx DEFINITIVO da Cielo na pré-autorização (token do cartão inválido/expirado/lixo, payload recusado) NÃO é "gateway indisponível" — vira DENIED na hora e
 * um 4xx claro para o motorista recadastrar, sem ReturnCode. Só timeout/5xx/429 (e CREDENCIAL/IP, que são problema NOSSO e alertam) seguem 503.
 * S-1 (rota): o token do SOP simulado (`mocktok.*`) é recusado quando o adaptador é o REAL.
 */

const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_aud_i4')
})

describe('I-4 — 4xx definitivo da Cielo na autorização x indisponibilidade (adaptador real + Cielo falsa por TCP)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  let cen: CenarioCartaoHttp
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }

  beforeAll(async () => {
    await cielo.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 400 })
    cen = await criarCenarioCartaoHttp(app, suffix, 'aud-i4')
  })
  afterAll(async () => {
    await cielo.parar()
    await cen.fechar()
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
  })
  beforeEach(() => {
    cielo.zerarRegistro()
    vi.restoreAllMocks()
  })

  async function iniciar() {
    const motorista = await cen.novoMotorista(`m${Math.random().toString(36).slice(2, 6)}`)
    const connectorId = await cen.novoConector()
    const res = await cen.iniciar(motorista, connectorId)
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: motorista.user.id }, orderBy: { createdAt: 'desc' } })
    return { res, intent, motorista }
  }

  it('400 com erro de payload/cartão (126: cartão expirado): 402 CARD_AUTHORIZATION_DENIED com mensagem para RECADASTRAR, intent DENIED na hora, nenhum idTag, e o código da Cielo NÃO vaza', async () => {
    const erro = vi.spyOn(logger, 'error')
    cielo.agendar('POST_SALE', { processar: false, resposta: { http: 400, corpo: [{ Code: 126, Message: 'Credit Card Expiration Date is invalid' }] } })
    const { res, intent } = await iniciar()
    expect(res.status, JSON.stringify(res.body)).toBe(402)
    expect(res.body.code).toBe('CARD_AUTHORIZATION_DENIED')
    expect(res.body.error).toMatch(/cadastre|cadastr/i)
    expect(JSON.stringify(res.body)).not.toMatch(/126|ReturnCode|Credit Card|Expiration/)
    expect(intent.status).toBe('DENIED')
    expect(await prisma.authToken.count({ where: { userId: intent.userId, type: 'VIRTUAL' } })).toBe(0)
    expect(cielo.contar('POST_SALE')).toBe(1) // uma chamada, sem repetição
    expect(erro.mock.calls.map((c) => (c[0] as { alert?: string }).alert)).toContain('payment_authorization_request_refused')
  })

  it('400 de CardToken desconhecido/lixo (Code 307): mesmo caminho — DENIED + 4xx claro (antes: 503 "indisponível" para sempre e um intent órfão por tentativa)', async () => {
    cielo.agendar('POST_SALE', { processar: false, resposta: { http: 400, corpo: [{ Code: 307, Message: 'Card token not found' }] } })
    const { res, intent } = await iniciar()
    expect(res.status).toBe(402)
    expect(intent.status).toBe('DENIED')
  })

  it.each([
    ['credencial (400 + Code 132)', { http: 400, corpo: [{ Code: 132, Message: 'MerchantKey is invalid' }] }],
    ['IP fora da lista (403)', { http: 403, corpo: { Message: 'forbidden' } }],
    ['excesso de chamadas (429)', { http: 429, corpo: {} }],
    ['Cielo fora (500)', { http: 500, corpo: { Message: 'erro' } }],
    ['Cielo fora (503)', { http: 503, corpo: {} }],
  ])('%s: continua 503 PAYMENT_GATEWAY_UNAVAILABLE (problema nosso/transitório, não do cartão) e o intent NÃO é DENIED', async (_nome, resposta) => {
    cielo.agendar('POST_SALE', { processar: false, resposta })
    const { res, intent } = await iniciar()
    expect(res.status, JSON.stringify(res.body)).toBe(503)
    expect(res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
    expect(intent.status).toBe('CREATED') // segue para o varredor reconsultar
  })

  it('timeout: continua 503 e a reconciliação roda (1 POST, 1 GET por pedido)', async () => {
    cielo.agendar('POST_SALE', { processar: false, resposta: 'travar' })
    const { res, intent } = await iniciar()
    expect(res.status).toBe(503)
    expect(intent.status).toBe('CREATED')
    expect(cielo.sequencia({ merchantOrderId: intent.id })).toEqual(['POST_SALE', 'GET_BY_ORDER'])
  })

  it('S-1 (rota): com o adaptador REAL, o token do SOP simulado (mocktok.*) é recusado no cadastro — 400 INVALID_CARD_TOKEN; um GUID passa', async () => {
    const motorista = await cen.novoMotorista(`m${Math.random().toString(36).slice(2, 6)}`)
    const auth = { Authorization: `Bearer ${motorista.token}` }
    const mock = await request(app).post('/api/me/payment-methods').set(auth).send({ cardToken: 'mocktok.4242.122030.Rm9v.17910000000001', brand: 'Visa' })
    expect(mock.status, JSON.stringify(mock.body)).toBe(400)
    expect(mock.body.code).toBe('INVALID_CARD_TOKEN')
    const real = await request(app).post('/api/me/payment-methods').set(auth).send({ cardToken: '3f1f0a2e-5b6c-4d7e-8f90-a1b2c3d4e5f6', brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2031 })
    expect(real.status, JSON.stringify(real.body)).toBe(201)
  })
})
