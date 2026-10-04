import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { criarCieloAdapterFromEnv, type CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'
import { montarPayloadAutorizacaoCartao } from '../../src/services/pagamentos/cieloPayloads'
import { higienizarSoftDescriptor } from '../../src/core/pagamentos/softDescriptor'
import { BraspagFalsa, CieloFalsaHttp } from '../integration/helpers/cieloFalsaHttp'

/**
 * Íris (C1/C2, 04/10/2026) — CONTRATOS de fio, medidos no BYTE que chega ao servidor (TCP local), contra os valores do Parque das Feiras
 * (`docs/GATEWAY-CIELO-PARQUE-VS-INNOFLOW.md` §2: F7, F8, F21, F30). O que se compara é o que o servidor RECEBEU, não o que o payload-builder devolve.
 */

describe('contratos de fio da Cielo/Braspag', () => {
  const cielo = new CieloFalsaHttp()
  const braspag = new BraspagFalsa()
  let adapter: CieloAdapter

  function criar(sopOverrides: { oauth?: string; access?: string } = {}) {
    return criarCieloAdapterFromEnv({
      CIELO_MERCHANT_ID: 'merchant-id-iris-0001',
      CIELO_MERCHANT_KEY: 'merchant-key-iris-0002',
      CIELO_API_BASE_URL: cielo.url,
      CIELO_API_QUERY_BASE_URL: cielo.url,
      CIELO_TIMEOUT_MS: 1500,
      CIELO_SANDBOX: true,
      CIELO_SOP_CLIENT_ID: 'client-id-iris',
      CIELO_SOP_CLIENT_SECRET: 'client-secret-iris',
      CIELO_SOP_OAUTH_TOKEN_URL: sopOverrides.oauth ?? `${braspag.url}/oauth2/token`,
      CIELO_SOP_ACCESS_TOKEN_URL: sopOverrides.access ?? `${braspag.url}/post/api/public/v2/accesstoken`,
      CIELO_SOP_SCRIPT_URL: 'https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js',
    })
  }

  beforeAll(async () => {
    await cielo.iniciar()
    await braspag.iniciar()
    adapter = criar()
  })
  afterAll(async () => {
    await cielo.parar()
    await braspag.parar()
  })
  beforeEach(() => {
    cielo.zerarRegistro()
    braspag.passos.length = 0
    braspag.modoOauth = 'ok'
    braspag.modoAccess = 'ok'
  })

  describe('cartão — POST /1/sales/ (pré-autorização)', () => {
    it('corpo e cabeçalhos EXATOS: pré-autorização (Capture false), 1 parcela, CardToken do cofre, SaveCard false, SEM SecurityCode, MerchantId/MerchantKey em cabeçalho (nunca no corpo/URL)', async () => {
      await adapter.autorizar({ merchantOrderId: 'ord-contrato-1', amountRequestedCents: 2500, cartao: { cardToken: 'card-token-iris-aaaa', brand: 'Visa' }, cliente: { name: 'Fulano', identity: '52998224725' }, softDescriptor: 'InnoFlow Carga' })
      expect(cielo.chamadas).toHaveLength(1)
      const c = cielo.chamadas[0]
      expect(c.metodo).toBe('POST')
      expect(c.url).toBe('/1/sales/')
      expect(c.headers['merchantid']).toBe('merchant-id-iris-0001')
      expect(c.headers['merchantkey']).toBe('merchant-key-iris-0002')
      expect(String(c.headers['content-type'])).toContain('application/json')
      expect(c.corpo).toEqual({
        MerchantOrderId: 'ord-contrato-1',
        Customer: { Name: 'Fulano', Identity: '52998224725', IdentityType: 'CPF' },
        Payment: { Type: 'CreditCard', Amount: 2500, Installments: 1, Capture: false, SoftDescriptor: 'INNOFLOWCARGA', CreditCard: { CardToken: 'card-token-iris-aaaa', SaveCard: false, Brand: 'Visa' } },
      })
      expect(c.corpoBruto).not.toContain('SecurityCode')
      expect(c.corpoBruto).not.toContain('merchant-key-iris-0002') // a chave nunca viaja no corpo
      expect(c.url).not.toContain('merchant')
    })

    it('captura e cancelamento: PUT no host/rota certos, `amount` só na captura, MerchantId/MerchantKey em cabeçalho', async () => {
      const v = cielo.plantarVenda({ merchantOrderId: 'ord-put' })
      await adapter.capturar(v.paymentId, 1234)
      await adapter.cancelar(cielo.plantarVenda({ merchantOrderId: 'ord-put2' }).paymentId)
      const [cap, vo] = cielo.chamadas
      expect(cap).toMatchObject({ metodo: 'PUT', rota: 'PUT_CAPTURE', url: `/1/sales/${v.paymentId}/capture?amount=1234` })
      expect(vo.rota).toBe('PUT_VOID')
      expect(vo.url).toMatch(/^\/1\/sales\/[^/?]+\/void$/) // cancelamento TOTAL: sem amount
      expect(cap.headers['merchantkey']).toBe('merchant-key-iris-0002')
    })

    it('SoftDescriptor: nunca sai da faixa A-Z0-9 (até 13) — 3000 entradas hostis (acento, emoji, hífen, espaço, CJK, controle, NFD)', () => {
      const alfabeto = ['a', 'Z', '0', '9', 'é', 'Ç', 'ñ', 'ß', 'ø', 'İ', 'ı', 'ǅ', 'ﬁ', '€', '-', ' ', '.', '*', '\u0000', '\n', '​', '😀', '日', '本', 'Ω', 'é', 'ａ', 'Ａ', '９', '٣', '_', '/']
      let semente = 7
      const rnd = () => ((semente = (semente * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
      const violacoes: string[] = []
      for (let i = 0; i < 3000; i++) {
        const n = 1 + Math.floor(rnd() * 30)
        const entrada = Array.from({ length: n }, () => alfabeto[Math.floor(rnd() * alfabeto.length)]).join('')
        const saida = higienizarSoftDescriptor(entrada)
        const payload = montarPayloadAutorizacaoCartao({ merchantOrderId: 'x', amountRequestedCents: 1, cartao: { cardToken: 't' }, cliente: { name: 'n' }, softDescriptor: entrada })
        const noPayload = payload.Payment.SoftDescriptor
        if (saida !== null && !/^[A-Z0-9]{1,13}$/.test(saida)) violacoes.push(`${JSON.stringify(entrada)} -> ${JSON.stringify(saida)}`)
        if (noPayload !== undefined && !/^[A-Z0-9]{1,13}$/.test(noPayload)) violacoes.push(`payload ${JSON.stringify(entrada)} -> ${JSON.stringify(noPayload)}`)
        if ((saida === null) !== (noPayload === undefined)) violacoes.push(`campo ausente/presente incoerente: ${JSON.stringify(entrada)}`)
      }
      expect(violacoes).toEqual([])
    })

    it('SoftDescriptor: exemplos conhecidos (acento some, vazio omite o campo, 13 caracteres no máximo)', () => {
      expect(higienizarSoftDescriptor('Elétron-Carga ⚡')).toBe('ELETRONCARGA')
      expect(higienizarSoftDescriptor('InnoFlow Recarga Rápida 24h')).toBe('INNOFLOWRECAR')
      expect(higienizarSoftDescriptor('---')).toBeNull()
      expect(higienizarSoftDescriptor('')).toBeNull()
      expect(higienizarSoftDescriptor(undefined)).toBeNull()
      expect(higienizarSoftDescriptor('日本語')).toBeNull()
      const sem = montarPayloadAutorizacaoCartao({ merchantOrderId: 'x', amountRequestedCents: 1, cartao: { cardToken: 't' }, cliente: { name: 'n' } })
      expect('SoftDescriptor' in sem.Payment).toBe(false)
    })
  })

  describe('Pix Cielo2 — POST /1/sales/ com Payment.QrCode.Expiration', () => {
    const pix = (expiresInSeconds?: number) => ({ merchantOrderId: `pix-${Math.random().toString(36).slice(2, 8)}`, amountRequestedCents: 1000, cliente: { name: 'Fulano', identity: '52998224725' }, expiresInSeconds })

    it('payload EXATO no fio (nada de /1/pix nem QrCodeExpiration) e o parsing de QrCodeString / QrCodeBase64Image / PaymentId / Status 12', async () => {
      const pedido = pix(1800)
      const r = await adapter.criarPix(pedido)
      const c = cielo.chamadas[0]
      expect(c.metodo).toBe('POST')
      expect(c.url).toBe('/1/sales/')
      expect(c.corpo).toEqual({
        MerchantOrderId: pedido.merchantOrderId,
        Customer: { Name: 'Fulano', Identity: '52998224725', IdentityType: 'CPF' },
        Payment: { Type: 'Pix', Amount: 1000, Provider: 'Cielo2', QrCode: { Expiration: 1800 } },
      })
      expect(c.corpoBruto).not.toContain('QrCodeExpiration')
      expect(r.status).toBe('PENDING')
      expect(r.qrCodeString).toBe('00020101021226830014br.gov.bcb.pix2561exemplo')
      expect(r.qrCodeBase64Image).toBe('iVBORw0KGgoAAAANSUhEUgAAAFAAAABQ')
      expect(r.providerPaymentId).toBe([...cielo.vendas.keys()][0])
    })

    it.each([
      [undefined, 86400],
      [1, 1],
      [0, 1],
      [-10, 1],
      [0.4, 1],
      [1.9, 1],
      [3600, 3600],
      [86399, 86399],
      [86400, 86400],
      [86401, 86400],
      [1e9, 86400],
      [Number.POSITIVE_INFINITY, 86400],
      [Number.NaN, 86400],
    ])('expiração pedida %s -> %s segundos no corpo (inteiro, 1..86400)', async (pedido, esperado) => {
      await adapter.criarPix(pix(pedido))
      const exp = (cielo.chamadas.at(-1)!.corpo as { Payment: { QrCode: { Expiration: number } } }).Payment.QrCode.Expiration
      expect(exp).toBe(esperado)
      expect(Number.isInteger(exp)).toBe(true)
      expect(exp).toBeGreaterThanOrEqual(1)
      expect(exp).toBeLessThanOrEqual(86400)
    })

    it('Pix grava Tid/AuthorizationCode/ProofOfSale como NULL na resposta de criação (a Cielo2 não os manda no Pix de criação) e não quebra com QR ausente', async () => {
      cielo.agendar('POST_SALE', { corpoRespostaCru: { MerchantOrderId: 'p', Payment: { PaymentId: 'pay-sem-qr', Status: 12, ReturnCode: '0', Type: 'Pix' } } })
      const r = await adapter.criarPix(pix(600))
      expect(r.qrCodeString).toBe('') // sem QR a camada de cima precisa tratar; aqui só garantimos que não explode e não inventa
      expect(r.qrCodeBase64Image).toBeNull()
      expect(r.status).toBe('PENDING')
    })

    it('Status 2 numa consulta Pix é PAID; Status 12 é PENDING; Status 13 não é PAID', async () => {
      const v = cielo.plantarVenda({ merchantOrderId: 'pix-consulta', tipo: 'Pix', status: 12, returnCode: '0' })
      expect((await adapter.consultarPix(v.paymentId)).status).toBe('PENDING')
      v.status = 2
      expect((await adapter.consultarPix(v.paymentId)).status).toBe('PAID')
      v.status = 13
      expect((await adapter.consultarPix(v.paymentId)).status).not.toBe('PAID')
    })
  })

  describe('Silent Order Post — DOIS passos (F7/F8), valores exatos do Parque', () => {
    it('passo 1: POST form-urlencoded, `Authorization: Basic base64(ClientId:ClientSecret)`, corpo `grant_type=client_credentials` e SEM scope; passo 2: Bearer do passo 1 + cabeçalho MerchantId + corpo {MerchantId}', async () => {
      const s = await adapter.sessaoTokenizacao()
      expect(braspag.passos.map((p) => p.passo)).toEqual(['oauth', 'accesstoken'])
      const [p1, p2] = braspag.passos
      expect(p1.metodo).toBe('POST')
      expect(p1.url).toBe('/oauth2/token')
      expect(p1.headers['authorization']).toBe(`Basic ${Buffer.from('client-id-iris:client-secret-iris').toString('base64')}`)
      expect(String(p1.headers['content-type'])).toContain('application/x-www-form-urlencoded')
      expect(p1.corpoBruto).toBe('grant_type=client_credentials')
      expect(p1.corpoBruto).not.toContain('scope')

      expect(p2.metodo).toBe('POST')
      expect(p2.url).toBe('/post/api/public/v2/accesstoken')
      expect(p2.headers['authorization']).toBe('Bearer OAUTH-TOKEN-FALSO-PASSO-1')
      expect(p2.headers['merchantid']).toBe('merchant-id-iris-0001')
      expect(String(p2.headers['content-type'])).toContain('application/json')
      expect(JSON.parse(p2.corpoBruto)).toEqual({ MerchantId: 'merchant-id-iris-0001' })

      // B1: o que vai ao navegador é o AccessToken do PASSO 2, nunca o token OAuth do passo 1.
      expect(s.accessToken).toBe('ACCESS-TOKEN-FALSO-PASSO-2')
      expect(JSON.stringify(s)).not.toContain('OAUTH-TOKEN-FALSO-PASSO-1')
      expect(s.merchantId).toBe('merchant-id-iris-0001')
      expect(s.environment).toBe('sandbox')
      expect(s.scriptUrl).toBe('https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js')
      // ExpiresIn 1200 s menos 30 s de folga
      const restante = (s.expiresAt.getTime() - Date.now()) / 1000
      expect(restante).toBeGreaterThan(1100)
      expect(restante).toBeLessThanOrEqual(1170)
    })

    it('credencial recusada no passo 1 (400 invalid_client) NÃO chama o passo 2; 401 no passo 2 é credencial inválida; nenhum segredo/token na mensagem do erro', async () => {
      braspag.modoOauth = 'invalid_client'
      const erro1 = (await adapter.sessaoTokenizacao().catch((e: unknown) => e)) as Error & { kind?: string; passo?: string }
      expect(erro1).toMatchObject({ kind: 'credencial_invalida', passo: 'oauth' })
      expect(braspag.passos.map((p) => p.passo)).toEqual(['oauth'])
      expect(erro1.message).not.toContain('client-secret-iris')

      braspag.passos.length = 0
      braspag.modoOauth = 'ok'
      braspag.modoAccess = 'sem401'
      const erro2 = (await adapter.sessaoTokenizacao().catch((e: unknown) => e)) as Error & { kind?: string; passo?: string }
      expect(erro2).toMatchObject({ kind: 'credencial_invalida', passo: 'accesstoken' })
      expect(erro2.message).not.toContain('OAUTH-TOKEN-FALSO-PASSO-1')
      expect(erro2.message).not.toContain('client-secret-iris')
    })

    it('URLs por ambiente (sem env de override) são EXATAMENTE as do Parque', async () => {
      const { URLS_SOP, URLS_CIELO } = await import('../../src/core/pagamentos/configGateway')
      expect(URLS_SOP.sandbox).toEqual({
        oauthToken: 'https://authsandbox.braspag.com.br/oauth2/token',
        accessToken: 'https://transactionsandbox.pagador.com.br/post/api/public/v2/accesstoken',
        script: 'https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js',
      })
      expect(URLS_SOP.production).toEqual({
        oauthToken: 'https://auth.braspag.com.br/oauth2/token',
        accessToken: 'https://transaction.pagador.com.br/post/api/public/v2/accesstoken',
        script: 'https://transaction.cieloecommerce.cielo.com.br/post/scripts/silentorderpost-1.0.min.js',
      })
      expect(URLS_CIELO).toEqual({
        sandbox: { api: 'https://apisandbox.cieloecommerce.cielo.com.br', query: 'https://apiquerysandbox.cieloecommerce.cielo.com.br' },
        production: { api: 'https://api.cieloecommerce.cielo.com.br', query: 'https://apiquery.cieloecommerce.cielo.com.br' },
      })
    })
  })
})
