import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { MAX_TENTATIVAS_CREATED, varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import { capturarSessaoCartao, CapturaCartaoNaoDefinitivaError } from '../../src/services/pagamentos/capturarSessaoCartao'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { uniqueSuffix } from './helpers/fixtures'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa, criarCenarioCartaoHttp, type CenarioCartaoHttp } from './helpers/cenarioCartaoHttp'

/**
 * Auditoria do Órion (docs/AUDITORIA-PAGAMENTOS-CIELO.md) — I-1 (reconciliação por MerchantOrderId) e I-2 (Status 1 com ReturnCode fora das tabelas), com o adaptador REAL
 * falando por TCP com a "Cielo" falsa e com ESTADO da Íris (`helpers/cieloFalsaHttp.ts`, só reaproveitada — nenhum teste dela foi alterado).
 *
 * O formato `so_ids` é o que a doc da Cielo descreve para `GET /1/sales?merchantOrderId=` (só `PaymentId` + `ReceveidDate`, sic) — AINDA NÃO visto em sandbox.
 */

// Banco próprio (o varredor olha TODOS os intents do banco; no compartilhado ele varreria intents de outras suítes). `vi.hoisted` assíncrono roda antes dos imports estáticos.
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_aud_i1i2')
})

describe('I-1/I-2 — reconciliação por pedido e autorização não definitiva (adaptador real + Cielo falsa por TCP)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  let cen: CenarioCartaoHttp
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }

  beforeAll(async () => {
    await cielo.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 400 })
    cen = await criarCenarioCartaoHttp(app, suffix, 'aud-i1i2')
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
    vi.restoreAllMocks()
  })

  async function iniciarComFalha() {
    const motorista = await cen.novoMotorista(`m${Math.random().toString(36).slice(2, 6)}`)
    const connectorId = await cen.novoConector()
    const res = await cen.iniciar(motorista, connectorId)
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: motorista.user.id }, orderBy: { createdAt: 'desc' } })
    return { res, intent, motorista }
  }
  const intentAtual = (id: string) => prisma.paymentIntent.findUniqueOrThrow({ where: { id } })

  // ------------------------------------------------------------------------------------------------------------------
  describe('I-1 — consulta por pedido que lista só PaymentId (formato da doc)', () => {
    it('timeout depois de a Cielo processar: lista -> GET por PaymentId -> autorização REAL (202, AUTHORIZED); nada em dobro', async () => {
      cielo.agendar('POST_SALE', { processar: true, resposta: 'travar' })
      const { res, intent } = await iniciarComFalha()
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      expect(intent.status).toBe('AUTHORIZED')
      expect(cielo.sequencia({ merchantOrderId: intent.id })).toEqual(['POST_SALE', 'GET_BY_ORDER'])
      expect(cielo.contar('GET_BY_ID')).toBe(1) // o estado vem do detalhe
      expect(cielo.efeitos.vendasCriadas.get(intent.id)).toBe(1)
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
    })

    it('conexão derrubada (sem resposta): 503, intent CREATED; o varredor (B) lista, consulta o detalhe, ACHA a pré-autorização viva e a CANCELA — o órfão deixa de existir', async () => {
      cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
      const { res, intent } = await iniciarComFalha()
      expect(res.status).toBe(503)
      expect(intent.status).toBe('CREATED')
      expect(cielo.vendaPorPedido(intent.id)!.status).toBe(1) // viva no cartão do motorista

      await cen.envelhecer(intent.id, 30)
      const r = await varrerPreAutorizacoesCartao()
      expect(r.resolvidasCreated).toBeGreaterThanOrEqual(1)

      const venda = cielo.vendaPorPedido(intent.id)!
      expect(venda.status).toBe(10)
      expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
      expect(cielo.contar('POST_SALE', { merchantOrderId: intent.id })).toBe(1)
      expect((await intentAtual(intent.id)).status).toBe('VOIDED')
    })

    it('formato ANTIGO (cada item de Payments já com Status/ReturnCode) continua tolerado: resolve SEM o GET por PaymentId', async () => {
      cielo.porPedido = 'completo'
      cielo.agendar('POST_SALE', { processar: true, resposta: 'travar' })
      const { res, intent } = await iniciarComFalha()
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      expect(cielo.contar('GET_BY_ID')).toBe(0)
      expect(intent.status).toBe('AUTHORIZED')
    })

    it('vários pagamentos para o MESMO pedido: escolhe a venda VIVA, não "a última do array" (aqui a última é a cancelada)', async () => {
      const motorista = await cen.novoMotorista(`m${Math.random().toString(36).slice(2, 6)}`)
      const intent = await prisma.paymentIntent.create({
        data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: motorista.user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX' },
      })
      const viva = cielo.plantarVenda({ merchantOrderId: intent.id, status: 1, returnCode: '4', amount: 1_000 })
      cielo.plantarVenda({ merchantOrderId: intent.id, status: 10, returnCode: '0', amount: 1_000 }) // a ÚLTIMA do array é a cancelada
      await cen.envelhecer(intent.id, 30)

      await varrerPreAutorizacoesCartao()

      // Se tivesse escolhido a última (cancelada), nada seria cancelado e a viva ficaria retida. Escolheu a viva e cancelou.
      expect(cielo.vendas.get(viva.paymentId)!.status).toBe(10)
      expect(cielo.efeitos.cancelamentos.get(viva.paymentId)).toBe(1)
      expect((await intentAtual(intent.id)).status).toBe('VOIDED')
    })

    it('SEM STARVATION: 55 intents CREATED velhos que a Cielo não conhece (ainda não esgotados) NÃO impedem a rodada de chegar ao órfão mais novo (ordem por createdAt + paginação por cursor)', async () => {
      const motorista = await cen.novoMotorista(`m${Math.random().toString(36).slice(2, 6)}`)
      const agora = Date.now()
      // 55 intents de 10 min de idade (acima do abandono de 5, abaixo da desistência de 15): a Cielo não tem registro -> adiados, não resolvidos.
      await prisma.paymentIntent.createMany({
        data: Array.from({ length: 55 }, () => ({ purpose: 'SESSION_CARD_CAPTURE' as const, provider: 'CIELO_CARD' as const, userId: motorista.user.id, amountRequestedCents: 500, status: 'CREATED' as const, environment: 'SANDBOX' as const, createdAt: new Date(agora - 10 * 60_000) })),
      })
      // o órfão de verdade: mais NOVO (8 min) que os 55, com venda viva na Cielo
      const orfao = await prisma.paymentIntent.create({
        data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: motorista.user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX', createdAt: new Date(agora - 8 * 60_000) },
      })
      const venda = cielo.plantarVenda({ merchantOrderId: orfao.id, status: 1, returnCode: '4', amount: 1_000 })

      await varrerPreAutorizacoesCartao()

      expect(cielo.vendas.get(venda.paymentId)!.status).toBe(10)
      expect((await intentAtual(orfao.id)).status).toBe('VOIDED')
    }, 60_000)
  })

  // ------------------------------------------------------------------------------------------------------------------
  describe('I-1/I-2 — o loop infinito do relatório (intent CREATED com PaymentId, Status 1 com ReturnCode fora das tabelas) agora é resolvido', () => {
    async function iniciarComStatus1CodigoDesconhecido(returnCode: string | null) {
      cielo.agendar('POST_SALE', { processar: true, venda: { status: 1, returnCode } })
      const r = await iniciarComFalha()
      return r
    }

    it('Status 1 + ReturnCode "88" no momento da autorização: 503 (NÃO 402/DENIED), nenhum idTag, intent CREATED COM o PaymentId — e o alerta com o PaymentId sai', async () => {
      const erro = vi.spyOn(logger, 'error')
      const { res, intent } = await iniciarComStatus1CodigoDesconhecido('88')
      expect(res.status).toBe(503)
      expect(intent.status).toBe('CREATED')
      expect(intent.cieloPaymentId).toBeTruthy()
      expect(await prisma.authToken.count({ where: { userId: intent.userId, type: 'VIRTUAL' } })).toBe(0)
      const alerta = erro.mock.calls.find((c) => (c[0] as { alert?: string }).alert === 'payment_authorized_status_unlisted_returncode')
      expect(alerta).toBeTruthy()
      expect((alerta![0] as { paymentId?: string }).paymentId).toBe(intent.cieloPaymentId)
    })

    it('REPRODUÇÃO do relatório: antes da correção o varredor B caía em "nada a fazer" PARA SEMPRE e a venda ficava viva. Agora reconsulta por PaymentId a cada rodada e, ao esgotar a idade, CANCELA por precaução (consulta antes) — a venda deixa de estar viva', async () => {
      const { intent } = await iniciarComStatus1CodigoDesconhecido('88')
      const venda = cielo.vendaPorPedido(intent.id)!
      expect(venda.status).toBe(1)

      // Antes de esgotar (30 min: acima do abandono, abaixo de 3x): reconsulta POR PaymentId (não por pedido), sem void e sem sair de CREATED.
      await cen.envelhecer(intent.id, 10)
      const antes = cielo.chamadas.length
      await varrerPreAutorizacoesCartao()
      await varrerPreAutorizacoesCartao()
      const novas = cielo.chamadas.slice(antes)
      expect(novas.some((c) => c.rota === 'GET_BY_ID' && c.paymentId === venda.paymentId)).toBe(true)
      expect(novas.some((c) => c.rota === 'GET_BY_ORDER' && c.merchantOrderId === intent.id)).toBe(false) // com PaymentId no intent NÃO consulta por pedido
      expect(novas.some((c) => c.rota === 'PUT_VOID')).toBe(false)
      expect((await intentAtual(intent.id)).status).toBe('CREATED')

      // Esgotado (idade > 3x o abandono): cancela.
      const erro = vi.spyOn(logger, 'error')
      await cen.envelhecer(intent.id, 60)
      await varrerPreAutorizacoesCartao()
      expect(cielo.vendas.get(venda.paymentId)!.status).toBe(10)
      expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
      expect((await intentAtual(intent.id)).status).toBe('VOIDED')
      const alertas = erro.mock.calls.map((c) => (c[0] as { alert?: string }).alert)
      expect(alertas).toContain('payment_authorization_stuck')
      expect(alertas).toContain('payment_authorized_status_unlisted_returncode')
    })

    it('esgota também por NÚMERO de reconsultas (MAX_TENTATIVAS_CREATED), sem depender da idade', async () => {
      const { intent } = await iniciarComStatus1CodigoDesconhecido(null) // ReturnCode AUSENTE
      const venda = cielo.vendaPorPedido(intent.id)!
      await cen.envelhecer(intent.id, 10)
      await redis.set(`card-preauth:created-sweeps:${intent.id}`, String(MAX_TENTATIVAS_CREATED - 1), 'EX', 600)

      await varrerPreAutorizacoesCartao()

      expect(cielo.vendas.get(venda.paymentId)!.status).toBe(10)
      expect((await intentAtual(intent.id)).status).toBe('VOIDED')
    })

    it('Status 1 com ReturnCode de RECUSA CONHECIDO (51) continua recusa de verdade: 402 + DENIED, sem ReturnCode na resposta', async () => {
      const { res, intent } = await iniciarComStatus1CodigoDesconhecido('51')
      expect(res.status).toBe(402)
      expect(JSON.stringify(res.body)).not.toMatch(/51|ReturnCode/)
      expect(intent.status).toBe('DENIED')
    })

    it('CAPTURA: Status 1 com ReturnCode ausente na consulta NÃO vira FAILED + dívida integral — é não definitivo (lança, o job retenta) e o intent segue CAPTURE_PENDING', async () => {
      const s = await cen.sessaoParada('cap-i2')
      cielo.vendas.get(s.cieloPaymentId)!.returnCode = null // a consulta passa a devolver Status 1 sem ReturnCode
      await expect(capturarSessaoCartao(s.intentId)).rejects.toBeInstanceOf(CapturaCartaoNaoDefinitivaError)
      expect((await intentAtual(s.intentId)).status).toBe('CAPTURE_PENDING')
      expect(await prisma.debt.count({ where: { paymentIntentId: s.intentId } })).toBe(0)
      expect(cielo.contar('PUT_CAPTURE', { paymentId: s.cieloPaymentId })).toBe(0) // e NÃO tentou capturar uma venda que não sabe ler
    })

    it('CAPTURA: Status 2 com ReturnCode fora de 00/4/6 sobe a ERROR já na 1ª consulta, com o PaymentId, e não afirma nem cobrança nem falha', async () => {
      const s = await cen.sessaoParada('cap-i2b')
      const venda = cielo.vendas.get(s.cieloPaymentId)!
      venda.status = 2
      venda.returnCode = '51'
      venda.capturedAmount = 300
      const erro = vi.spyOn(logger, 'error')
      await expect(capturarSessaoCartao(s.intentId)).rejects.toBeInstanceOf(CapturaCartaoNaoDefinitivaError)
      const alerta = erro.mock.calls.find((c) => (c[0] as { alert?: string }).alert === 'payment_captured_status_unlisted_returncode')
      expect(alerta).toBeTruthy()
      expect((alerta![0] as { paymentId?: string }).paymentId).toBe(s.cieloPaymentId)
      expect((await intentAtual(s.intentId)).status).toBe('CAPTURE_PENDING')
      expect(await prisma.debt.count({ where: { paymentIntentId: s.intentId } })).toBe(0)
    })
  })

})
