import { describe, expect, it } from 'vitest'
import { montarPayloadPix } from '../../src/services/pagamentos/cieloPayloads'
import { expiracaoPixEfetivaSegundos, PIX_EXPIRES_MAX_SECONDS } from '../../src/core/pagamentos/expiracaoPix'
import { CieloHttpClient } from '../../src/services/pagamentos/cieloHttpClient'
import { CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'

/**
 * C1.5 (B3) — Pix `Cielo2`: `POST /1/sales` com `Payment.Type: "Pix"`, `Payment.Provider: "Cielo2"` e `Payment.QrCode.Expiration` (segundos, máx.
 * 86400), conforme a doc oficial "cielo2-gerar-qr-code-pix" e o `docs/PLANO-GATEWAY-CIELO.md` §4.2 do Parque. Pix NÃO tem sandbox na Cielo:
 * nenhuma resposta real foi vista, a prova de verdade é em produção com R$ 10. O `fetch` é sempre injetado.
 */

const PEDIDO = { merchantOrderId: 'topup-1', amountRequestedCents: 1000, cliente: { name: 'Motorista Teste', identity: '12345678909' } }

describe('montarPayloadPix', () => {
  it('formato EXATO da doc: Type Pix, Provider Cielo2, Payment.QrCode.Expiration (objeto aninhado) — e NADA de QrCodeExpiration', () => {
    const payload = montarPayloadPix({ ...PEDIDO, expiresInSeconds: 1800 })
    expect(payload).toEqual({
      MerchantOrderId: 'topup-1',
      Customer: { Name: 'Motorista Teste', Identity: '12345678909', IdentityType: 'CPF' },
      Payment: { Type: 'Pix', Amount: 1000, Provider: 'Cielo2', QrCode: { Expiration: 1800 } },
    })
    expect(JSON.stringify(payload)).not.toContain('QrCodeExpiration')
  })

  it('sem CPF não manda Identity/IdentityType', () => {
    const payload = montarPayloadPix({ ...PEDIDO, cliente: { name: 'Motorista Teste' }, expiresInSeconds: 600 })
    expect(payload.Customer).toEqual({ Name: 'Motorista Teste' })
  })
})

describe('expiração do QR: padrão e teto de 24 h', () => {
  it('sem pedido = 86400; dentro do limite passa; acima do máximo é cortado em 86400; abaixo de 1 vira 1; fração é truncada', () => {
    expect(PIX_EXPIRES_MAX_SECONDS).toBe(86_400)
    expect(expiracaoPixEfetivaSegundos(undefined)).toBe(86_400)
    expect(expiracaoPixEfetivaSegundos(1800)).toBe(1800)
    expect(expiracaoPixEfetivaSegundos(86_400)).toBe(86_400)
    expect(expiracaoPixEfetivaSegundos(86_401)).toBe(86_400)
    expect(expiracaoPixEfetivaSegundos(999_999)).toBe(86_400)
    expect(expiracaoPixEfetivaSegundos(0)).toBe(1)
    expect(expiracaoPixEfetivaSegundos(-5)).toBe(1)
    expect(expiracaoPixEfetivaSegundos(90.9)).toBe(90)
    expect(expiracaoPixEfetivaSegundos(Number.NaN)).toBe(86_400)
  })

  it('o payload usa a mesma conta (nunca manda mais que 86400 à Cielo)', () => {
    expect(montarPayloadPix({ ...PEDIDO, expiresInSeconds: 500_000 }).Payment.QrCode.Expiration).toBe(86_400)
    expect(montarPayloadPix(PEDIDO).Payment.QrCode.Expiration).toBe(86_400)
  })
})

describe('CieloAdapter.criarPix — endpoint e parsing', () => {
  function adapterComFetch(fetchImpl: typeof fetch): CieloAdapter {
    const client = new CieloHttpClient({ merchantId: 'mid', merchantKey: 'mkey', apiBaseUrl: 'https://api.example.test', apiQueryBaseUrl: 'https://apiquery.example.test', timeoutMs: 100, fetchImpl })
    return new CieloAdapter(client, { merchantId: 'mid', sandbox: false })
  }

  it('POST em /1/sales/ no host TRANSACIONAL (nunca /1/pix), com MerchantId/MerchantKey nos headers e o corpo da doc; lê QrCodeString, QrCodeBase64Image, PaymentId e Status 12', async () => {
    const vistas: Array<{ url: string; method?: string; headers: Record<string, string>; body: unknown }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      vistas.push({ url: String(url), method: init?.method, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) })
      return new Response(
        JSON.stringify({ MerchantOrderId: 'topup-1', Payment: { PaymentId: 'pay-uuid-1', Type: 'Pix', Provider: 'Cielo2', Status: 12, ReturnCode: '0', Amount: 1000, QrCodeString: '00020126...', QrCodeBase64Image: 'iVBORw0KGgo=', SentOrderId: 'txid1' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    const antes = Date.now()
    const r = await adapterComFetch(fetchImpl).criarPix({ ...PEDIDO, expiresInSeconds: 1800 })

    expect(vistas).toHaveLength(1)
    expect(vistas[0].url).toBe('https://api.example.test/1/sales/')
    expect(vistas[0].url).not.toContain('/1/pix')
    expect(vistas[0].method).toBe('POST')
    expect(vistas[0].headers).toMatchObject({ MerchantId: 'mid', MerchantKey: 'mkey' })
    expect(vistas[0].body).toMatchObject({ Payment: { Type: 'Pix', Provider: 'Cielo2', Amount: 1000, QrCode: { Expiration: 1800 } } })

    expect(r).toMatchObject({ providerPaymentId: 'pay-uuid-1', merchantOrderId: 'topup-1', status: 'PENDING', qrCodeString: '00020126...', qrCodeBase64Image: 'iVBORw0KGgo=' })
    expect(r.expiresAt.getTime()).toBeGreaterThanOrEqual(antes + 1800 * 1000 - 50)
    expect(r.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1800 * 1000 + 50)
  })

  it('o expiresAt que mostramos respeita o teto de 24 h mesmo se pedirem mais (é a expiração que a Cielo aplica)', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ Payment: { PaymentId: 'p', Status: 12, ReturnCode: '0', QrCodeString: 'x' } }), { status: 200 })) as typeof fetch
    const r = await adapterComFetch(fetchImpl).criarPix({ ...PEDIDO, expiresInSeconds: 500_000 })
    expect(r.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 86_400 * 1000 + 50)
  })

  it('o FakeAdapter aplica o mesmo teto', async () => {
    const r = await new FakeAdapter().criarPix({ ...PEDIDO, expiresInSeconds: 500_000 })
    expect(r.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 86_400 * 1000 + 50)
  })
})
