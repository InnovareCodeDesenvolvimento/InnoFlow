import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { uniqueSuffix } from './helpers/fixtures'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa, criarCenarioCartaoHttp, type CenarioCartaoHttp } from './helpers/cenarioCartaoHttp'

/**
 * Íris (C2, 04/10/2026) — RETRIES SEM IDEMPOTÊNCIA, AUTORIZAÇÃO (o ponto mais perigoso do pacote C1/C2).
 * A Cielo API 3.0 não tem chave de idempotência: um 2º `POST /1/sales` para o mesmo pedido COBRA/RETÉM DUAS VEZES. Aqui o adaptador REAL fala por TCP com uma
 * Cielo falsa que (a) processa e cai a conexão, (b) processa e nunca responde, (c) nunca viu o pedido, (d) responde 503. Em todos: Postgres+Redis reais e
 * a contagem do que a Cielo FEZ (`efeitos.vendasCriadas`), não do que a resposta disse.
 */

// BANCO PRÓPRIO (antes de qualquer import da aplicação): o varredor olha TODOS os intents do banco; no banco compartilhado ele varreria (e poderia mexer em) intents de outras suítes
// em paralelo, e intents velhos de rodadas anteriores esgotariam o lote de 50 antes dos meus. `vi.hoisted` assíncrono roda antes dos imports estáticos.
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_real_a')
})

