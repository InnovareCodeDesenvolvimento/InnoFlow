import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { getPagamentoPort, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
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

    it('(I-1, CORRIGIDO na rodada 2) timeout depois de a Cielo processar: o adaptador completa a consulta por PaymentId e segue com a autorização real (202)', async () => {
      cielo.agendar('POST_SALE', { processar: true, resposta: 'travar' })
      const { res, intent } = await iniciarComFalha()
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      expect(intent.status).toBe('AUTHORIZED')
    })

    it('(I-1, CORRIGIDO na rodada 2) varredor (caso B): pré-autorização órfã com consulta que devolve só PaymentId é cancelada', async () => {
      cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
      const { intent } = await iniciarComFalha()
      await cen.envelhecer(intent.id, 30)
      await varrerPreAutorizacoesCartao()
      await varrerPreAutorizacoesCartao()
      const venda = cielo.vendaPorPedido(intent.id)!
      expect(venda.status).toBe(10)
      expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
    })

    // MUDANÇA DELIBERADA (rodada 2): era a MEDIÇÃO do estado antigo (intent CREATED e venda VIVA na Cielo depois de 3 rodadas). Agora a mesma situação termina em VOIDED.
    it('(rodada 2) o mesmo cenário depois de 3 rodadas do varredor: venda CANCELADA na Cielo e intent VOIDED, 1 só cancelamento efetivo e consulta ANTES de cada PUT', async () => {
      cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
      const { intent } = await iniciarComFalha()
      await cen.envelhecer(intent.id, 30)
      for (let i = 0; i < 3; i++) await varrerPreAutorizacoesCartao()
      const venda = cielo.vendaPorPedido(intent.id)!
      expect(venda.status).toBe(10)
      expect(cielo.efeitos.cancelamentos.get(venda.paymentId)).toBe(1)
      expect(cielo.contar('POST_SALE', { merchantOrderId: intent.id })).toBe(1)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('VOIDED')
      expect(cielo.escritasSemConsultaPrevia(true)).toEqual([])
    })

    it('a DATA decide, não o estado: a venda MAIS RECENTE (negada) vence a mais antiga ainda VIVA (autorizada) — grafia ReceveidDate (sic) lida na lista', async () => {
      const id = `ord-data-${Math.random().toString(36).slice(2, 8)}`
      const antigaViva = cielo.plantarVenda({ merchantOrderId: id, status: 1, returnCode: '4' })
      const recenteNegada = cielo.plantarVenda({ merchantOrderId: id, status: 3, returnCode: '51' })
      cielo.datasPorPedido.set(antigaViva.paymentId, '2026-10-04 09:00:00')
      cielo.datasPorPedido.set(recenteNegada.paymentId, '2026-10-04 09:30:00')
      try {
        const r = await (await getPagamentoPort()).consultarPorPedido(id)
        expect(r).toMatchObject({ providerPaymentId: recenteNegada.paymentId, status: 'FAILED' })
      } finally {
        cielo.datasPorPedido.clear()
      }
    })

    it('mais de 5 vendas para o mesmo pedido: só as 5 MAIS RECENTES são detalhadas (não as 5 primeiras da lista) e a mais recente é a escolhida; no máximo 5 GET de detalhe', async () => {
      const id = `ord-sete-${Math.random().toString(36).slice(2, 8)}`
      const vendas = Array.from({ length: 7 }, (_, i) => cielo.plantarVenda({ merchantOrderId: id, status: 3, returnCode: '51', paymentId: `sete-${i}-${Math.random().toString(36).slice(2, 6)}` }))
      vendas.forEach((v, i) => cielo.datasPorPedido.set(v.paymentId, `2026-10-04 10:0${i}:00`)) // a lista vem do mais antigo para o mais novo (a mais nova é a ÚLTIMA)
      vendas[6].status = 1
      vendas[6].returnCode = '4'
      try {
        const antes = cielo.contar('GET_BY_ID')
        const r = await (await getPagamentoPort()).consultarPorPedido(id)
        expect(r).toMatchObject({ providerPaymentId: vendas[6].paymentId, status: 'AUTHORIZED' })
        expect(cielo.contar('GET_BY_ID') - antes).toBe(5)
      } finally {
        cielo.datasPorPedido.clear()
      }
    })

    it('venda de OUTRO pedido listada por engano na consulta por pedido NUNCA é a resposta (confere o MerchantOrderId da venda detalhada)', async () => {
      const outro = cielo.plantarVenda({ merchantOrderId: `outro-pedido-${Math.random().toString(36).slice(2, 8)}`, status: 1, returnCode: '4' })
      cielo.agendar('GET_BY_ORDER', { corpoRespostaCru: { Payments: [{ PaymentId: outro.paymentId, ReceveidDate: '2026-10-04 10:00:00' }] } })
      const port = await getPagamentoPort()
      expect(await port.consultarPorPedido(`ord-sem-venda-${Math.random().toString(36).slice(2, 8)}`)).toBeNull()
    })

    it('formato ANTIGO (item de Payments já com Status/ReturnCode/Amount) continua tolerado: mesmo cenário, mesmo resultado', async () => {
      cielo.porPedido = 'completo'
      cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
      const { intent } = await iniciarComFalha()
      await cen.envelhecer(intent.id, 30)
      await varrerPreAutorizacoesCartao()
      expect(cielo.vendaPorPedido(intent.id)!.status).toBe(10)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('VOIDED')
    })

    it('a grafia `ReceveidDate` (sic) e `ReceivedDate` escolhem a venda MAIS RECENTE do pedido (não "a última do array"), com alerta de múltiplas vendas', async () => {
      const id = `ord-multi-${Math.random().toString(36).slice(2, 8)}`
      const velha = cielo.plantarVenda({ merchantOrderId: id, status: 3, returnCode: '51' }) // negada, mais antiga
      const nova = cielo.plantarVenda({ merchantOrderId: id, status: 1, returnCode: '4' }) // autorizada, mais recente
      // a lista devolve a mais RECENTE primeiro (ordem "errada" para quem pega o último do array)
      cielo.datasPorPedido.set(velha.paymentId, '2026-10-04 10:00:00')
      cielo.datasPorPedido.set(nova.paymentId, '2026-10-04 10:05:00')
      cielo.ordemInvertidaNaLista = true
      try {
        const aviso = vi.spyOn(logger, 'warn')
        const port = await getPagamentoPort()
        const r = await port.consultarPorPedido(id)
        expect(r).toMatchObject({ providerPaymentId: nova.paymentId, status: 'AUTHORIZED' })
        expect(aviso.mock.calls.some((c) => (c[0] as { alert?: string } | undefined)?.alert === 'payment_reconciliation_multiple_payments')).toBe(true)
        aviso.mockRestore()
      } finally {
        cielo.ordemInvertidaNaLista = false
        cielo.datasPorPedido.clear()
      }
    })
  })

  /**
   * I-2 (rodada 2). Status 1 com ReturnCode FORA das tabelas (ou AUSENTE) deixou de ser recusa: é NÃO DEFINITIVO (503 ao motorista, intent CREATED com o PaymentId, nenhum idTag)
   * e o varredor reconsulta; ao esgotar (idade > 3x o abandono OU 30 reconsultas) a autorização é tratada como possivelmente VIVA e CANCELADA por precaução. Era a CARACTERIZAÇÃO
   * "402/DENIED e a venda continua viva" — MUDANÇA DELIBERADA.
   */
  describe('I-2 (rodada 2) — Status 1 com ReturnCode desconhecido ou ausente', () => {
    it('Status 1 + ReturnCode "6": 503, intent CREATED (com PaymentId, ReturnCode e Tid), nenhum idTag, alerta com o PaymentId; reconsulta sem cancelar enquanto não esgota', async () => {
      const erro = vi.spyOn(logger, 'error')
      cielo.agendar('POST_SALE', { venda: { status: 1, returnCode: '6' } })
      const { res, intent } = await iniciarComFalha()
      expect(res.status).toBe(503)
      expect(intent).toMatchObject({ status: 'CREATED', returnCode: '6' })
      expect(intent.cieloPaymentId).toBe(cielo.vendaPorPedido(intent.id)!.paymentId)
      expect(await prisma.authToken.count({ where: { userId: intent.userId, type: 'VIRTUAL' } })).toBe(0)
      const alertas = erro.mock.calls.filter((c) => (c[0] as { alert?: string } | undefined)?.alert === 'payment_authorized_status_unlisted_returncode')
      expect(alertas.length).toBeGreaterThanOrEqual(1)
      expect((alertas[0][0] as { paymentId?: string }).paymentId).toBe(intent.cieloPaymentId)
      erro.mockRestore()

      await cen.envelhecer(intent.id, 6) // acima do abandono (5), abaixo de 3x: reconsulta, NÃO cancela ainda
      await varrerPreAutorizacoesCartao()
      expect(cielo.contar('PUT_VOID')).toBe(0)
      expect(cielo.vendaPorPedido(intent.id)!.status).toBe(1)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CREATED')
    })

    it('esgotado pela IDADE (> 3x o abandono): alerta `payment_authorization_stuck` com o PaymentId, a CHECK não prende o intent e a autorização é CANCELADA (VOIDED na Cielo e no banco)', async () => {
      cielo.agendar('POST_SALE', { venda: { status: 1, returnCode: '6' } })
      const { intent } = await iniciarComFalha()
      await cen.envelhecer(intent.id, 60)
      const erro = vi.spyOn(logger, 'error')
      await varrerPreAutorizacoesCartao()
      const stuck = erro.mock.calls.filter((c) => (c[0] as { alert?: string } | undefined)?.alert === 'payment_authorization_stuck')
      erro.mockRestore()
      expect(stuck).toHaveLength(1)
      expect((stuck[0][0] as { paymentId?: string }).paymentId).toBe(intent.cieloPaymentId)
      expect(cielo.vendaPorPedido(intent.id)!.status).toBe(10)
      expect(cielo.efeitos.cancelamentos.get(intent.cieloPaymentId!)).toBe(1)
      expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'VOIDED', returnCode: '0' })
    })

    it('esgotado pelo CONTADOR REDIS (30 reconsultas), com o intent ainda JOVEM: a 30ª reconsulta cancela; antes dela, nada', async () => {
      cielo.agendar('POST_SALE', { venda: { status: 1, returnCode: '6' } })
      const { intent } = await iniciarComFalha()
      await cen.envelhecer(intent.id, 6)
      await redis.set(`card-preauth:created-sweeps:${intent.id}`, '28', 'EX', 600)
      await varrerPreAutorizacoesCartao() // 29ª
      expect(cielo.contar('PUT_VOID')).toBe(0)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('CREATED')
      await varrerPreAutorizacoesCartao() // 30ª
      expect(cielo.vendaPorPedido(intent.id)!.status).toBe(10)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('VOIDED')
    })

    it('Status 1 SEM ReturnCode na autorização: 503/CREATED; esgotado, o UPDATE para AUTHORIZED NÃO viola a CHECK `payment_intent_return_code_required` (sentinela NAO_INFORMADO) e o intent não fica preso', async () => {
      cielo.agendar('POST_SALE', { processar: false, corpoRespostaCru: { MerchantOrderId: 'x', Payment: { PaymentId: 'pay-sem-rc-r2', Status: 1, Amount: 1000 } } })
      const { res, intent } = await iniciarComFalha()
      expect(res.status).toBe(503)
      expect(intent).toMatchObject({ status: 'CREATED', cieloPaymentId: 'pay-sem-rc-r2' })
      // a Cielo, no mundo real, TEM a venda: planta com esse PaymentId e sem ReturnCode
      cielo.plantarVenda({ merchantOrderId: intent.id, paymentId: 'pay-sem-rc-r2', status: 1, returnCode: null })
      await cen.envelhecer(intent.id, 60)
      const erro = vi.spyOn(logger, 'error')
      await varrerPreAutorizacoesCartao()
      erro.mockRestore()
      const depois = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      expect(depois.status).toBe('VOIDED')
      expect(depois.status).not.toBe('CREATED')
      expect(cielo.vendaPorPedido(intent.id)!.status).toBe(10)
    })

    it('55 intents CREATED velhos e NÃO definitivos na frente NÃO geram fome: um intent mais novo (depois deles) é resolvido e CANCELADO na mesma rodada', async () => {
      const velhos: string[] = []
      for (let i = 0; i < 55; i++) {
        const m = await cen.novoMotorista(`fome-${i}`)
        const pagamentoPendente = cielo.plantarVenda({ merchantOrderId: `ord-pend-${i}-${suffix}`, status: 12, returnCode: '0' }) // Status 12: a Cielo ainda processa — nunca definitivo
        const it2 = await prisma.paymentIntent.create({
          data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: m.user.id, paymentMethodId: m.paymentMethod.id, amountRequestedCents: 1000, status: 'CREATED', environment: 'SANDBOX', cieloPaymentId: pagamentoPendente.paymentId, createdAt: new Date(Date.now() - (14 * 60_000 - i * 1000)) },
        })
        velhos.push(it2.id)
      }
      // o intent MAIS NOVO (6 min, depois dos 55 na ordem createdAt) é uma autorização REAL cuja resposta se perdeu
      cielo.agendar('POST_SALE', { processar: true, resposta: 'derrubar' })
      const { intent } = await iniciarComFalha()
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { createdAt: new Date(Date.now() - 6 * 60_000) } })
      await varrerPreAutorizacoesCartao()
      expect(cielo.vendaPorPedido(intent.id)!.status).toBe(10)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('VOIDED')
      // os 55 seguem CREATED (ainda não esgotaram) — foram reconsultados, não travaram a rodada
      expect(await prisma.paymentIntent.count({ where: { id: { in: velhos }, status: 'CREATED' } })).toBe(55)
    }, 90_000)
  })
})
