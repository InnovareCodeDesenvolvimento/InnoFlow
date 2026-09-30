import { describe, expect, it } from 'vitest'
import { CieloHttpClient, CieloHttpError, CieloTimeoutError } from '../../src/services/pagamentos/cieloHttpClient'

function baseConfig(fetchImpl: typeof fetch) {
  return {
    merchantId: 'merchant-id',
    merchantKey: 'merchant-key',
    apiBaseUrl: 'https://api.example.test',
    apiQueryBaseUrl: 'https://apiquery.example.test',
    timeoutMs: 50,
    fetchImpl,
  }
}

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('CieloHttpClient', () => {
  it('postSale envia MerchantId/MerchantKey nos headers e devolve o corpo parseado', async () => {
    let headersRecebidos: Headers | undefined
    let urlRecebida: string | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urlRecebida = String(url)
      headersRecebidos = new Headers(init?.headers)
      return fakeResponse(200, { Payment: { PaymentId: 'p1', Status: 1, ReturnCode: '00' } })
    }) as typeof fetch

    const client = new CieloHttpClient(baseConfig(fetchImpl))
    const body = (await client.postSale({ foo: 'bar' })) as { Payment: { PaymentId: string } }

    expect(urlRecebida).toBe('https://api.example.test/1/sales/')
    expect(headersRecebidos?.get('MerchantId')).toBe('merchant-id')
    expect(headersRecebidos?.get('MerchantKey')).toBe('merchant-key')
    expect(body.Payment.PaymentId).toBe('p1')
  })

  it('resposta HTTP não-OK -> CieloHttpError com o status', async () => {
    const fetchImpl = (async () => fakeResponse(400, { Message: 'invalid card token' })) as typeof fetch
    const client = new CieloHttpClient(baseConfig(fetchImpl))

    await expect(client.postSale({})).rejects.toThrow(CieloHttpError)
    try {
      await client.postSale({})
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CieloHttpError)
      expect((err as CieloHttpError).httpStatus).toBe(400)
    }
  })

  it('timeout (fetch nunca resolve) -> CieloTimeoutError, não trava o teste', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }) as typeof fetch

    const client = new CieloHttpClient(baseConfig(fetchImpl))
    await expect(client.getByPaymentId('p1')).rejects.toThrow(CieloTimeoutError)
  })

  it('capture usa PUT e inclui ?amount= quando informado', async () => {
    let urlRecebida: string | undefined
    let metodoRecebido: string | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urlRecebida = String(url)
      metodoRecebido = init?.method
      return fakeResponse(200, { PaymentId: 'p1', Status: 2, ReturnCode: '6' })
    }) as typeof fetch

    const client = new CieloHttpClient(baseConfig(fetchImpl))
    await client.capture('p1', 1234)

    expect(metodoRecebido).toBe('PUT')
    expect(urlRecebida).toBe('https://api.example.test/1/sales/p1/capture?amount=1234')
  })

  it('getByMerchantOrderId bate no host de CONSULTA (apiQueryBaseUrl), não no de cobrança', async () => {
    let urlRecebida: string | undefined
    const fetchImpl = (async (url: string) => {
      urlRecebida = String(url)
      return fakeResponse(200, { MerchantOrderId: 'order-1', Payments: [] })
    }) as typeof fetch

    const client = new CieloHttpClient(baseConfig(fetchImpl))
    await client.getByMerchantOrderId('order-1')

    expect(urlRecebida).toBe('https://apiquery.example.test/1/sales?merchantOrderId=order-1')
  })

  it('resposta 5xx com corpo não-JSON não derruba o parsing (vira { raw: texto })', async () => {
    const fetchImpl = (async () => new Response('Internal Server Error', { status: 502 })) as typeof fetch
    const client = new CieloHttpClient(baseConfig(fetchImpl))

    try {
      await client.postSale({})
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CieloHttpError)
      expect((err as CieloHttpError).body).toEqual({ raw: 'Internal Server Error' })
    }
  })
})
