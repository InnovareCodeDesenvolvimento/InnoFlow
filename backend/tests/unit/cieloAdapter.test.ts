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
  return new CieloAdapter(client, { merchantId: 'merchant-id', sandbox: true, sopPostUrl: 'https://sop.example.test/post' })
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

describe('CieloAdapter.sessaoTokenizacao', () => {
  it('lança erro claro se CIELO_SOP_POST_URL não foi configurada (nunca inventa uma URL)', () => {
    const client = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://x', apiQueryBaseUrl: 'https://y', timeoutMs: 50 })
    const adapter = new CieloAdapter(client, { merchantId: 'merchant-id', sandbox: true })
    expect(() => adapter.sessaoTokenizacao()).toThrow(/CIELO_SOP_POST_URL/)
  })

  it('com sopPostUrl configurada, devolve merchantId/postUrl/sandbox', () => {
    const adapter = criarAdapterComFetch((async () => fakeResponse(200, {})) as typeof fetch)
    const sessao = adapter.sessaoTokenizacao()
    expect(sessao).toEqual({ merchantId: 'merchant-id', postUrl: 'https://sop.example.test/post', sandbox: true })
  })
})
