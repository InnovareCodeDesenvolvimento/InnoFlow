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
    sopScriptUrl: 'https://sop.example.test/script.js',
    sopOAuth: { tokenUrl: 'https://sop.example.test/oauth/token', clientId: 'sop-client-id', clientSecret: 'sop-client-secret', timeoutMs: 50 },
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

describe('CieloAdapter.sessaoTokenizacao (F5.3)', () => {
  it('lança erro claro se CIELO_SOP_SCRIPT_URL não foi configurada (nunca inventa uma URL)', async () => {
    const client = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://x', apiQueryBaseUrl: 'https://y', timeoutMs: 50 })
    const adapter = new CieloAdapter(client, { merchantId: 'merchant-id', sandbox: true })
    await expect(adapter.sessaoTokenizacao()).rejects.toThrow(/CIELO_SOP_SCRIPT_URL/)
  })

  it('lança erro claro se CIELO_SOP_CLIENT_ID/SECRET/OAUTH_TOKEN_URL não foram configurados (mesmo com scriptUrl presente)', async () => {
    const client = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://x', apiQueryBaseUrl: 'https://y', timeoutMs: 50 })
    const adapter = new CieloAdapter(client, { merchantId: 'merchant-id', sandbox: true, sopScriptUrl: 'https://sop.example.test/script.js' })
    await expect(adapter.sessaoTokenizacao()).rejects.toThrow(/CIELO_SOP_CLIENT_ID/)
  })

  it('com scriptUrl + OAuth configurados, devolve accessToken/merchantId/environment/scriptUrl/expiresAt', async () => {
    const client = new CieloHttpClient({ merchantId: 'merchant-id', merchantKey: 'k', apiBaseUrl: 'https://x', apiQueryBaseUrl: 'https://y', timeoutMs: 50 })
    let chamouComGrantTypeCorreto = false
    const oauthFetch = (async (_url: string, init?: RequestInit) => {
      chamouComGrantTypeCorreto = init?.body === 'grant_type=client_credentials' && typeof init?.headers === 'object' && !!(init.headers as Record<string, string>).Authorization?.startsWith('Basic ')
      return fakeResponse(200, { access_token: 'sop-access-token-123', expires_in: 600 })
    }) as typeof fetch
    const adapter = new CieloAdapter(client, {
      merchantId: 'merchant-id',
      sandbox: true,
      sopScriptUrl: 'https://sop.example.test/script.js',
      sopOAuth: { tokenUrl: 'https://sop.example.test/oauth/token', clientId: 'sop-client-id', clientSecret: 'sop-client-secret', timeoutMs: 50, fetchImpl: oauthFetch },
    })

    const sessao = await adapter.sessaoTokenizacao()
    expect(chamouComGrantTypeCorreto).toBe(true)
    expect(sessao.accessToken).toBe('sop-access-token-123')
    expect(sessao.merchantId).toBe('merchant-id')
    expect(sessao.environment).toBe('sandbox')
    expect(sessao.scriptUrl).toBe('https://sop.example.test/script.js')
    expect(sessao.expiresAt.getTime()).toBeGreaterThan(Date.now())
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

  it('GET /1/card/{token} 404 -> CartaoTokenInvalidoError (nunca vaza o token inteiro na mensagem)', async () => {
    const fetchImpl = (async () => fakeResponse(404, { message: 'not found' })) as typeof fetch
    const adapter = criarAdapterComFetch(fetchImpl)

    await expect(adapter.consultarCartaoTokenizado('card-token-invalido-completo')).rejects.toThrow(/inválido/)
    try {
      await adapter.consultarCartaoTokenizado('card-token-invalido-completo')
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).not.toContain('card-token-invalido-completo')
      expect((err as Error).message).toContain('leto') // últimos 4 caracteres, mascarado
    }
  })
})
