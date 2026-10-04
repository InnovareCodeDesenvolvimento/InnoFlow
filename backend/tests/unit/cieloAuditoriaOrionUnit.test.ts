import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { CieloHttpClient } from '../../src/services/pagamentos/cieloHttpClient'
import { CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'
import { emitirAccessTokenSop } from '../../src/services/pagamentos/cieloSopOAuth'
import { lerListaDaConsultaPorPedido, lerDataCielo } from '../../src/services/pagamentos/cieloPayloads'
import { cardTokenTemFormatoValido, meCreatePaymentMethodSchema } from '../../src/api/schemas/mePaymentMethods.schema'
import { logger } from '../../src/lib/logger'

/**
 * Auditoria do Órion (docs/AUDITORIA-PAGAMENTOS-CIELO.md) — nível unitário: I-1 (consulta por pedido), I-2 (Status bruto), I-6 (ReturnCode do Pix), S-1, S-2, S-4, S-6.
 * `fetch` sempre injetado: nada vai à Cielo.
 */

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } })

type Roteador = (url: string, init?: RequestInit) => Response | Promise<Response>
function adapterCom(roteador: Roteador, over: { timeoutMs?: number; queryTimeoutMs?: number } = {}): { adapter: CieloAdapter; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(String(url))
    return roteador(String(url), init)
  }) as typeof fetch
  const client = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://api.example.test', apiQueryBaseUrl: 'https://q.example.test', timeoutMs: over.timeoutMs ?? 200, queryTimeoutMs: over.queryTimeoutMs, fetchImpl })
  return { adapter: new CieloAdapter(client, { merchantId: 'm', sandbox: true }), urls }
}

const venda = (paymentId: string, merchantOrderId: string, status: number, returnCode: string | null, recebida = '2026-10-04 10:00:00') => ({
  MerchantOrderId: merchantOrderId,
  Payment: { PaymentId: paymentId, Status: status, ReturnCode: returnCode, Amount: 1000, ReceivedDate: recebida },
})