describe('autorização de cartão — nunca um 2º POST /1/sales para o mesmo pedido (adaptador real + Cielo falsa por TCP)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  let cen: CenarioCartaoHttp
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }

  beforeAll(async () => {
    await cielo.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 400 })
    cen = await criarCenarioCartaoHttp(app, suffix, 'auth-real')
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
  beforeEach(() => cielo.zerarRegistro())

  async function iniciarComFalha() {
    const motorista = await cen.novoMotorista(`m${Math.random().toString(36).slice(2, 6)}`)
    const connectorId = await cen.novoConector()
    const res = await cen.iniciar(motorista, connectorId)
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: motorista.user.id }, orderBy: { createdAt: 'desc' } })
    return { res, intent, motorista }
  }

  it('CONTROLE: caminho feliz — 1 POST, resposta 202, intent AUTHORIZED com PaymentId/Tid/AuthorizationCode/ProofOfSale gravados; nenhuma consulta nem cancelamento', async () => {
    const { res, intent } = await iniciarComFalha()
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(cielo.contar('POST_SALE')).toBe(1)
    expect(cielo.sequencia()).toEqual(['POST_SALE'])
    const venda = cielo.vendaPorPedido(intent.id)!
    expect(intent).toMatchObject({ status: 'AUTHORIZED', cieloPaymentId: venda.paymentId, returnCode: '4', cieloTid: String(venda.tid), cieloAuthorizationCode: venda.authorizationCode, cieloProofOfSale: venda.proofOfSale })
  })

  it('Cielo PROCESSA e a conexão CAI (ECONNRESET, sem resposta): 503, intent CREATED, exatamente 1 POST; o varredor reconsulta por MerchantOrderId e CANCELA a pré-autorização que ninguém pode usar — nunca um 2º POST', async () => {
    cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
    const { res, intent } = await iniciarComFalha()
    expect(res.status).toBe(503)
    expect(res.body.error?.code ?? res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
    expect(intent.status).toBe('CREATED')
    expect(cielo.efeitos.vendasCriadas.get(intent.id)).toBe(1) // a Cielo AUTORIZOU (reteve o limite do cartão)
    expect(await prisma.authToken.count({ where: { userId: intent.userId, type: 'VIRTUAL' } })).toBe(0) // nenhum idTag foi emitido

    await cen.envelhecer(intent.id, 30)
    const r = await varrerPreAutorizacoesCartao()
    expect(r.resolvidasCreated).toBeGreaterThanOrEqual(1)

    const venda = cielo.vendaPorPedido(intent.id)!
    expect(venda.status).toBe(10) // cancelada no mundo da Cielo
    expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
    expect(cielo.efeitos.vendasCriadas.get(intent.id)).toBe(1) // continua UMA venda
    expect(cielo.contar('POST_SALE', { merchantOrderId: intent.id })).toBe(1)
    expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('VOIDED')
  })

  it('Cielo PROCESSA e NUNCA responde (timeout de verdade): o adaptador reconsulta por MerchantOrderId, ACHA a autorização e segue como sucesso — 1 POST, 1 GET, 202, nada em dobro', async () => {
    cielo.agendar('POST_SALE', { processar: true, resposta: 'travar' })
    const { res, intent } = await iniciarComFalha()
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(cielo.sequencia({ merchantOrderId: intent.id })).toEqual(['POST_SALE', 'GET_BY_ORDER'])
    expect(cielo.efeitos.vendasCriadas.get(intent.id)).toBe(1)
    const venda = cielo.vendaPorPedido(intent.id)!
    expect(intent).toMatchObject({ status: 'AUTHORIZED', cieloPaymentId: venda.paymentId })
    expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
  })

  it('Cielo NUNCA VIU o pedido e trava: timeout -> 1 consulta (vazia) -> 503 com intent CREATED; o varredor repete a CONSULTA (nunca o POST) e, passado o horizonte, desiste sem cobrar', async () => {
    cielo.agendar('POST_SALE', { processar: false, resposta: 'travar' })
    const { res, intent } = await iniciarComFalha()
    expect(res.status).toBe(503)
    expect(intent.status).toBe('CREATED')
    expect(cielo.sequencia({ merchantOrderId: intent.id })).toEqual(['POST_SALE', 'GET_BY_ORDER'])

    await cen.envelhecer(intent.id, 6) // acima de CARD_PREAUTH_ABANDON_MINUTES (5), abaixo de 3x: só reconsulta
    await varrerPreAutorizacoesCartao()
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CREATED')
    await cen.envelhecer(intent.id, 20) // além de 3x o horizonte: desiste (FAILED), sem nenhuma venda criada
    await varrerPreAutorizacoesCartao()
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('FAILED')

    expect(cielo.contar('POST_SALE', { merchantOrderId: intent.id })).toBe(1) // jamais um 2º POST
    expect(cielo.contar('GET_BY_ORDER', { merchantOrderId: intent.id })).toBeGreaterThanOrEqual(3)
    expect(cielo.efeitos.vendasCriadas.get(intent.id) ?? 0).toBe(0)
  })

  it('Cielo responde 503 (não processou): o motorista vê 503, 1 POST, intent CREATED; várias rodadas do varredor NUNCA repostam', async () => {
    cielo.agendar('POST_SALE', { processar: false, resposta: { http: 503, bruto: 'Service Unavailable' } })
    const { res, intent } = await iniciarComFalha()
    expect(res.status).toBe(503)
    await cen.envelhecer(intent.id, 6)
    for (let i = 0; i < 3; i++) await varrerPreAutorizacoesCartao()
    expect(cielo.contar('POST_SALE', { merchantOrderId: intent.id })).toBe(1)
    expect(cielo.efeitos.vendasCriadas.get(intent.id) ?? 0).toBe(0)
  })

  it('HTTP 200/201 + Status 1 + ReturnCode 51 (negada dentro de um 2xx): 402, intent DENIED, nenhum idTag, nenhum cancelamento; o Tid da tentativa recusada fica gravado', async () => {
    cielo.agendar('POST_SALE', { venda: { status: 1, returnCode: '51', tid: 'TID-DA-RECUSA' } })
    const { res, intent } = await iniciarComFalha()
    expect(res.status).toBe(402)
    expect(intent).toMatchObject({ status: 'DENIED', returnCode: '51', cieloTid: 'TID-DA-RECUSA' })
    expect(await prisma.authToken.count({ where: { userId: intent.userId, type: 'VIRTUAL' } })).toBe(0)
    expect(cielo.contar('PUT_VOID')).toBe(0)
  })

  it('Status 2 SEM ReturnCode na autorização (resposta que não sabemos ler): 503, nada iniciado, intent CREATED com o PaymentId guardado — o varredor reconsulta, não repete o POST', async () => {
    cielo.agendar('POST_SALE', { corpoRespostaCru: { MerchantOrderId: 'x', Payment: { PaymentId: 'pay-sem-codigo', Status: 2, Amount: 1000 } } })
    const { res, intent } = await iniciarComFalha()
    expect(res.status).toBe(503)
    expect(intent).toMatchObject({ status: 'CREATED', cieloPaymentId: 'pay-sem-codigo' })
    expect(await prisma.authToken.count({ where: { userId: intent.userId, type: 'VIRTUAL' } })).toBe(0)
    expect(cielo.contar('POST_SALE')).toBe(1)
  })

  it('Identificadores acima de 64 caracteres na AUTORIZAÇÃO: o fluxo NÃO cai (202), grava truncado em 64 e avisa por alerta (só nomes de campo, nunca o valor)', async () => {
    const grande = 'T'.repeat(90)
    const aviso = vi.spyOn(logger, 'warn')
    cielo.agendar('POST_SALE', { venda: { tid: grande, authorizationCode: 'A'.repeat(70), proofOfSale: '123456' } })
    const { res, intent } = await iniciarComFalha()
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(intent.cieloTid).toBe('T'.repeat(64))
    expect(intent.cieloAuthorizationCode).toBe('A'.repeat(64))
    expect(intent.cieloProofOfSale).toBe('123456')
    const chamadasDoAlerta = aviso.mock.calls.filter((c) => (c[0] as { alert?: string } | undefined)?.alert === 'payment_cielo_identifier_truncated')
    expect(chamadasDoAlerta.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(chamadasDoAlerta)).not.toContain(grande)
    expect(JSON.stringify(chamadasDoAlerta)).toContain('Tid')
    aviso.mockRestore()
  })

  it('Tid numérico no JSON vira texto; Tid/AuthorizationCode ausentes ficam NULL (nunca "null" nem "undefined" em texto)', async () => {
    cielo.agendar('POST_SALE', { venda: { tid: 1234567890123, authorizationCode: null, proofOfSale: null } })
    const { res, intent } = await iniciarComFalha()
    expect(res.status).toBe(202)
    expect(intent.cieloTid).toBe('1234567890123')
    expect(intent.cieloAuthorizationCode).toBeNull()
    expect(intent.cieloProofOfSale).toBeNull()
  })

  /**
   * RISCO MEDIDO (Íris): `GET /1/sales?merchantOrderId=` — o adaptador ASSUME que cada item de `Payments` traz Status/ReturnCode/Amount. A referência da Cielo que a
   * Íris conhece descreve esse endpoint devolvendo SÓ `PaymentId` + data de recebimento (item com `PaymentId` e `ReceveidDate`), sendo preciso um 2º GET por PaymentId
   * para o status. NÃO CONFIRMADO contra a Cielo real (não há sandbox aqui) — por isso o teste usa uma Cielo falsa configurada nesse formato (`porPedido: 'so_ids'`).
   * Se for assim, a RECONCILIAÇÃO PÓS-TIMEOUT e o CASO B do varredor nunca resolvem: `Status` ausente => UNKNOWN => CREATED para sempre, e a pré-autorização
   * viva fica retida no cartão do motorista sem ninguém cancelar. Os testes `it.fails` abaixo descrevem o comportamento DESEJADO; viram `it` quando o adaptador
   * seguir com `GET /1/sales/{PaymentId}` ao receber um item sem Status.
   */
  describe('RISCO — consulta por MerchantOrderId que devolve só PaymentId (formato descrito na referência da Cielo; a confirmar no sandbox)', () => {
    beforeEach(() => {
      cielo.porPedido = 'so_ids'
    })
    afterAll(() => {
      cielo.porPedido = 'completo'
    })

    it.fails('timeout depois de a Cielo processar: o adaptador deveria completar a consulta por PaymentId e seguir com a autorização real (202) — hoje fica sem resposta definitiva (503)', async () => {
      cielo.agendar('POST_SALE', { processar: true, resposta: 'travar' })
      const { res, intent } = await iniciarComFalha()
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      expect(intent.status).toBe('AUTHORIZED')
    })

    it.fails('varredor (caso B): pré-autorização órfã com consulta que devolve só PaymentId deveria ser cancelada — hoje fica viva para sempre (PUT void nunca sai)', async () => {
      cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
      const { intent } = await iniciarComFalha()
      await cen.envelhecer(intent.id, 30)
      await varrerPreAutorizacoesCartao()
      await varrerPreAutorizacoesCartao()
      const venda = cielo.vendaPorPedido(intent.id)!
      expect(venda.status).toBe(10)
      expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
    })

    it('MEDIÇÃO do estado atual nesse formato: o intent fica CREATED e a venda VIVA na Cielo depois de 3 rodadas do varredor (retenção no cartão sem dono)', async () => {
      cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
      const { intent } = await iniciarComFalha()
      await cen.envelhecer(intent.id, 30)
      for (let i = 0; i < 3; i++) await varrerPreAutorizacoesCartao()
      const venda = cielo.vendaPorPedido(intent.id)!
      expect(venda.status).toBe(1) // ainda autorizada lá
      expect(cielo.contar('PUT_VOID')).toBe(0)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CREATED')
    })
  })

  /**
   * Status 1 com um ReturnCode FORA de {00, 4} (a Vega estreitou o {00,0,4,6} do Parque): o motorista é tratado como RECUSADO e o intent vira DENIED — mas se a
   * Cielo de fato autorizou (retém o limite), ninguém cancela: DENIED não é visitado por nenhum varredor. Probabilidade baixa (a documentação só emite 4/00 num Status 1),
   * custo alto se acontecer (limite do cartão retido sem rastro). Teste de CARACTERIZAÇÃO: fixa o comportamento atual para a decisão ser consciente.
   */
  it('CARACTERIZAÇÃO — Status 1 + ReturnCode "6": 402/DENIED e a autorização continua VIVA na Cielo sem nenhum PUT void (órfã)', async () => {
    cielo.agendar('POST_SALE', { venda: { status: 1, returnCode: '6' } })
    const { res, intent } = await iniciarComFalha()
    expect(res.status).toBe(402)
    expect(intent.status).toBe('DENIED')
    expect(intent.cieloPaymentId).toBeTruthy()
    await cen.envelhecer(intent.id, 60)
    for (let i = 0; i < 3; i++) await varrerPreAutorizacoesCartao()
    expect(cielo.vendaPorPedido(intent.id)!.status).toBe(1) // retida na Cielo
    expect(cielo.contar('PUT_VOID')).toBe(0)
  })
})
