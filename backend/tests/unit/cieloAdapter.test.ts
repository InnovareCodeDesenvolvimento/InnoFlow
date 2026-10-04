import { describe, expect, it } from 'vitest'
import { CieloHttpClient } from '../../src/services/pagamentos/cieloHttpClient'
import { CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'
import type { PedidoAutorizacaoCartao } from '../../src/core/pagamentos/tipos'

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function pedidoCartao(overrides: Partial<PedidoAutorizacaoCartao> = {}): PedidoAutorizacaoCartao {
  return {
    merchantOrderId: 'intent-1',
    amountRequestedCents: 5000,
    cartao: { cardToken: 'card-token-abc' },
    cliente: { name: 'Motorista Teste' },
    ...overrides,
  }
}

function criarAdapterComFetch(fetchImpl: typeof fetch): CieloAdapter {
  const client = new CieloHttpClient({
    merchantId: 'merchant-id',
    merchantKey: 'merchant-key',
    apiBaseUrl: 'https://api.example.test',
    apiQueryBaseUrl: 'https://apiquery.example.test',
    timeoutMs: 50,
    fetchImpl,
  })
  return new CieloAdapter(client, {
    merchantId: 'merchant-id',
    sandbox: true,
    sop: { clientId: 'sop-client-id', clientSecret: 'sop-client-secret', oauthTokenUrl: 'https://sop.example.test/oauth/token', accessTokenUrl: 'https://sop.example.test/accesstoken', scriptUrl: 'https://sop.example.test/script.js', timeoutMs: 50 },
  })
}

describe('CieloAdapter.autorizar', () => {
  it('resposta OK com ReturnCode capturável -> AUTHORIZED', async () => {
    const fetchImpl = (async () => fakeResponse(200, { MerchantOrderId: 'intent-1', Payment: { PaymentId: 'p1', Status: 1, ReturnCode: '00', Amount: 5000 } })) as typeof fetch
    const adapter = criarAdapterComFetch(fetchImpl)

    const resultado = await adapter.autorizar(pedidoCartao())
    expect(resultado).toEqual({ providerPaymentId: 'p1', status: 'AUTHORIZED', returnCode: '00', amountAuthorizedCents: 5000 })
  })

  it('resposta OK com Status Denied -> FAILED (mapeado do domínio DENIED)', async () => {
    const fetchImpl = (async () => fakeResponse(200, { MerchantOrderId: 'intent-1', Payment: { PaymentId: 'p1', Status: 3, ReturnCode: '05' } })) as typeof fetch
    const adapter = criarAdapterComFetch(fetchImpl)

    const resultado = await adapter.autorizar(pedidoCartao())
    expect(resultado.status).toBe('FAILED')
    expect(resultado.returnCode).toBe('05')
  })

  it('timeout no POST -> reconsulta por MerchantOrderId e devolve o resultado real (nunca duplica a chamada)', async () => {
    let chamadas = 0
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      chamadas += 1
      const path = String(url)
      if (path.endsWith('/1/sales/')) {
        // POST original: nunca resolve, só aborta pelo timeout do client.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }
      // Reconciliação: GET .../sales?merchantOrderId=... no host de consulta.
      expect(path).toContain('apiquery.example.test')
      expect(path).toContain('merchantOrderId=intent-1')
      return fakeResponse(200, { MerchantOrderId: 'intent-1', Payments: [{ PaymentId: 'p1', Status: 1, ReturnCode: '00', Amount: 5000 }] })
    }) as typeof fetch

    const adapter = criarAdapterComFetch(fetchImpl)
    const resultado = await adapter.autorizar(pedidoCartao())

    expect(resultado).toEqual({ providerPaymentId: 'p1', status: 'AUTHORIZED', returnCode: '00', amountAuthorizedCents: 5000 })
    expect(chamadas).toBe(2) // 1 POST original (abortado) + 1 GET de reconciliação — nunca um 2º POST
  })

  it('timeout no POST e Cielo NUNCA recebeu o pedido -> propaga o timeout (quem chama decide se tenta de novo)', async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = String(url)
      if (path.endsWith('/1/sales/')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }
      return fakeResponse(200, { MerchantOrderId: 'intent-1', Payments: [] })
    }) as typeof fetch

    const adapter = criarAdapterComFetch(fetchImpl)
    await expect(adapter.autorizar(pedidoCartao())).rejects.toThrow(/timeout/)
  })
})