describe('I-1 — consultarPorPedido: lista de PaymentId + GET por PaymentId', () => {
  it('lerListaDaConsultaPorPedido: aceita "ReceveidDate" (sic) e "ReceivedDate"; entrada só com PaymentId não tem inline; entrada com Status (formato antigo) tem', () => {
    const lista = lerListaDaConsultaPorPedido({ Payments: [{ PaymentId: 'a', ReceveidDate: '2026-10-04 10:00:00' }, { PaymentId: 'b', ReceivedDate: '2026-10-04 11:00:00', Status: 1, ReturnCode: '4', Amount: 100 }, { Foo: 1 }, null] })
    expect(lista.entradas).toHaveLength(2)
    expect(lista.entradas[0]).toMatchObject({ paymentId: 'a', inline: null })
    expect(lista.entradas[0].receivedDateMs).toBe(lerDataCielo('2026-10-04 10:00:00'))
    expect(lista.entradas[1].inline).toMatchObject({ status: 1, returnCode: '4' })
    expect(lista.entradas[1].receivedDateMs).toBeGreaterThan(lista.entradas[0].receivedDateMs!)
  })

  it('lista só com ids: faz o GET de cada venda e devolve o estado do detalhe', async () => {
    const { adapter, urls } = adapterCom((url) => {
      if (url.includes('merchantOrderId=')) return json({ Payments: [{ PaymentId: 'p1', ReceveidDate: '2026-10-04 10:00:00' }] })
      return json(venda('p1', 'pedido-1', 1, '4'))
    })
    const r = await adapter.consultarPorPedido('pedido-1')
    expect(r).toMatchObject({ providerPaymentId: 'p1', merchantOrderId: 'pedido-1', status: 'AUTHORIZED', returnCode: '4', statusBruto: 1 })
    expect(urls.filter((u) => u.includes('/1/sales/p1'))).toHaveLength(1)
  })

  it('venda cujo MerchantOrderId devolvido NÃO é o do pedido é ignorada (nunca vira a resposta desta reconciliação)', async () => {
    const { adapter } = adapterCom((url) => (url.includes('merchantOrderId=') ? json({ Payments: [{ PaymentId: 'p1', ReceveidDate: '2026-10-04 10:00:00' }] }) : json(venda('p1', 'OUTRO-PEDIDO', 1, '4'))))
    expect(await adapter.consultarPorPedido('pedido-1')).toBeNull()
  })

  it('várias vendas do mesmo pedido: escolhe pela ReceivedDate MAIS RECENTE (não pelo fim do array) e emite o alerta de múltiplas vendas', async () => {
    const aviso = vi.spyOn(logger, 'warn')
    const { adapter } = adapterCom((url) => {
      if (url.includes('merchantOrderId=')) {
        // a mais recente (p-nova) está NO COMEÇO do array
        return json({ Payments: [{ PaymentId: 'p-nova', ReceveidDate: '2026-10-04 12:00:00' }, { PaymentId: 'p-velha', ReceveidDate: '2026-10-04 09:00:00' }] })
      }
      return url.includes('p-nova') ? json(venda('p-nova', 'pedido-1', 1, '4', '2026-10-04 12:00:00')) : json(venda('p-velha', 'pedido-1', 10, '0', '2026-10-04 09:00:00'))
    })
    const r = await adapter.consultarPorPedido('pedido-1')
    expect(r?.providerPaymentId).toBe('p-nova')
    expect(aviso.mock.calls.map((c) => (c[0] as { alert?: string }).alert)).toContain('payment_reconciliation_multiple_payments')
    aviso.mockRestore()
  })

  it('sem data, empate: prefere a venda VIVA (autorizada/capturada) à cancelada, mesmo que a cancelada venha por último', async () => {
    const { adapter } = adapterCom((url) => {
      if (url.includes('merchantOrderId=')) return json({ Payments: [{ PaymentId: 'p-viva' }, { PaymentId: 'p-cancelada' }] })
      return url.includes('p-viva') ? json({ MerchantOrderId: 'pedido-1', Payment: { PaymentId: 'p-viva', Status: 1, ReturnCode: '4' } }) : json({ MerchantOrderId: 'pedido-1', Payment: { PaymentId: 'p-cancelada', Status: 10, ReturnCode: '0' } })
    })
    expect((await adapter.consultarPorPedido('pedido-1'))?.providerPaymentId).toBe('p-viva')
  })

  it('lista vazia -> null; falha no GET de detalhe PROPAGA (sem o estado de todas não dá para escolher)', async () => {
    expect((await adapterCom(() => json({ Payments: [] })).adapter.consultarPorPedido('x'))).toBeNull()
    const { adapter } = adapterCom((url) => (url.includes('merchantOrderId=') ? json({ Payments: [{ PaymentId: 'p1' }] }) : json([{ Code: 0, Message: 'x' }], 500)))
    await expect(adapter.consultarPorPedido('pedido-1')).rejects.toMatchObject({ httpStatus: 500 })
  })

  it('teto de detalhes por reconciliação: no máximo 5 GETs por PaymentId mesmo com 12 vendas listadas', async () => {
    const { adapter, urls } = adapterCom((url) => {
      if (url.includes('merchantOrderId=')) return json({ Payments: Array.from({ length: 12 }, (_, i) => ({ PaymentId: `p${i}`, ReceveidDate: `2026-10-04 10:${String(i).padStart(2, '0')}:00` })) })
      const id = /sales\/(p\d+)/.exec(url)![1]
      return json(venda(id, 'pedido-1', 10, '0'))
    })
    await adapter.consultarPorPedido('pedido-1')
    expect(urls.filter((u) => /\/1\/sales\/p\d+/.test(u))).toHaveLength(5)
  })
})

describe('I-2 — Status bruto preservado e alertas do Status/ReturnCode não conclusivos', () => {
  afterEach(() => vi.restoreAllMocks())
  const pedido = { merchantOrderId: 'o1', amountRequestedCents: 1000, cartao: { cardToken: 't' }, cliente: { name: 'N' } }

  it('autorizar: DENIED (Status 3) e FAILED (Status 13) se fundem em status "FAILED" da porta, mas statusBruto os distingue; Status ausente -> statusBruto null', async () => {
    for (const [status, esperado] of [[3, 3], [13, 13], [1, 1]] as const) {
      const { adapter } = adapterCom(() => json({ Payment: { PaymentId: 'p', Status: status, ReturnCode: status === 1 ? '51' : '05' } }))
      const r = await adapter.autorizar(pedido)
      expect(r.status).toBe('FAILED')
      expect(r.statusBruto).toBe(esperado)
    }
    const semStatus = await adapterCom(() => json({ Payment: { PaymentId: 'p' } })).adapter.autorizar(pedido)
    expect(semStatus).toMatchObject({ status: 'CREATED', statusBruto: null })
  })

  it('Status 1 com ReturnCode fora das tabelas: CREATED (não FAILED) + alerta de ERRO com o PaymentId, já na 1ª leitura', async () => {
    const erro = vi.spyOn(logger, 'error')
    const r = await adapterCom(() => json({ Payment: { PaymentId: 'pay-88', Status: 1, ReturnCode: '88', Amount: 1000 } })).adapter.autorizar(pedido)
    expect(r).toMatchObject({ status: 'CREATED', statusBruto: 1 })
    const a = erro.mock.calls.find((c) => (c[0] as { alert?: string }).alert === 'payment_authorized_status_unlisted_returncode')
    expect((a![0] as { paymentId?: string }).paymentId).toBe('pay-88')
  })

  it('consultar com Status 2 e ReturnCode fora de 00/4/6: ERRO na 1ª consulta com o PaymentId; resultado não definitivo', async () => {
    const erro = vi.spyOn(logger, 'error')
    const r = await adapterCom(() => json({ Payment: { PaymentId: 'pay-s2', Status: 2, ReturnCode: '51' } })).adapter.consultar('pay-s2')
    expect(r.status).toBe('CREATED')
    const a = erro.mock.calls.find((c) => (c[0] as { alert?: string }).alert === 'payment_captured_status_unlisted_returncode')
    expect((a![0] as { paymentId?: string }).paymentId).toBe('pay-s2')
  })

  it('NÃO amplia o conjunto aprovador: Status 1 com 0 ou 6 continua não aprovado', async () => {
    for (const rc of ['0', '6']) {
      const r = await adapterCom(() => json({ Payment: { PaymentId: 'p', Status: 1, ReturnCode: rc } })).adapter.autorizar(pedido)
      expect(r.status).not.toBe('AUTHORIZED')
    }
  })
})

