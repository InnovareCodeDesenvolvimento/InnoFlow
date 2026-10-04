import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { creditarTopupPix } from '../../src/services/pagamentos/creditarTopupPix'
import { capturarSessaoCartao } from '../../src/services/pagamentos/capturarSessaoCartao'
import { varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { cardTokenTemFormatoValido, meCreatePaymentMethodSchema, pareceConterPan } from '../../src/api/schemas/mePaymentMethods.schema'
import { handleStartTransaction } from '../../src/ocpp/handlers/startTransaction'
import { resolveActiveTariff } from '../../src/ocpp/tariffResolution'
import { createUser, uniqueSuffix } from './helpers/fixtures'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa, criarCenarioCartaoHttp, type CenarioCartaoHttp } from './helpers/cenarioCartaoHttp'
import { callHandler } from './helpers/cartaoSessaoFixture'

/**
 * Íris — rodada 2 (04/10/2026), revalidação INDEPENDENTE das correções do Órion/Íris (commits 8181243, f392ff3, 6330db4, 25f262a), pela API de verdade (supertest), com o
 * adaptador REAL falando TCP com a Cielo falsa, Postgres e Redis reais. Banco próprio (os varredores olham o banco inteiro).
 *   I-4 (4xx definitivo vs indisponível) · I-5 (body-parser/webhook) · I-6 (Pix) · S-1 (cardToken) · S-5 · S-7 · tarifa desativada.
 */

const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_real_r2')
})

