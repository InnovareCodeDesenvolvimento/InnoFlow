import { describe, expect, it } from 'vitest'
import { CieloHttpClient } from '../../src/services/pagamentos/cieloHttpClient'
import { CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'
import { URLS_CIELO, resolverUrlsCielo } from '../../src/core/pagamentos/configGateway'

/**
 * F20 (C2.2 do plano / item 5) — a Cielo NÃO tem chave de idempotência: um `POST /1/sales` ou `PUT /capture` que deu timeout PODE ter sido processado.
 * Um retry cego cobraria duas vezes. Prova no menor nível: o adaptador NUNCA repete a escrita — depois de um timeout ele CONSULTA (por MerchantOrderId /
 * PaymentId) e só propaga se a Cielo não tem registro. Cada teste conta as chamadas de rede.
 *
 * F2 — hosts: escrita (`POST /1/sales`, `PUT capture/void`) no host TRANSACIONAL; consulta de venda (`GET /1/sales...`, janela de 3 meses) no host
 * `apiquery*`, por ambiente — valores do Parque (`cielo-gateway-config.ts`).
 */

interface Chamada {
  method: string
  url: string
}

function timeoutNaEscrita(consultaResponde: (url: string) => Response): { adapter: CieloAdapter; chamadas: Chamada[] } {
  const chamadas: Chamada[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    chamadas.push({ method, url: String(url) })
    if (method !== 'GET') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    return consultaResponde(String(url))
  }) as typeof fetch
  const client = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://api.example.test', apiQueryBaseUrl: 'https://apiquery.example.test', timeoutMs: 30, fetchImpl })
  return { adapter: new CieloAdapter(client, { merchantId: 'm', sandbox: true }), chamadas }
}

const json = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200 })
const pedido = { merchantOrderId: 'intent-1', amountRequestedCents: 5000, cartao: { cardToken: 't' }, cliente: { name: 'N' } }

describe('F20 — timeout em escrita NUNCA leva a repetir a escrita', () => {
  it('autorizar com timeout: exatamente 1 POST e 1 GET por MerchantOrderId; se a Cielo já autorizou, devolve o resultado real (e não cobra de novo)', async () => {
    const { adapter, chamadas } = timeoutNaEscrita(() => json({ MerchantOrderId: 'intent-1', Payments: [{ PaymentId: 'p1', Status: 1, ReturnCode: '4', Amount: 5000 }] }))
    const r = await adapter.autorizar(pedido)
    expect(r).toMatchObject({ providerPaymentId: 'p1', status: 'AUTHORIZED' })
    expect(chamadas.map((c) => c.method)).toEqual(['POST', 'GET'])
    expect(chamadas[1].url).toContain('merchantOrderId=IF-intent-1')
  })

  it('autorizar com timeout e a Cielo sem registro: propaga o timeout depois de UMA consulta — ainda 1 POST só (quem chama decide; o varredor reconsulta)', async () => {
    const { adapter, chamadas } = timeoutNaEscrita(() => json({ MerchantOrderId: 'intent-1', Payments: [] }))
    await expect(adapter.autorizar(pedido)).rejects.toThrow(/timeout/)
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(chamadas.filter((c) => c.method === 'GET')).toHaveLength(2) // `IF-<id>` e depois o id cru (intents anteriores ao prefixo)
  })

  it('capturar com timeout: 1 PUT e 1 GET por PaymentId; já capturada lá -> devolve CAPTURED sem nova captura; ainda AUTHORIZED lá -> propaga com 1 PUT só', async () => {
    const capturada = timeoutNaEscrita(() => json({ Payment: { PaymentId: 'p1', Status: 2, ReturnCode: '6', Amount: 5000, CapturedAmount: 3000 } }))
    expect(await capturada.adapter.capturar('p1', 3000)).toMatchObject({ status: 'CAPTURED', amountCapturedCents: 3000 })
    expect(capturada.chamadas.map((c) => c.method)).toEqual(['PUT', 'GET'])

    const autorizada = timeoutNaEscrita(() => json({ Payment: { PaymentId: 'p1', Status: 1, ReturnCode: '4', Amount: 5000 } }))
    await expect(autorizada.adapter.capturar('p1', 3000)).rejects.toThrow(/timeout/)
    expect(autorizada.chamadas.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('MerchantOrderId com prefixo IF- (conta compartilhada com o Parque): o POST leva `IF-<id>`; a reconciliação consulta `IF-<id>` e, sem achar, o id CRU (intents anteriores ao prefixo) — 2 GETs, nunca um 2º POST', async () => {
    const urls: string[] = []
    const { adapter, chamadas } = timeoutNaEscrita((url) => {
      urls.push(url)
      return json({ Payments: [] })
    })
    await expect(adapter.autorizar(pedido)).rejects.toThrow(/timeout/)
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('merchantOrderId=IF-intent-1')
    expect(urls[1]).toContain('merchantOrderId=intent-1')
    expect(urls[1]).not.toContain('IF-')
  })

  it('cancelar (void) não tem retry interno: 1 PUT, ponto — a política de repetir é do chamador, que CONSULTA antes (ver cancelarPreAutorizacaoCartao)', async () => {
    const { adapter, chamadas } = timeoutNaEscrita(() => json({}))
    await expect(adapter.cancelar('p1')).rejects.toThrow(/timeout/)
    expect(chamadas.map((c) => c.method)).toEqual(['PUT'])
  })
})

describe('F2 — hosts por ambiente (oráculo: Parque)', () => {
  it('valores exatos', () => {
    expect(URLS_CIELO.sandbox).toEqual({ api: 'https://apisandbox.cieloecommerce.cielo.com.br', query: 'https://apiquerysandbox.cieloecommerce.cielo.com.br' })
    expect(URLS_CIELO.production).toEqual({ api: 'https://api.cieloecommerce.cielo.com.br', query: 'https://apiquery.cieloecommerce.cielo.com.br' })
  })

  it.each(['sandbox', 'production'] as const)('%s: POST/PUT vão ao host transacional e GET de venda ao host de CONSULTA (nunca o contrário)', async (ambiente) => {
    const urls = resolverUrlsCielo(ambiente, {})
    const vistas: Chamada[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      vistas.push({ method: init?.method ?? 'GET', url: String(url) })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const client = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: urls.api, apiQueryBaseUrl: urls.query, timeoutMs: 100, fetchImpl })

    await client.postSale({})
    await client.capture('p1', 100)
    await client.void('p1')
    await client.getByPaymentId('p1')
    await client.getByMerchantOrderId('o1')

    const [post, capture, voided, getId, getOrder] = vistas
    for (const escrita of [post, capture, voided]) expect(escrita.url.startsWith(urls.api)).toBe(true)
    for (const leitura of [getId, getOrder]) expect(leitura.url.startsWith(urls.query)).toBe(true)
    expect(urls.query).toContain('apiquery') // host de consulta (janela de 3 meses), diferente do transacional
    expect(urls.query).not.toBe(urls.api)
  })
})