describe('I-6 — ReturnCode do Pix fora de {0,00,4,6} só alerta (não bloqueia)', () => {
  afterEach(() => vi.restoreAllMocks())
  it('consultarPix com ReturnCode 77: devolve o estado normalmente e emite payment_pix_returncode_unexpected; com 0 não alerta', async () => {
    const aviso = vi.spyOn(logger, 'warn')
    const estranho = await adapterCom(() => json({ MerchantOrderId: 'o', Payment: { PaymentId: 'px', Status: 2, ReturnCode: '77', Amount: 1000 } })).adapter.consultarPix('px')
    expect(estranho.status).toBe('PAID')
    expect(aviso.mock.calls.map((c) => (c[0] as { alert?: string }).alert)).toContain('payment_pix_returncode_unexpected')
    aviso.mockClear()
    await adapterCom(() => json({ MerchantOrderId: 'o', Payment: { PaymentId: 'px', Status: 2, ReturnCode: '0', Amount: 1000 } })).adapter.consultarPix('px')
    expect(aviso.mock.calls.map((c) => (c[0] as { alert?: string }).alert)).not.toContain('payment_pix_returncode_unexpected')
  })
})

describe('S-1 — cardToken só no formato do cofre da Cielo (GUID) e nunca um PAN', () => {
  const GUID = '3f1f0a2e-5b6c-4d7e-8f90-a1b2c3d4e5f6'
  it('aceita GUID e o token do SOP simulado estruturado; recusa o resto', () => {
    expect(cardTokenTemFormatoValido(GUID)).toBe(true)
    expect(cardTokenTemFormatoValido(GUID.toUpperCase())).toBe(true)
    expect(cardTokenTemFormatoValido('mocktok.4242.122030.Rm9vIEJhcg==.17910000000001')).toBe(true)
    for (const ruim of ['tok-123', 'abc', GUID + 'x', 'mocktok.1.2.3', 'mocktok.4242.122030.titular', '', '4111111111111111', '4111 1111 1111 1111']) expect(cardTokenTemFormatoValido(ruim), ruim).toBe(false)
  })

  it('o schema recusa PAN em qualquer formato (13–19 dígitos, com espaço ou hífen) e texto livre; aceita o GUID', () => {
    const base = { brand: 'Visa' }
    for (const pan of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '378282246310005', '6011000990139424', `x${'1'.repeat(13)}y`, '4'.repeat(19)]) {
      expect(meCreatePaymentMethodSchema.safeParse({ ...base, cardToken: pan }).success, pan).toBe(false)
    }
    expect(meCreatePaymentMethodSchema.safeParse({ ...base, cardToken: 'qualquer-texto' }).success).toBe(false)
    expect(meCreatePaymentMethodSchema.safeParse({ ...base, cardToken: GUID }).success).toBe(true)
  })

  it('GUID LEGÍTIMO nunca é recusado como "PAN" (bug do S-1: o filtro de 13–19 dígitos recusava ~2,2 % dos randomUUID, ex.: 13+ dígitos decimais seguidos entre hífens)', () => {
    const base = { brand: 'Visa' }
    for (const exemplo of ['2e121917-4239-4922-8ab6-ab3ce68bc645', '12345678-1234-4123-8123-123456789012', '00000000-0000-4000-8000-000000000000']) {
      expect(meCreatePaymentMethodSchema.safeParse({ ...base, cardToken: exemplo }).success, exemplo).toBe(true)
    }
    let recusados = 0
    for (let i = 0; i < 20_000; i++) if (!meCreatePaymentMethodSchema.safeParse({ ...base, cardToken: randomUUID() }).success) recusados++
    expect(recusados).toBe(0)
  })
})

