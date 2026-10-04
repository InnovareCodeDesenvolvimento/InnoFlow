import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { intentIdDoMerchantOrderId, merchantOrderIdCorrespondeAoIntent, paraMerchantOrderIdDaCielo } from '../../src/core/pagamentos/merchantOrderId'
import { varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { varrerTopupsPixPendentes } from '../../src/services/pagamentos/pollTopupsPix'
import { uniqueSuffix, createUser } from './helpers/fixtures'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa, criarCenarioCartaoHttp, type CenarioCartaoHttp } from './helpers/cenarioCartaoHttp'

// Banco próprio: o varredor olha o banco INTEIRO (ver cieloRealAutorizacaoSemDuplicar).
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('merchant_if_r3')
})

/**
 * Íris (rodada 3) — `MerchantOrderId` `IF-<id>` + `SoftDescriptor` NO FIO (conta Cielo COMPARTILHADA com o Parque das Feiras), com o adaptador REAL e a Cielo falsa por TCP.
 * Provas: o que VAI à Cielo (corpo cru do POST), o que se CONSULTA (ordem das consultas por pedido), intents ANTIGOS sem prefixo (fallback), e que uma venda do Parque no mesmo
 * estabelecimento NUNCA é tomada por nossa (nem cancelada pelo nosso varredor).
 */
const mo = (id: string) => `IF-${id}`

