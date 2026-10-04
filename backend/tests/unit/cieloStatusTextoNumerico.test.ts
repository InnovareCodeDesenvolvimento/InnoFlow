import { describe, expect, it } from 'vitest'
import { CieloHttpClient } from '../../src/services/pagamentos/cieloHttpClient'
import { CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'
import { extrairCamposPagamento, lerListaDaConsultaPorPedido, lerStatusCielo } from '../../src/services/pagamentos/cieloPayloads'

/**
 * Achado da Íris: o Parque aceita `Status` como número OU texto numérico ("1"); aqui só `number` valia e `"1"` virava "sem Status" (CREATED, não conclusivo). Agora os dois valem — e
 * o resto (decimal, texto, vazio, negativo, NaN) continua "sem Status" (nunca aprovação).
 */
const json = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } })
function adapterCom(corpo: unknown): CieloAdapter {
  const fetchImpl = (async () => json(corpo)) as typeof fetch
  return new CieloAdapter(new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://a.test', apiQueryBaseUrl: 'https://q.test', timeoutMs: 100, fetchImpl }), { merchantId: 'm', sandbox: true })
}
const pedido = { merchantOrderId: 'o1', amountRequestedCents: 1000, cartao: { cardToken: 't' }, cliente: { name: 'N' } }

describe('lerStatusCielo', () => {
  it('número inteiro e texto numérico valem; o resto é -1 (sem Status)', () => {
    expect(lerStatusCielo(1)).toBe(1)
    expect(lerStatusCielo('1')).toBe(1)
    expect(lerStatusCielo(' 10 ')).toBe(10)
    expect(lerStatusCielo('013')).toBe(13)
    for (const ruim of [undefined, null, '', ' ', 'abc', '1.5', 1.5, -1, '-1', Number.NaN, '1e2', '0x1', {}, [], '9999', true]) expect(lerStatusCielo(ruim), String(ruim)).toBe(-1)
  })
})

describe('adaptador com Status em texto numérico (igual ao Parque)', () => {
  it('autorizar: "1" + ReturnCode 4 -> AUTHORIZED, statusBruto 1 (antes: CREATED)', async () => {
    const r = await adapterCom({ Payment: { PaymentId: 'p', Status: '1', ReturnCode: '4', Amount: 1000 } }).autorizar(pedido)
    expect(r).toMatchObject({ status: 'AUTHORIZED', statusBruto: 1 })
  })

  it('o ReturnCode continua mandando: "1" + 51 -> FAILED (recusa conhecida); "1" + ReturnCode ausente -> CREATED (não definitivo); nunca aprovação só pelo Status', async () => {
    expect((await adapterCom({ Payment: { PaymentId: 'p', Status: '1', ReturnCode: '51' } }).autorizar(pedido)).status).toBe('FAILED')
    expect((await adapterCom({ Payment: { PaymentId: 'p', Status: '1' } }).autorizar(pedido)).status).toBe('CREATED')
  })

  it('captura "2" + 6 -> CAPTURED; "2" sem código -> CREATED; consulta "10" -> VOIDED; "3" -> FAILED', async () => {
    expect((await adapterCom({ Status: '2', ReturnCode: '6' }).capturar('p', 100)).status).toBe('CAPTURED')
    expect((await adapterCom({ Status: '2' }).capturar('p', 100)).status).toBe('CREATED')
    expect((await adapterCom({ Payment: { PaymentId: 'p', Status: '10', ReturnCode: '0' } }).consultar('p')).status).toBe('VOIDED')
    expect((await adapterCom({ Payment: { PaymentId: 'p', Status: '3', ReturnCode: '05' } }).consultar('p')).status).toBe('FAILED')
  })

  it('cancelamento: Status "10" + ReturnCode 0 é CONFIRMADO; "1" + 0 continua INDEFINIDO', async () => {
    expect(await adapterCom({ Status: '10', ReturnCode: '0' }).cancelar('p')).toMatchObject({ status: 'VOIDED', desfecho: 'CONFIRMADO' })
    expect(await adapterCom({ Status: '1', ReturnCode: '0' }).cancelar('p')).toMatchObject({ desfecho: 'INDEFINIDO' })
  })

  it('Status inválido (decimal/texto) continua "sem Status": nem aprovação nem falha definitiva', async () => {
    for (const status of ['1.5', 'abc', '']) {
      const r = await adapterCom({ Payment: { PaymentId: 'p', Status: status, ReturnCode: '4' } }).autorizar(pedido)
      expect(r.status, status).toBe('CREATED')
      expect(r.statusBruto).toBeNull()
    }
  })

  it('extrairCamposPagamento e a lista por pedido (formato antigo) leem o Status em texto', () => {
    expect(extrairCamposPagamento({ Payment: { Status: '2', ReturnCode: '6' } }).status).toBe(2)
    const lista = lerListaDaConsultaPorPedido({ Payments: [{ PaymentId: 'a', Status: '1', ReturnCode: '4' }] })
    expect(lista.entradas[0].inline).toMatchObject({ status: 1, returnCode: '4' })
  })
})