describe('S-2 — nunca seguir redirect', () => {
  it('o cliente HTTP da Cielo e os dois passos do SOP mandam redirect: "error"', async () => {
    const vistos: Array<string | undefined> = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      vistos.push(init?.redirect)
      return json({ access_token: 't', AccessToken: 'a', ExpiresIn: 600, Payments: [] })
    }) as typeof fetch
    const client = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://a.test', apiQueryBaseUrl: 'https://q.test', timeoutMs: 100, fetchImpl })
    await client.postSale({})
    await client.capture('p', 1)
    await client.void('p')
    await client.getByPaymentId('p')
    await client.getByMerchantOrderId('o')
    await client.getCard('t').catch(() => {})
    await emitirAccessTokenSop({ clientId: 'c', clientSecret: 's', merchantId: 'm', oauthTokenUrl: 'https://o.test', accessTokenUrl: 'https://t.test', timeoutMs: 100, fetchImpl })
    expect(vistos.length).toBeGreaterThanOrEqual(8)
    expect(vistos.every((v) => v === 'error')).toBe(true)
  })
})

describe('S-6 — prazos: escrita maior, consulta menor', () => {
  it('GET estoura em queryTimeoutMs e POST/PUT só em timeoutMs', async () => {
    const lento: Roteador = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    const { adapter } = adapterCom(lento, { timeoutMs: 600, queryTimeoutMs: 40 })
    const t0 = Date.now()
    await expect(adapter.consultar('p')).rejects.toThrow(/timeout/)
    const get = Date.now() - t0
    expect(get).toBeLessThan(300)
    const t1 = Date.now()
    await expect(adapter.cancelar('p')).rejects.toThrow(/timeout/)
    expect(Date.now() - t1).toBeGreaterThanOrEqual(500)
  })

  it('os defaults do env: CIELO_TIMEOUT_MS = 20000 (escrita) e CIELO_QUERY_TIMEOUT_MS = 8000 (consulta)', () => {
    const ambiente = { ...process.env }
    delete ambiente.CIELO_TIMEOUT_MS
    delete ambiente.CIELO_QUERY_TIMEOUT_MS
    const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/lib/env').then((m) => console.log(JSON.stringify({ t: m.env.CIELO_TIMEOUT_MS, q: m.env.CIELO_QUERY_TIMEOUT_MS })))"], {
      cwd: process.cwd(),
      env: ambiente,
      encoding: 'utf8',
    })
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toEqual({ t: 20_000, q: 8_000 })
  })
})

describe('S-4 — em PRODUÇÃO o token do caminho e o segredo do header do webhook exigem >= 32 caracteres', () => {
  function subir(env: Record<string, string>) {
    return spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/lib/env').then(() => console.log('BOOT-OK'))"], { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8' })
  }
  it('production + token de 31 caracteres: o boot NÃO sobe (exit 1); com 32 sobe; em test/dev o curto continua aceito (>= 8)', () => {
    const curto = subir({ NODE_ENV: 'production', CIELO_WEBHOOK_PATH_TOKEN: 'a'.repeat(31) })
    expect(curto.status).toBe(1)
    expect(curto.stderr).toMatch(/CIELO_WEBHOOK_PATH_TOKEN/)
    const header = subir({ NODE_ENV: 'production', CIELO_WEBHOOK_HEADER_SECRET: 'b'.repeat(31) })
    expect(header.status).toBe(1)
    expect(header.stderr).toMatch(/CIELO_WEBHOOK_HEADER_SECRET/)
    const ok = subir({ NODE_ENV: 'production', CIELO_WEBHOOK_PATH_TOKEN: 'a'.repeat(32), CIELO_WEBHOOK_HEADER_SECRET: 'b'.repeat(32) })
    expect(ok.stdout).toContain('BOOT-OK')
    expect(subir({ NODE_ENV: 'test', CIELO_WEBHOOK_PATH_TOKEN: 'a'.repeat(12) }).stdout).toContain('BOOT-OK')
    expect(subir({ NODE_ENV: 'production' }).stdout).toContain('BOOT-OK') // ausente continua válido (a rota fica inalcançável)
  }, 60_000)
})