describe('CieloAdapter.sessaoTokenizacao (F5.3 / C1.1)', () => {
  it('sem o par ClientId/ClientSecret do SOP lança erro claro (as URLs têm default por ambiente, então só a credencial pode faltar)', async () => {
    const client = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://x', apiQueryBaseUrl: 'https://y', timeoutMs: 50 })
    const adapter = new CieloAdapter(client, { merchantId: 'merchant-id', sandbox: true })
    await expect(adapter.sessaoTokenizacao()).rejects.toThrow(/ClientId.ClientSecret/)
  })

  it('devolve ao navegador o AccessToken do PASSO 2 (nunca o token OAuth do passo 1), com merchantId/environment/scriptUrl/expiresAt', async () => {
    const client = new CieloHttpClient({ merchantId: 'merchant-id', merchantKey: 'k', apiBaseUrl: 'https://x', apiQueryBaseUrl: 'https://y', timeoutMs: 50 })
    const urls: string[] = []
    const fetchSop = (async (url: string) => {
      urls.push(String(url))
      if (String(url).endsWith('/oauth/token')) return fakeResponse(200, { access_token: 'TOKEN-OAUTH-PASSO-1', expires_in: 599 })
      return fakeResponse(200, { AccessToken: 'ACCESS-TOKEN-DO-NAVEGADOR', ExpiresIn: 1200 })
    }) as typeof fetch
    const adapter = new CieloAdapter(client, {
      merchantId: 'merchant-id',
      sandbox: true,
      sop: { clientId: 'sop-client-id', clientSecret: 'sop-client-secret', oauthTokenUrl: 'https://sop.example.test/oauth/token', accessTokenUrl: 'https://sop.example.test/accesstoken', scriptUrl: 'https://sop.example.test/script.js', timeoutMs: 50, fetchImpl: fetchSop },
    })

    const sessao = await adapter.sessaoTokenizacao()
    expect(urls).toEqual(['https://sop.example.test/oauth/token', 'https://sop.example.test/accesstoken'])
    expect(sessao.accessToken).toBe('ACCESS-TOKEN-DO-NAVEGADOR')
    expect(sessao.accessToken).not.toBe('TOKEN-OAUTH-PASSO-1')
    expect(sessao.merchantId).toBe('merchant-id')
    expect(sessao.environment).toBe('sandbox')
    expect(sessao.scriptUrl).toBe('https://sop.example.test/script.js')
    // ExpiresIn 1200 - folga de 30 s
    expect(sessao.expiresAt.getTime()).toBeGreaterThan(Date.now() + 1100_000)
    expect(sessao.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1170_000)
  })
})

describe('CieloAdapter.consultarCartaoTokenizado (F5.3)', () => {
  it('GET /1/card/{token} OK -> brand/last4/holder/validade', async () => {
    const fetchImpl = (async (url: string) => {
      expect(String(url)).toContain('/1/card/card-token-abc')
      return fakeResponse(200, { CardNumber: '000000******1234', Holder: 'FULANO DE TAL', ExpirationDate: '12/2030', Brand: 'Visa' })
    }) as typeof fetch
    const adapter = criarAdapterComFetch(fetchImpl)

    const resultado = await adapter.consultarCartaoTokenizado('card-token-abc')
    expect(resultado).toEqual({ cardToken: 'card-token-abc', brand: 'Visa', last4: '1234', holderName: 'FULANO DE TAL', expiryMonth: 12, expiryYear: 2030 })
  })

  // C1.3 (R2/F25): `GET /1/card/{token}` NÃO está confirmado — o cadastro de cartão não pode depender dele. Qualquer falha vira "sem dados", nunca exceção.
  it.each([
    ['404 (endpoint inexistente OU token desconhecido — indistinguíveis)', () => fakeResponse(404, { message: 'not found' })],
    ['400', () => fakeResponse(400, [{ Code: 132, Message: 'MerchantKey is invalid' }])],
    ['500', () => fakeResponse(500, { raw: 'erro' })],
  ])('GET /1/card/{token} %s -> resolve SEM dados (enriquecimento opcional), não lança', async (_nome, resposta) => {
    const adapter = criarAdapterComFetch((async () => resposta()) as typeof fetch)
    await expect(adapter.consultarCartaoTokenizado('card-token-qualquer')).resolves.toEqual({ cardToken: 'card-token-qualquer', brand: null, last4: null, holderName: null, expiryMonth: null, expiryYear: null })
  })

  it('timeout e erro de rede na consulta também resolvem sem dados', async () => {
    const adapterTimeout = criarAdapterComFetch(((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })) as typeof fetch)
    await expect(adapterTimeout.consultarCartaoTokenizado('tok')).resolves.toMatchObject({ cardToken: 'tok', last4: null })
    const adapterRede = criarAdapterComFetch((async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch)
    await expect(adapterRede.consultarCartaoTokenizado('tok')).resolves.toMatchObject({ cardToken: 'tok', last4: null })
  })
})
