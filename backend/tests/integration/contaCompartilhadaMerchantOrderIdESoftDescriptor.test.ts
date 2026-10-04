import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { paraMerchantOrderIdDaCielo, intentIdDoMerchantOrderId, merchantOrderIdCorrespondeAoIntent } from '../../src/core/pagamentos/merchantOrderId'
import { uniqueSuffix } from './helpers/fixtures'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa, criarCenarioCartaoHttp, type CenarioCartaoHttp } from './helpers/cenarioCartaoHttp'

/**
 * Conta Cielo COMPARTILHADA com o Parque das Feiras (decisão do dono, 04/10/2026) — contra a Cielo falsa por TCP (helpers da Íris, só reaproveitados):
 *  - `MerchantOrderId` vai como `IF-<id do intent>` (cartão e Pix), a reconciliação e o crédito funcionam com ele, e intents ANTIGOS (id cru na Cielo) continuam resolvendo;
 *  - `SoftDescriptor` do InnoFlow vai na pré-autorização (higienizado A-Z0-9, até 13);
 *  - o Pix é creditado SEM webhook, só pela leitura do app.
 */
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_compart')
})

describe('conta compartilhada: MerchantOrderId com prefixo, SoftDescriptor e Pix sem webhook (adaptador real + Cielo falsa por TCP)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  let cen: CenarioCartaoHttp
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }

  beforeAll(async () => {
    await cielo.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 400 })
    cen = await criarCenarioCartaoHttp(app, suffix, 'compart')
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
    cielo.porPedido = 'so_ids'
    ;(env as Record<string, unknown>).CIELO_SOFT_DESCRIPTOR = 'INNOFLOW'
  })

  async function iniciar() {
    const motorista = await cen.novoMotorista(`m${Math.random().toString(36).slice(2, 6)}`)
    const connectorId = await cen.novoConector()
    const res = await cen.iniciar(motorista, connectorId)
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: motorista.user.id }, orderBy: { createdAt: 'desc' } })
    return { res, intent, motorista }
  }

  describe('funções puras', () => {
    it('prefixo IF-: ida e volta; aceita as duas formas (nova e antiga); nunca trunca (id longo vai cru)', () => {
      const id = 'cmuaqwerty0000abcdefghijk'
      expect(paraMerchantOrderIdDaCielo(id)).toBe(`IF-${id}`)
      expect(paraMerchantOrderIdDaCielo(`IF-${id}`)).toBe(`IF-${id}`) // idempotente
      expect(intentIdDoMerchantOrderId(`IF-${id}`)).toBe(id)
      expect(intentIdDoMerchantOrderId(id)).toBe(id)
      expect(merchantOrderIdCorrespondeAoIntent(`IF-${id}`, id)).toBe(true)
      expect(merchantOrderIdCorrespondeAoIntent(id, id)).toBe(true)
      expect(merchantOrderIdCorrespondeAoIntent('OUTRO', id)).toBe(false)
      expect(merchantOrderIdCorrespondeAoIntent(`IF-${id}x`, id)).toBe(false)
      const longo = 'x'.repeat(48)
      expect(paraMerchantOrderIdDaCielo(longo)).toBe(longo) // 3 + 48 > 50: manda cru em vez de truncar
      expect(paraMerchantOrderIdDaCielo(id).length).toBeLessThanOrEqual(50)
    })
  })

  describe('cartão', () => {
    it('no fio: POST /1/sales leva MerchantOrderId `IF-<intent.id>` e SoftDescriptor `INNOFLOW`; o intent guarda o id SEM prefixo', async () => {
      const { res, intent } = await iniciar()
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      const post = cielo.chamadas.find((c) => c.rota === 'POST_SALE')!
      const corpo = post.corpo as { MerchantOrderId: string; Payment: { SoftDescriptor?: string } }
      expect(corpo.MerchantOrderId).toBe(`IF-${intent.id}`)
      expect(corpo.Payment.SoftDescriptor).toBe('INNOFLOW')
      expect(intent.status).toBe('AUTHORIZED')
    })

    it('CIELO_SOFT_DESCRIPTOR é higienizado (A-Z0-9, até 13, sem acento) antes de ir à Cielo', async () => {
      ;(env as Record<string, unknown>).CIELO_SOFT_DESCRIPTOR = 'Inno-Flow Elétron Recarga!'
      const { res } = await iniciar()
      expect(res.status).toBe(202)
      const corpo = cielo.chamadas.find((c) => c.rota === 'POST_SALE')!.corpo as { Payment: { SoftDescriptor?: string } }
      expect(corpo.Payment.SoftDescriptor).toBe('INNOFLOWELETR')
      expect(corpo.Payment.SoftDescriptor).toMatch(/^[A-Z0-9]{1,13}$/)
    })

    it('timeout depois de a Cielo processar: a reconciliação consulta `IF-<id>`, ACHA a venda e segue (202) — 1 POST, nunca 2', async () => {
      cielo.agendar('POST_SALE', { processar: true, resposta: 'travar' })
      const { res, intent } = await iniciar()
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      expect(intent.status).toBe('AUTHORIZED')
      const consultaPedido = cielo.chamadas.find((c) => c.rota === 'GET_BY_ORDER')!
      expect(consultaPedido.merchantOrderId).toBe(`IF-${intent.id}`)
      expect(cielo.contar('POST_SALE')).toBe(1)
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
    })

    it('intent ANTIGO (anterior ao prefixo): a venda foi gravada com o id CRU na Cielo e o varredor ainda a acha (tenta `IF-<id>`, depois o cru) e a cancela', async () => {
      const motorista = await cen.novoMotorista(`m${Math.random().toString(36).slice(2, 6)}`)
      const intent = await prisma.paymentIntent.create({
        data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: motorista.user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX' },
      })
      const venda = cielo.plantarVenda({ merchantOrderId: intent.id, status: 1, returnCode: '4', amount: 1_000 }) // SEM prefixo, como antes da mudança
      await cen.envelhecer(intent.id, 30)

      await varrerPreAutorizacoesCartao()

      const consultasPedido = cielo.chamadas.filter((c) => c.rota === 'GET_BY_ORDER' && (c.merchantOrderId === `IF-${intent.id}` || c.merchantOrderId === intent.id))
      expect(consultasPedido.map((c) => c.merchantOrderId)).toEqual([`IF-${intent.id}`, intent.id])
      expect(cielo.vendas.get(venda.paymentId)!.status).toBe(10)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('VOIDED')
    })

    it('venda do PARQUE no mesmo EC (outro MerchantOrderId) nunca é confundida com a nossa na reconciliação', async () => {
      const motorista = await cen.novoMotorista(`m${Math.random().toString(36).slice(2, 6)}`)
      const intent = await prisma.paymentIntent.create({
        data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: motorista.user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX' },
      })
      // o Parque tem uma venda autorizada com OUTRO pedido; a consulta por pedido devolve (por erro) a dele na lista — o filtro pelo MerchantOrderId do detalhe a descarta
      const doParque = cielo.plantarVenda({ merchantOrderId: 'pedido-do-parque-123', status: 1, returnCode: '4', amount: 1_000 })
      cielo.agendar('GET_BY_ORDER', { corpoRespostaCru: { Payments: [{ PaymentId: doParque.paymentId, ReceveidDate: '2026-10-04 10:00:00' }] } })
      cielo.agendar('GET_BY_ORDER', { corpoRespostaCru: { Payments: [{ PaymentId: doParque.paymentId, ReceveidDate: '2026-10-04 10:00:00' }] } })
      await cen.envelhecer(intent.id, 30)

      await varrerPreAutorizacoesCartao()

      expect(cielo.vendas.get(doParque.paymentId)!.status).toBe(1) // a venda do Parque NÃO foi cancelada
      expect(cielo.contar('PUT_VOID', { paymentId: doParque.paymentId })).toBe(0)
      // sem venda NOSSA na Cielo (a do Parque foi descartada pelo filtro de pedido), o intent velho é encerrado como FAILED e NÃO fica amarrado ao PaymentId do Parque
      const depois = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(depois.status).toBe('FAILED')
      expect(depois.cieloPaymentId).toBeNull()
    })
  })

  describe('Pix sem webhook', () => {
    it('no fio: POST do Pix leva `IF-<intent.id>`; pago na Cielo, a LEITURA do app credita (sem nenhum webhook) e o valor/pedido conferem com o intent', async () => {
      const m = await cen.novoMotorista(`pix${Math.random().toString(36).slice(2, 6)}`)
      const auth = { Authorization: `Bearer ${m.token}` }
      const criado = await request(app).post('/api/me/wallet/topups').set(auth).send({ amountCents: 2_500 })
      expect(criado.status, JSON.stringify(criado.body)).toBe(201)
      const post = cielo.chamadas.filter((c) => c.rota === 'POST_SALE').at(-1)!
      expect((post.corpo as { MerchantOrderId: string }).MerchantOrderId).toBe(`IF-${criado.body.id}`)

      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: criado.body.id } })
      const venda = cielo.vendas.get(intent.cieloPaymentId!)!
      venda.status = 2 // o motorista pagou o QR no banco dele
      venda.returnCode = '0'
      await redis.del(`pix-poll:read:${intent.id}`)

      const lido = await request(app).get(`/api/me/wallet/topups/${intent.id}`).set(auth)
      expect(lido.status).toBe(200)
      expect(lido.body.status).toBe('PAID')
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PAID')
    })
  })
})