describe('rodada 2 — API de pagamentos com adaptador real + Cielo falsa por TCP', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  let cen: CenarioCartaoHttp
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }
  let contador = 0

  beforeAll(async () => {
    await cielo.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 400 })
    cen = await criarCenarioCartaoHttp(app, suffix, 'r2')
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

  const alertas = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0] as { alert?: string; [k: string]: unknown }).filter((o) => o?.alert)

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('I-4 — 4xx definitivo da Cielo na AUTORIZAÇÃO vs indisponibilidade', () => {
    const ECO = 'ECO-DA-CIELO-NAO-PODE-VAZAR-AO-MOTORISTA'
    async function tentar(diretiva: Parameters<CieloFalsaHttp['agendar']>[1]) {
      const m = await cen.novoMotorista(`i4-${Math.random().toString(36).slice(2, 7)}`)
      const c = await cen.novoConector()
      cielo.agendar('POST_SALE', diretiva)
      const res = await cen.iniciar(m, c)
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: m.user.id }, orderBy: { createdAt: 'desc' } })
      return { res, intent }
    }

    it.each([
      [400, [{ Code: 126, Message: ECO }]],
      [400, [{ Code: 301, Message: ECO }]],
      [409, [{ Code: 99, Message: ECO }]],
      [422, [{ Code: 1, Message: ECO }]],
    ])('HTTP %s definitivo (cartão/payload recusado): 402 CARD_AUTHORIZATION_DENIED, intent DENIED, nenhum idTag, NADA da Cielo na resposta, 1 POST, nenhum void', async (http, corpo) => {
      const { res, intent } = await tentar({ processar: false, resposta: { http, corpo } })
      expect(res.status).toBe(402)
      expect(res.body.code).toBe('CARD_AUTHORIZATION_DENIED')
      expect(res.text).not.toContain(ECO)
      expect(res.text).not.toMatch(/ReturnCode|Code":\s*\d{2,3}|126|301/)
      expect(intent.status).toBe('DENIED')
      expect(await prisma.authToken.count({ where: { userId: intent.userId, type: 'VIRTUAL' } })).toBe(0)
      expect(cielo.contar('POST_SALE')).toBe(1)
      expect(cielo.contar('PUT_VOID')).toBe(0)
    })

    it.each([
      ['400 com código de CREDENCIAL (132)', { processar: false, resposta: { http: 400, corpo: [{ Code: 132, Message: ECO }] } }],
      ['401', { processar: false, resposta: { http: 401, corpo: [{ Code: 1, Message: ECO }] } }],
      ['403 (IP fora da lista)', { processar: false, resposta: { http: 403, corpo: { Message: ECO } } }],
      ['404', { processar: false, resposta: { http: 404, corpo: [{ Code: 404, Message: ECO }] } }],
      ['429', { processar: false, resposta: { http: 429, corpo: { Message: ECO } } }],
      ['500', { processar: false, resposta: { http: 500, bruto: ECO } }],
      ['502', { processar: false, resposta: { http: 502, bruto: ECO } }],
      ['503', { processar: false, resposta: { http: 503, bruto: ECO } }],
      ['timeout (processada e sem resposta, consulta vazia)', { processar: false, resposta: 'travar' as const }],
      ['queda de conexão (nunca viu o pedido)', { processar: false, resposta: 'derrubar' as const }],
    ] as const)('%s: 503 PAYMENT_GATEWAY_UNAVAILABLE e o intent NÃO vira DENIED (fica CREATED para o varredor); nada da Cielo na resposta', async (_nome, diretiva) => {
      const { res, intent } = await tentar(diretiva as Parameters<CieloFalsaHttp['agendar']>[1])
      expect(res.status).toBe(503)
      expect(res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
      expect(res.text).not.toContain(ECO)
      expect(intent.status).toBe('CREATED')
      expect(cielo.contar('POST_SALE', { merchantOrderId: intent.id })).toBe(1)
    })

    it('4xx definitivo: cada tentativa cria 1 intent e 1 POST (nunca repete), e a 2ª tentativa do mesmo motorista com cartão ruim também é 402 (não "indisponível para sempre")', async () => {
      const m = await cen.novoMotorista('i4-repete')
      const c1 = await cen.novoConector()
      cielo.agendar('POST_SALE', { processar: false, resposta: { http: 400, corpo: [{ Code: 126, Message: ECO }] } }, { processar: false, resposta: { http: 400, corpo: [{ Code: 126, Message: ECO }] } })
      expect((await cen.iniciar(m, c1)).status).toBe(402)
      expect((await cen.iniciar(m, c1)).status).toBe(402)
      expect(cielo.contar('POST_SALE')).toBe(2)
      expect(await prisma.paymentIntent.count({ where: { userId: m.user.id, status: 'DENIED' } })).toBe(2)
    })

    it('S-7 — a Cielo autoriza um VALOR diferente do pedido: segue (202) e avisa `payment_authorized_amount_mismatch` com os dois valores', async () => {
      const aviso = vi.spyOn(logger, 'warn')
      const { res, intent } = await tentar({ processar: false, corpoRespostaCru: { MerchantOrderId: 'x', Payment: { PaymentId: `pay-${randomUUID()}`, Status: 1, ReturnCode: '4', Amount: 4321 } } })
      const lista = alertas(aviso)
      aviso.mockRestore()
      expect(res.status).toBe(202)
      const a = lista.find((x) => x.alert === 'payment_authorized_amount_mismatch')!
      expect(a).toBeTruthy()
      expect(a.authorizedCents).toBe(4321)
      expect(a.requestedCents).toBe(intent.amountRequestedCents)
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('I-6 — Pix só vira PENDING com PaymentId + QR + status pendente; o crédito confere identidade e valor', () => {
    async function recarregar(valor = 1000) {
      contador += 1
      const driver = await createUser({ role: 'DRIVER', label: `pix-r2-${contador}`, suffix })
      const res = await request(app).post('/api/me/wallet/topups').set('Authorization', `Bearer ${driver.token}`).send({ amountCents: valor })
      const intent = await prisma.paymentIntent.findFirst({ where: { userId: driver.id, purpose: 'WALLET_TOPUP_PIX' }, orderBy: { createdAt: 'desc' } })
      return { res, intent, driver }
    }
    const corpoPix = (extra: Record<string, unknown>) => ({ MerchantOrderId: 'x', Payment: { Type: 'Pix', ...extra } })

    it.each([
      ['Status 13 (abortado)', corpoPix({ PaymentId: 'pay-a', Status: 13, ReturnCode: '0', QrCodeString: '000201' })],
      ['Status 3 (negado)', corpoPix({ PaymentId: 'pay-b', Status: 3, ReturnCode: '0', QrCodeString: '000201' })],
      ['Status 2 (já pago?!) na criação', corpoPix({ PaymentId: 'pay-c', Status: 2, ReturnCode: '0', QrCodeString: '000201' })],
      ['sem QR', corpoPix({ PaymentId: 'pay-d', Status: 12, ReturnCode: '0' })],
      ['QR vazio', corpoPix({ PaymentId: 'pay-e', Status: 12, ReturnCode: '0', QrCodeString: '   ' })],
      ['sem PaymentId', corpoPix({ Status: 12, ReturnCode: '0', QrCodeString: '000201' })],
      ['PaymentId vazio', corpoPix({ PaymentId: '', Status: 12, ReturnCode: '0', QrCodeString: '000201' })],
      ['sem Status', corpoPix({ PaymentId: 'pay-f', ReturnCode: '0', QrCodeString: '000201' })],
    ])('%s: 503, intent FAILED, nada de 201 nem de 500, e o limite de pendentes NÃO é consumido (a tentativa seguinte do mesmo motorista funciona)', async (_n, cru) => {
      contador += 1
      const driver = await createUser({ role: 'DRIVER', label: `pix-r2-${contador}`, suffix })
      const enviar = () => request(app).post('/api/me/wallet/topups').set('Authorization', `Bearer ${driver.token}`).send({ amountCents: 1000 })
      cielo.agendar('POST_SALE', { processar: false, corpoRespostaCru: cru })
      const r1 = await enviar()
      expect(r1.status, JSON.stringify(r1.body)).toBe(503)
      expect(r1.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE')
      expect(await prisma.paymentIntent.count({ where: { userId: driver.id, status: 'FAILED' } })).toBe(1)
      expect(await prisma.paymentIntent.count({ where: { userId: driver.id, status: 'PENDING' } })).toBe(0)
      const r2 = await enviar() // limite default = 1 pendente: se a falha tivesse ficado PENDING, aqui viria 409
      expect(r2.status, JSON.stringify(r2.body)).toBe(201)
    })

    it('DOIS Pix seguidos sem PaymentId (o `@unique` de cieloPaymentId colidiria com string vazia): ambos 503, nenhum 500', async () => {
      cielo.agendar('POST_SALE', { processar: false, corpoRespostaCru: corpoPix({ PaymentId: '', Status: 12, ReturnCode: '0', QrCodeString: 'q' }) }, { processar: false, corpoRespostaCru: corpoPix({ PaymentId: '', Status: 12, ReturnCode: '0', QrCodeString: 'q' }) })
      expect((await recarregar()).res.status).toBe(503)
      expect((await recarregar()).res.status).toBe(503)
    })

    it('Pix normal (Status 12 + PaymentId + QR): 201 PENDING', async () => {
      const { res, intent } = await recarregar()
      expect(res.status).toBe(201)
      expect(intent!.status).toBe('PENDING')
    })

    it('CRÉDITO: venda do MESMO pedido e MESMO valor credita uma vez; repetir não credita de novo', async () => {
      const { intent } = await recarregar(1500)
      cielo.vendas.get(intent!.cieloPaymentId!)!.status = 2
      const r = await creditarTopupPix(intent!.id)
      expect(r).toMatchObject({ status: 'PAID', totalCreditedCents: 1500 })
      expect(await creditarTopupPix(intent!.id)).toBeNull()
      expect(await prisma.walletEntry.count({ where: { type: 'TOPUP_PIX', referenceId: intent!.id } })).toBe(1)
    })

    it('CRÉDITO: Amount da Cielo DIFERENTE do pedido => NÃO credita (alerta com os dois valores, sem dado do pagador); nenhuma linha de carteira; intent segue PENDING', async () => {
      const { intent } = await recarregar(2000)
      const venda = cielo.vendas.get(intent!.cieloPaymentId!)!
      venda.status = 2
      venda.amount = 200 // pagaram 2,00 de um pedido de 20,00
      const erro = vi.spyOn(logger, 'error')
      const r = await creditarTopupPix(intent!.id)
      const a = alertas(erro).find((x) => x.alert === 'payment_pix_credit_divergence')!
      erro.mockRestore()
      expect(r).toBeNull()
      expect(a).toMatchObject({ motivo: 'amount', esperadoCents: 2000, pagoCents: 200 })
      expect(await prisma.walletEntry.count({ where: { referenceId: intent!.id } })).toBe(0)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent!.id } })).status).toBe('PENDING')
    })

    it('CRÉDITO: a venda consultada é de OUTRO MerchantOrderId => NÃO credita (alerta motivo merchant_order_id)', async () => {
      const { intent } = await recarregar(1000)
      const venda = cielo.vendas.get(intent!.cieloPaymentId!)!
      venda.status = 2
      venda.merchantOrderId = `outro-pedido-${randomUUID()}`
      const erro = vi.spyOn(logger, 'error')
      const r = await creditarTopupPix(intent!.id)
      const a = alertas(erro).find((x) => x.alert === 'payment_pix_credit_divergence')!
      erro.mockRestore()
      expect(r).toBeNull()
      expect(a.motivo).toBe('merchant_order_id')
      expect(await prisma.walletEntry.count({ where: { referenceId: intent!.id } })).toBe(0)
    })

    it('ReturnCode do Pix fora de {0,00,4,6}: NÃO bloqueia o crédito (Status 2 + identidade + valor decidem) e emite `payment_pix_returncode_unexpected`', async () => {
      const { intent } = await recarregar(1000)
      const venda = cielo.vendas.get(intent!.cieloPaymentId!)!
      venda.status = 2
      venda.returnCode = '77'
      const aviso = vi.spyOn(logger, 'warn')
      const r = await creditarTopupPix(intent!.id)
      const a = alertas(aviso).find((x) => x.alert === 'payment_pix_returncode_unexpected')
      aviso.mockRestore()
      expect(r).toMatchObject({ status: 'PAID' })
      expect(a).toMatchObject({ returnCode: '77' })
    })

    it('CRÉDITO: Cielo que NÃO manda MerchantOrderId nem Amount na consulta (resposta mínima) ainda credita pelo valor do pedido — a conferência só barra divergência EXPLÍCITA', async () => {
      const { intent } = await recarregar(1000)
      cielo.vendas.get(intent!.cieloPaymentId!)!.status = 2
      cielo.agendar('GET_BY_ID', { corpoRespostaCru: { Payment: { PaymentId: intent!.cieloPaymentId, Status: 2, ReturnCode: '0' } } })
      expect(await creditarTopupPix(intent!.id)).toMatchObject({ status: 'PAID', totalCreditedCents: 1000 })
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('S-1 / S-5 — cardToken só GUID, nunca um PAN; AccessToken do SOP com no-store', () => {
    async function cadastrar(cardToken: string) {
      contador += 1
      const driver = await createUser({ role: 'DRIVER', label: `card-r2-${contador}`, suffix })
      const res = await request(app).post('/api/me/payment-methods').set('Authorization', `Bearer ${driver.token}`).send({ cardToken, brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2031 })
      return { res, driver }
    }

    it('GUID (minúsculo e maiúsculo) é aceito com a Cielo real (201); a consulta GET /1/card é só enriquecimento e o 404 dela não bloqueia', async () => {
      expect((await cadastrar('0a1b2c3d-1111-4aaa-8bbb-200000000001')).res.status).toBe(201)
      expect((await cadastrar('0A1B2C3D-2222-4AAA-8BBB-2000000000AA')).res.status).toBe(201)
    })

    it.each([
      ['PAN puro de 16 dígitos', '4111111111111111'],
      ['PAN com espaços', '4111 1111 1111 1111'],
      ['PAN com hífens', '4111-1111-1111-1111'],
      ['PAN de 13 dígitos', '4111111111111'],
      ['PAN de 19 dígitos', '6011000990139424123'],
      ['PAN dentro de um texto', 'token-4111111111111111-x'],
      ['PAN colado num GUID', '4111111111111111-0a1b2c3d-1111-4aaa-8bbb-200000000001'],
      ['texto livre', 'qualquer-coisa-que-o-motorista-digitou'],
      ['CVV + validade', '123 12/2030'],
      ['GUID com 1 caractere a mais', '0a1b2c3d-1111-4aaa-8bbb-2000000000011'],
      ['GUID sem hífens', '0a1b2c3d1111-4aaa8bbb200000000001'],
    ])('%s é recusado com 400 VALIDATION_ERROR e NUNCA chega à Cielo', async (_nome, token) => {
      cielo.zerarRegistro()
      const { res } = await cadastrar(token)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('VALIDATION_ERROR')
      expect(res.text).not.toContain(token)
      expect(cielo.chamadas).toHaveLength(0)
    })

    it('o token do SOP SIMULADO (`mocktok.*`) é recusado com 400 INVALID_CARD_TOKEN quando o adaptador é a Cielo real, e nada vai à Cielo', async () => {
      cielo.zerarRegistro()
      const { res } = await cadastrar('mocktok.4242.122030.JOAO.1234567890')
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('INVALID_CARD_TOKEN')
      expect(cielo.chamadas).toHaveLength(0)
    })

    /**
     * ACHADO NOVO (Íris, rodada 2): o filtro "parece PAN" (`(?:[0-9][ -]?){13,19}`) roda SOBRE o GUID e tem FALSO POSITIVO: um GUID legítimo com 13+ dígitos decimais seguidos (os hífens
     * não quebram a sequência) é recusado como "PAN". Medido: 2,19 % de 200 000 `randomUUID()` v4 (e mais para tokens não-v4). O motorista vê "Dados inválidos" ao cadastrar um cartão
     * válido, sem causa que ele consiga entender (repetir a tokenização gera outro token e normalmente passa — então parece "intermitente"). Correção: como o GUID já é um formato
     * fechado, o filtro de PAN só precisa valer para o que NÃO é GUID (ou comparar só dígitos contíguos sem separador).
     */
    it.fails('(achado S-1) GUID VÁLIDO com 13+ dígitos decimais seguidos NÃO pode ser recusado como "PAN" (ex.: 2e121917-4239-4922-8ab6-ab3ce68bc645)', async () => {
      for (const t of ['2e121917-4239-4922-8ab6-ab3ce68bc645', '93b58220-7108-4802-8822-105d9d901d20', '03658120-2899-40bd-8ec9-0d5c15df345c']) {
        expect(cardTokenTemFormatoValido(t), `formato ${t}`).toBe(true)
        expect(pareceConterPan(t), `parece PAN ${t}`).toBe(false)
        expect(meCreatePaymentMethodSchema.safeParse({ cardToken: t, brand: 'Visa' }).success, `schema ${t}`).toBe(true)
      }
    })

    it.fails('(achado S-1) taxa de falso positivo em 5000 GUIDs v4 aleatórios deve ser ZERO (hoje ~2%)', () => {
      let rejeitados = 0
      for (let i = 0; i < 5000; i++) {
        if (!meCreatePaymentMethodSchema.safeParse({ cardToken: randomUUID(), brand: 'Visa' }).success) rejeitados++
      }
      expect(rejeitados).toBe(0)
    })

    it('S-5 — `POST /api/me/payment-methods/tokenization-session` responde `Cache-Control: no-store` (o AccessToken vai ao navegador)', async () => {
      contador += 1
      const driver = await createUser({ role: 'DRIVER', label: `tok-r2-${contador}`, suffix })
      // sem par SOP configurado a rota dá 503 (Cache-Control só no 200): configura o par no env deste processo
      const e = env as Record<string, unknown>
      e.CIELO_SOP_CLIENT_ID = 'sop-id'
      e.CIELO_SOP_CLIENT_SECRET = 'sop-secret'
      resetGatewayConfigCacheParaTeste()
      resetPagamentoPortCacheParaTeste()
      const { BraspagFalsa } = await import('./helpers/cieloFalsaHttp')
      const braspag = new BraspagFalsa()
      await braspag.iniciar()
      e.CIELO_SOP_OAUTH_TOKEN_URL = `${braspag.url}/oauth2/token`
      e.CIELO_SOP_ACCESS_TOKEN_URL = `${braspag.url}/post/api/public/v2/accesstoken`
      resetGatewayConfigCacheParaTeste()
      resetPagamentoPortCacheParaTeste()
      try {
        const res = await request(app).post('/api/me/payment-methods/tokenization-session').set('Authorization', `Bearer ${driver.token}`)
        expect(res.status, JSON.stringify(res.body)).toBe(200)
        expect(res.headers['cache-control']).toBe('no-store')
        expect(res.body.accessToken).toBe('ACCESS-TOKEN-FALSO-PASSO-2')
      } finally {
        await braspag.parar()
        e.CIELO_SOP_CLIENT_ID = baseline.CIELO_SOP_CLIENT_ID
        e.CIELO_SOP_CLIENT_SECRET = baseline.CIELO_SOP_CLIENT_SECRET
        e.CIELO_SOP_OAUTH_TOKEN_URL = baseline.CIELO_SOP_OAUTH_TOKEN_URL
        e.CIELO_SOP_ACCESS_TOKEN_URL = baseline.CIELO_SOP_ACCESS_TOKEN_URL
        resetGatewayConfigCacheParaTeste()
        resetPagamentoPortCacheParaTeste()
      }
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('I-5 — body-parser: JSON malformado, corpo grande, codificação', () => {
    it('JSON MALFORMADO em rota normal: 400 INVALID_JSON (não 500), sem eco do corpo', async () => {
      const r = await request(app).post('/api/auth/login').set('content-type', 'application/json').send('{"email":"a@b.com","password":"SEGREDO-NO-CORPO')
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('INVALID_JSON')
      expect(r.text).not.toContain('SEGREDO-NO-CORPO')
    })

    it('corpo GRANDE (200 KB) em rota normal: 413 PAYLOAD_TOO_LARGE', async () => {
      const r = await request(app).post('/api/auth/login').set('content-type', 'application/json').send(JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(200_000) }))
      expect(r.status).toBe(413)
      expect(r.body.code).toBe('PAYLOAD_TOO_LARGE')
    })

    it('charset e Content-Encoding não suportados: 415 UNSUPPORTED_BODY', async () => {
      const a = await request(app).post('/api/auth/login').set('content-type', 'application/json; charset=latin1').send('{"a":1}')
      expect(a.status).toBe(415)
      expect(a.body.code).toBe('UNSUPPORTED_BODY')
      const b = await request(app).post('/api/auth/login').set('content-type', 'application/json').set('content-encoding', 'br').send(Buffer.from('xxxx'))
      expect(b.status).toBe(415)
      expect(b.body.code).toBe('UNSUPPORTED_BODY')
    })

    describe('webhook da Cielo (parser próprio de 4 KB, tolerante)', () => {
      const url = (token: string) => `/api/webhooks/cielo/${token}`
      let token: string
      let segredo: string
      beforeAll(async () => {
        const m = await import('../../src/services/pagamentos/webhookCieloSecrets')
        token = m.getCieloWebhookPathToken()
        segredo = await m.getCieloWebhookHeaderSecret()
      })
      const antesDosEventos = () => prisma.webhookEvent.count({ where: { provider: 'CIELO' } })

      it('JSON inválido com o token certo: 200 como ping (DEPOIS do token), nada gravado; com token errado: 404', async () => {
        const antes = await antesDosEventos()
        for (const bruto of ['{', '{"PaymentId":', '[1,2', 'não é json', '{"PaymentId":"x","ChangeType":1']) {
          const r = await request(app).post(url(token)).set('content-type', 'application/json').send(bruto)
          expect(r.status, bruto).toBe(200)
          expect(r.body).toEqual({ received: true })
          expect((await request(app).post(url('token-errado')).set('content-type', 'application/json').send(bruto)).status, bruto).toBe(404)
        }
        expect(await antesDosEventos()).toBe(antes)
      })

      it('corpo acima de 4 KB: 413 (com e sem segredo, token certo ou errado — o parser roda antes da rota); abaixo de 4 KB com campos extras: aceito e gravado', async () => {
        const grande = JSON.stringify({ PaymentId: 'p', ChangeType: 1, lixo: 'x'.repeat(5000) })
        expect((await request(app).post(url(token)).set('content-type', 'application/json').set('InnoFlowWebhookSecret', segredo).send(grande)).status).toBe(413)
        expect((await request(app).post(url('token-errado')).set('content-type', 'application/json').send(grande)).status).toBe(413)
        const id = `iris-r2-${suffix}-${Math.random().toString(36).slice(2, 7)}`
        const medio = JSON.stringify({ PaymentId: id, ChangeType: 1, RecurrentPaymentId: null, lixo: 'x'.repeat(3000) })
        const ok = await request(app).post(url(token)).set('content-type', 'application/json').set('InnoFlowWebhookSecret', segredo).send(medio)
        expect(ok.status).toBe(200)
        expect(await prisma.webhookEvent.count({ where: { externalId: id } })).toBe(1)
      })

      it('a notificação real continua passando pelo parser novo e as demais rotas seguem com o parser global de 100 KB (60 KB em /api/auth/login é 400/401, não 413)', async () => {
        const r = await request(app).post('/api/auth/login').set('content-type', 'application/json').send(JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(60_000) }))
        expect([400, 401]).toContain(r.status)
      })
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  describe('tarifa desativada (Tariff.active) — independente do teste da Vega', () => {
    async function ativarCpEDesativar(ativa: boolean) {
      await prisma.tariff.update({ where: { id: cen.tenant.tariffId }, data: { active: ativa } })
    }

    it('pelo ADMIN (DELETE /api/admin/tariffs/:id = soft delete): o início de recarga NÃO chama a Cielo, a tela pública mostra tariff null, e reativar volta a valer', async () => {
      await prisma.chargePoint.update({ where: { id: cen.tenant.chargePointId }, data: { active: true } })
      const m = await cen.novoMotorista('tarifa-off')
      const c = await cen.novoConector()
      const antes = await request(app).get(`/api/public/charge-points/${encodeURIComponent(cen.tenant.ocppIdentity)}`)
      expect(antes.body.connectors.some((x: { tariff: unknown }) => x.tariff !== null)).toBe(true)

      const del = await request(app).delete(`/api/admin/tariffs/${cen.tenant.tariffId}`).set('Authorization', `Bearer ${cen.tenant.staff.token}`)
      expect(del.status).toBe(204)
      try {
        const res = await cen.iniciar(m, c)
        expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400)
        expect(cielo.contar('POST_SALE')).toBe(0) // sem tarifa não se pré-autoriza nada no cartão
        const pub = await request(app).get(`/api/public/charge-points/${encodeURIComponent(cen.tenant.ocppIdentity)}`)
        expect(pub.status).toBe(200)
        for (const cx of pub.body.connectors as Array<{ tariff: unknown }>) expect(cx.tariff).toBeNull()
      } finally {
        await ativarCpEDesativar(true)
      }
      const res2 = await cen.iniciar(m, c)
      expect(res2.status).toBe(202)
    })

    it('SESSÃO ABERTA segue pelo tariffSnapshot: tarifa desativada ANTES do Stop, cobra 300 (3 kWh x 1,00) e a captura real fecha CAPTURED 300 sem dívida', async () => {
      const { intentId } = await cen.sessaoParada('snapshot-r2', () => ativarCpEDesativar(false))
      try {
        const r = await capturarSessaoCartao(intentId)
        expect(r).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 300 })
        expect(await prisma.debt.count({ where: { paymentIntentId: intentId } })).toBe(0)
      } finally {
        await ativarCpEDesativar(true)
      }
    })

    it('MEDIÇÃO — RemoteStart aceito, tarifa desativada ANTES do StartTransaction: o handler falha com "Nenhuma tarifa ativa" (o carregador recebe erro, a sessão NÃO abre) e a pré-autorização é cancelada pelo varredor depois do abandono — nunca fica retida', async () => {
      const m = await cen.novoMotorista('start-sem-tarifa')
      const c = await cen.novoConector()
      expect((await cen.iniciar(m, c)).status).toBe(202)
      const authToken = await prisma.authToken.findFirstOrThrow({ where: { userId: m.user.id, type: 'VIRTUAL' }, orderBy: { createdAt: 'desc' } })
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { authTokenId: authToken.id } })
      await ativarCpEDesativar(false)
      try {
        await expect(callHandler(handleStartTransaction, cen.ctx, { connectorId: c, idTag: authToken.idTag, meterStart: 10, timestamp: new Date().toISOString() })).rejects.toThrow(/Nenhuma tarifa ativa/)
        expect(await prisma.chargingSession.count({ where: { userId: m.user.id } })).toBe(0)
        await cen.envelhecer(intent.id, 30)
        await varrerPreAutorizacoesCartao()
        expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('VOIDED')
        expect(cielo.vendaPorPedido(intent.id)!.status).toBe(10)
      } finally {
        await ativarCpEDesativar(true)
      }
    })

    it('com a tarifa de MAIOR prioridade desativada, vale a próxima tarifa ATIVA (2,00 do operador desativada -> volta a 1,00); reativada, a de maior prioridade volta', async () => {
      const cara = await prisma.tariff.create({ data: { operatorId: cen.tenant.operatorId, name: `cara-r2-${suffix}`, model: 'PER_KWH', pricePerKwh: '2.00' } })
      const vinc = await prisma.tariffAssignment.create({ data: { operatorId: cen.tenant.operatorId, tariffId: cara.id, scope: 'OPERATOR', priority: 50 } })
      const chargePoint = await prisma.chargePoint.findUniqueOrThrow({ where: { id: cen.tenant.chargePointId } })
      try {
        expect((await resolveActiveTariff({ id: cen.tenant.connectorId }, chargePoint)).id).toBe(cara.id)
        await prisma.tariff.update({ where: { id: cara.id }, data: { active: false } })
        expect((await resolveActiveTariff({ id: cen.tenant.connectorId }, chargePoint)).id).toBe(cen.tenant.tariffId)
        await prisma.tariff.update({ where: { id: cara.id }, data: { active: true } })
        expect((await resolveActiveTariff({ id: cen.tenant.connectorId }, chargePoint)).id).toBe(cara.id)
      } finally {
        await prisma.tariffAssignment.delete({ where: { id: vinc.id } })
      }
    })
  })
})