describe('IF-<id> e SoftDescriptor no fio', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  let cen: CenarioCartaoHttp
  const baseline = { ...env } as Record<string, unknown>
  const e = env as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }

  beforeAll(async () => {
    await cielo.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 400 })
    cen = await criarCenarioCartaoHttp(app, suffix, 'ifr3')
  }, 30_000)
  beforeEach(() => {
    cielo.zerarRegistro()
    e.CIELO_SOFT_DESCRIPTOR = baseline.CIELO_SOFT_DESCRIPTOR
  })
  afterAll(async () => {
    Object.assign(env, baseline)
    process.env.CIELO_API_BASE_URL = processEnvBaseline.api
    process.env.CIELO_API_QUERY_BASE_URL = processEnvBaseline.query
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    await cielo.parar()
    await cen.fechar()
    await prisma.$disconnect()
    redis.disconnect()
    await banco.descartar()
  })

  /** Início com cartão em que a Cielo PROCESSA e a conexão cai: sobra um intent CREATED com a venda viva na Cielo. */
  async function criadoComVendaViva(label: string) {
    const m = await cen.novoMotorista(label)
    cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
    const res = await cen.iniciar(m, await cen.novoConector())
    expect(res.status).toBe(503)
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: m.user.id }, orderBy: { createdAt: 'desc' } })
    return { m, intent }
  }

  describe('o que VAI à Cielo', () => {
    it('cartão: MerchantOrderId = IF-<id do intent> (28 caracteres, <= 50) e SoftDescriptor INNOFLOW; nenhum POST leva o id cru', async () => {
      const m = await cen.novoMotorista('fio-cartao')
      const res = await cen.iniciar(m, await cen.novoConector())
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: m.user.id } })
      const post = cielo.chamadas.filter((c) => c.rota === 'POST_SALE')
      expect(post).toHaveLength(1)
      const corpo = post[0].corpo as { MerchantOrderId: string; Payment: { SoftDescriptor?: string } }
      expect(corpo.MerchantOrderId).toBe(mo(intent.id))
      expect(corpo.MerchantOrderId.length).toBeLessThanOrEqual(50)
      expect(corpo.Payment.SoftDescriptor).toBe('INNOFLOW')
      expect(post[0].corpoBruto).not.toContain(`"MerchantOrderId":"${intent.id}"`)
    })

    it('SoftDescriptor configurável é HIGIENIZADO no fio (A-Z0-9, <= 13, sem acento/espaço/pontuação) e, se sobrar vazio, o campo NÃO vai (a transação não é recusada por um enfeite)', async () => {
      const casos: Array<[string, string | undefined]> = [
        ['Inno Flow Recargas Rápidas!', 'INNOFLOWRECAR'],
        ['  café-elétron  ', 'CAFEELETRON'],
        ['!!! --- ???', undefined],
        ['', undefined],
      ]
      for (const [bruto, esperado] of casos) {
        e.CIELO_SOFT_DESCRIPTOR = bruto
        cielo.zerarRegistro()
        const m = await cen.novoMotorista(`sd-${Math.random().toString(36).slice(2, 6)}`)
        expect((await cen.iniciar(m, await cen.novoConector())).status).toBe(202)
        const corpo = cielo.chamadas.find((c) => c.rota === 'POST_SALE')!.corpo as { Payment: { SoftDescriptor?: string } }
        expect(corpo.Payment.SoftDescriptor, `bruto ${JSON.stringify(bruto)}`).toBe(esperado)
        if (esperado) expect(corpo.Payment.SoftDescriptor).toMatch(/^[A-Z0-9]{1,13}$/)
      }
    })

    it('Pix: MerchantOrderId = IF-<id> no POST (e o crédito reconhece a venda que a Cielo devolve com o prefixo)', async () => {
      const u = await createUser({ role: 'DRIVER', label: 'if-pix', suffix })
      const res = await request(app).post('/api/me/wallet/topups').set('Authorization', `Bearer ${u.token}`).send({ amountCents: 1200 })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: u.id } })
      const post = cielo.chamadas.find((c) => c.rota === 'POST_SALE')!
      expect((post.corpo as { MerchantOrderId: string }).MerchantOrderId).toBe(mo(intent.id))
      // paga na Cielo e deixa o varredor creditar: o MerchantOrderId devolvido (IF-...) bate com o intent
      cielo.vendaPorPedido(mo(intent.id))!.status = 2
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { createdAt: new Date(Date.now() - 60_000) } })
      const r = await varrerTopupsPixPendentes()
      expect(r.creditados).toBe(1)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PAID')
    })
  })

  describe('o que se CONSULTA por pedido (reconciliação) — IF-<id> primeiro, id cru só como fallback', () => {
    it('intent NOVO: a consulta vai com IF-<id>, ACHA a venda e NÃO faz a 2ª consulta (cru); a pré-autorização órfã é cancelada UMA vez', async () => {
      const { intent } = await criadoComVendaViva('novo')
      await cen.envelhecer(intent.id, 30)
      cielo.chamadas.length = 0
      await varrerPreAutorizacoesCartao()
      const consultas = cielo.chamadas.filter((c) => c.rota === 'GET_BY_ORDER').map((c) => c.merchantOrderId)
      expect(consultas[0]).toBe(mo(intent.id))
      expect(consultas).not.toContain(intent.id)
      const venda = cielo.vendaPorPedido(mo(intent.id))!
      expect(venda.status).toBe(10)
      expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('VOIDED')
    })

    it('intent ANTIGO (venda gravada na Cielo com o id CRU, antes do prefixo): IF-<id> volta vazio, depois a consulta pelo id cru acha e a venda é cancelada UMA vez — ordem exata [IF-id, id]', async () => {
      const m = await cen.novoMotorista('antigo')
      const intent = await prisma.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: m.user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX' } })
      const venda = cielo.plantarVenda({ merchantOrderId: intent.id, status: 1, returnCode: '4', amount: 1_000 }) // forma ANTIGA: sem prefixo
      await cen.envelhecer(intent.id, 30)
      await varrerPreAutorizacoesCartao()
      expect(cielo.chamadas.filter((c) => c.rota === 'GET_BY_ORDER').map((c) => c.merchantOrderId)).toEqual([mo(intent.id), intent.id])
      expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('VOIDED')
    })

    it('CUSTO: intent que a Cielo NUNCA viu gasta 2 consultas por reconciliação (IF-id e id cru) — documentado; nenhuma venda é inventada nem cancelada', async () => {
      const m = await cen.novoMotorista('nunca-viu')
      const intent = await prisma.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: m.user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX' } })
      await cen.envelhecer(intent.id, 30)
      await varrerPreAutorizacoesCartao()
      expect(cielo.chamadas.filter((c) => c.rota === 'GET_BY_ORDER').map((c) => c.merchantOrderId)).toEqual([mo(intent.id), intent.id])
      expect(cielo.contar('PUT_VOID')).toBe(0)
    })

    it('VENDA DO PARQUE no mesmo estabelecimento: a Cielo (mal-comportada) devolve na consulta uma venda de OUTRO MerchantOrderId — o varredor NUNCA a toma por nossa e NUNCA a cancela', async () => {
      const m = await cen.novoMotorista('parque')
      const intent = await prisma.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: m.user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX' } })
      const venda = cielo.plantarVenda({ paymentId: `parque-pay-${suffix}`, merchantOrderId: `PARQUE-${suffix}`, status: 1, returnCode: '4', amount: 1_000 })
      const lista = { MerchantOrderId: 'PARQUE', Payments: [{ PaymentId: venda.paymentId, MerchantOrderId: `PARQUE-${suffix}`, Status: 1, ReturnCode: '4', Amount: 1_000, ReceveidDate: '2026-10-04 10:00:00' }] }
      cielo.agendar('GET_BY_ORDER', { corpoRespostaCru: lista }, { corpoRespostaCru: lista })
      await cen.envelhecer(intent.id, 30)
      await varrerPreAutorizacoesCartao()
      expect(cielo.contar('PUT_VOID')).toBe(0)
      expect(cielo.vendas.get(venda.paymentId)!.status).toBe(1) // a venda do Parque segue intacta
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).cieloPaymentId).toBeNull()
    })

    it('VENDA DE OUTRO INTENT nosso (IF-<outro id>) devolvida na consulta deste intent também é ignorada', async () => {
      const m = await cen.novoMotorista('outro-intent')
      const intent = await prisma.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: m.user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX' } })
      const outro = `outro-${randomUUID()}`
      const venda = cielo.plantarVenda({ paymentId: `alheio-${suffix}`, merchantOrderId: mo(outro), status: 1, returnCode: '4', amount: 1_000 })
      const lista = { MerchantOrderId: mo(outro), Payments: [{ PaymentId: venda.paymentId, MerchantOrderId: mo(outro), Status: 1, ReturnCode: '4', Amount: 1_000 }] }
      cielo.agendar('GET_BY_ORDER', { corpoRespostaCru: lista }, { corpoRespostaCru: lista })
      await cen.envelhecer(intent.id, 30)
      await varrerPreAutorizacoesCartao()
      expect(cielo.contar('PUT_VOID')).toBe(0)
    })

    it('crédito do Pix NÃO aceita venda de OUTRO pedido (alerta `payment_pix_credit_divergence`, nada creditado) — mesmo com o prefixo IF- no outro id', async () => {
      const u = await createUser({ role: 'DRIVER', label: 'if-diverge', suffix })
      const res = await request(app).post('/api/me/wallet/topups').set('Authorization', `Bearer ${u.token}`).send({ amountCents: 1000 })
      expect(res.status).toBe(201)
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: u.id } })
      const venda = cielo.vendaPorPedido(mo(intent.id))!
      venda.merchantOrderId = mo(`outro-${randomUUID()}`)
      venda.status = 2
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { createdAt: new Date(Date.now() - 60_000) } })
      const erro = vi.spyOn(logger, 'error')
      await varrerTopupsPixPendentes()
      const alertas = erro.mock.calls.map((c) => c[0] as { alert?: string; motivo?: string }).filter((o) => o?.alert === 'payment_pix_credit_divergence')
      erro.mockRestore()
      expect(alertas).toHaveLength(1)
      expect(alertas[0].motivo).toBe('merchant_order_id')
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PENDING')
      expect(await prisma.walletEntry.count({ where: { wallet: { userId: u.id } } })).toBe(0)
    })
  })

  describe('funções puras (fronteiras)', () => {
    it('prefixo só cabe até 50 caracteres: id de 47 leva IF- (50); id de 48 vai CRU (nunca truncado); já prefixado não prefixa de novo', () => {
      expect(paraMerchantOrderIdDaCielo('a'.repeat(47))).toBe(`IF-${'a'.repeat(47)}`)
      expect(paraMerchantOrderIdDaCielo('a'.repeat(47)).length).toBe(50)
      expect(paraMerchantOrderIdDaCielo('a'.repeat(48))).toBe('a'.repeat(48))
      expect(paraMerchantOrderIdDaCielo('IF-abc')).toBe('IF-abc')
      expect(paraMerchantOrderIdDaCielo('clx123')).toBe('IF-clx123')
    })
    it('ida e volta: intentIdDoMerchantOrderId(paraMerchantOrderIdDaCielo(id)) = id; tira UM prefixo só; correspondência aceita as duas formas e recusa o resto', () => {
      for (const id of ['clx123', 'a'.repeat(47), 'a'.repeat(48), 'IF-ja-prefixado']) expect(intentIdDoMerchantOrderId(paraMerchantOrderIdDaCielo(id))).toBe(id.startsWith('IF-') ? id.slice(3) : id)
      expect(intentIdDoMerchantOrderId('IF-IF-x')).toBe('IF-x')
      expect(merchantOrderIdCorrespondeAoIntent('IF-clx', 'clx')).toBe(true)
      expect(merchantOrderIdCorrespondeAoIntent('clx', 'clx')).toBe(true)
      expect(merchantOrderIdCorrespondeAoIntent('if-clx', 'clx')).toBe(false) // caixa diferente NÃO casa
      expect(merchantOrderIdCorrespondeAoIntent('IF-clxx', 'clx')).toBe(false)
      expect(merchantOrderIdCorrespondeAoIntent('xIF-clx', 'clx')).toBe(false)
      expect(merchantOrderIdCorrespondeAoIntent('PARQUE-clx', 'clx')).toBe(false)
    })
  })
})
