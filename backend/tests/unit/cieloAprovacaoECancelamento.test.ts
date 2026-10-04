import { describe, expect, it } from 'vitest'
import { interpretarCancelamentoCielo, normalizarStatusCartaoCielo, type StatusCartaoNormalizado } from '../../src/core/pagamentos/normalizarStatusCielo'
import { CieloHttpClient } from '../../src/services/pagamentos/cieloHttpClient'
import { CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'

/**
 * F16 + F19 (C2.3). ORÁCULO: as tabelas de `traducao.ts` do Parque das Feiras (produção) — aprovação = `ReturnCode` E `Status`, nunca HTTP 2xx sozinho;
 * cancelamento: 0/00/9 aprova (Status 10 cancelada ou 11 estornada), 10/223/476 "em andamento", 40/41/53/101 e 103–107 recusa definitiva.
 * Dinheiro: o invariante central é "NUNCA AUTHORIZED/CAPTURED/VOIDED sem os dois sinais" — atacado por varredura exaustiva, não só por exemplos.
 */

const STATUS = [-1, 0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 20, 21, 99, 999, Number.NaN]
const RETURN_CODES: Array<string | null> = [null, '', ' ', '0', '00', '4', '04', '6', '06', '9', '10', '41', '51', '57', '99', '223', '476', 'abc']

describe('normalizarStatusCartaoCielo — invariante de aprovação (varredura exaustiva Status x ReturnCode)', () => {
  it('AUTHORIZED só com Status 1 + ReturnCode 00/4; CAPTURED só com Status 2 + ReturnCode 00/4/6; nenhuma outra combinação aprova', () => {
    for (const status of STATUS) {
      for (const returnCode of RETURN_CODES) {
        const r = normalizarStatusCartaoCielo({ status, returnCode })
        const code = returnCode?.trim() ?? null
        const deveAutorizar = status === 1 && (code === '00' || code === '4')
        const deveCapturar = status === 2 && (code === '00' || code === '4' || code === '6')
        expect(r === 'AUTHORIZED', `status ${status} rc ${JSON.stringify(returnCode)} -> ${r}`).toBe(deveAutorizar)
        expect(r === 'CAPTURED', `status ${status} rc ${JSON.stringify(returnCode)} -> ${r}`).toBe(deveCapturar)
      }
    }
  })

  it('o caso documentado: Status 1 com ReturnCode 51 (negada dentro de um HTTP 2xx) é DENIED', () => {
    expect(normalizarStatusCartaoCielo({ status: 1, returnCode: '51' })).toBe('DENIED')
  })

  it('Status 2 com ReturnCode que não aprova (ou ausente) é INCOERENTE: UNKNOWN — nem CAPTURED (não afirmamos cobrança) nem FAILED (a venda pode ter sido capturada; falha criaria dívida em dobro)', () => {
    for (const returnCode of ['51', '05', '0', null, '']) {
      expect(normalizarStatusCartaoCielo({ status: 2, returnCode })).toBe('UNKNOWN')
    }
  })

  it('tabela de Status terminais e transitórios (igual ao Parque)', () => {
    const esperado: Record<number, StatusCartaoNormalizado> = { 0: 'PENDING', 12: 'PENDING', 3: 'DENIED', 10: 'VOIDED', 11: 'REFUNDED', 13: 'FAILED', 20: 'UNKNOWN', 999: 'UNKNOWN', [-1]: 'UNKNOWN' }
    for (const [status, normalizado] of Object.entries(esperado)) expect(normalizarStatusCartaoCielo({ status: Number(status), returnCode: '00' })).toBe(normalizado)
  })

  it('ReturnCode é comparado como string normalizada: " 4 " e o número 4 contam como "4"', () => {
    expect(normalizarStatusCartaoCielo({ status: 1, returnCode: ' 4 ' })).toBe('AUTHORIZED')
    expect(normalizarStatusCartaoCielo({ status: 1, returnCode: 4 as unknown as string })).toBe('AUTHORIZED')
  })
})

describe('interpretarCancelamentoCielo (F19)', () => {
  it.each([
    ['0', 10, 'VOIDED'],
    ['00', 10, 'VOIDED'],
    ['9', 10, 'VOIDED'],
    ['0', 11, 'REFUNDED'],
    ['9', 11, 'REFUNDED'],
  ] as const)('ReturnCode %s + Status %i = CONFIRMADO (%s) — a Cielo decide cancelar x estornar pelo relógio', (returnCode, status, reversao) => {
    expect(interpretarCancelamentoCielo({ status, returnCode })).toEqual({ desfecho: 'CONFIRMADO', reversao, restricaoCadastral: false })
  })

  it.each(['10', '223', '476'])('ReturnCode %s = EM_ANDAMENTO (nem sucesso nem recusa) — mesmo com Status 10 na resposta', (returnCode) => {
    for (const status of [1, 10, 11]) expect(interpretarCancelamentoCielo({ status, returnCode }).desfecho).toBe('EM_ANDAMENTO')
  })

  it.each(['40', '41', '53', '101'])('ReturnCode %s = RECUSADO definitivo, não é restrição cadastral', (returnCode) => {
    expect(interpretarCancelamentoCielo({ status: 1, returnCode })).toEqual({ desfecho: 'RECUSADO', reversao: null, restricaoCadastral: false })
  })

  it.each(['103', '104', '105', '106', '107'])('ReturnCode %s = RECUSADO por restrição CADASTRAL (problema da conta)', (returnCode) => {
    expect(interpretarCancelamentoCielo({ status: 1, returnCode })).toEqual({ desfecho: 'RECUSADO', reversao: null, restricaoCadastral: true })
  })

  it('INDEFINIDO (fail-closed): código de aprovação com Status que não confirma, Status 10/11 sem código, código desconhecido ou ausente — nunca CONFIRMADO sem os dois sinais', () => {
    for (const r of [
      { status: 1, returnCode: '0' },
      { status: 1, returnCode: '9' },
      { status: 2, returnCode: '0' },
      { status: 10, returnCode: null },
      { status: 11, returnCode: '' },
      { status: 10, returnCode: '77' },
      { status: 10, returnCode: '6' }, // 6 é "capturada" no pagamento — não é código de cancelamento
      { status: 999, returnCode: '0' },
    ]) {
      expect(interpretarCancelamentoCielo(r).desfecho, JSON.stringify(r)).toBe('INDEFINIDO')
    }
  })

  it('varredura exaustiva: CONFIRMADO exige ReturnCode 0/00/9 E Status 10/11', () => {
    for (const status of STATUS) {
      for (const returnCode of RETURN_CODES) {
        const r = interpretarCancelamentoCielo({ status, returnCode })
        const code = returnCode?.trim() ?? null
        const deve = (code === '0' || code === '00' || code === '9') && (status === 10 || status === 11)
        expect(r.desfecho === 'CONFIRMADO', `status ${status} rc ${JSON.stringify(returnCode)}`).toBe(deve)
      }
    }
  })
})

describe('CieloAdapter — HTTP 2xx NÃO é aprovação (contrato ponta a ponta, fetch injetado)', () => {
  function adapterCom(resposta: unknown): CieloAdapter {
    const fetchImpl = (async () => new Response(JSON.stringify(resposta), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
    const client = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://api.example.test', apiQueryBaseUrl: 'https://q.example.test', timeoutMs: 100, fetchImpl })
    return new CieloAdapter(client, { merchantId: 'm', sandbox: true })
  }
  const pedido = { merchantOrderId: 'o1', amountRequestedCents: 1000, cartao: { cardToken: 't' }, cliente: { name: 'N' } }

  it('autorizar: HTTP 200 com Status 1 + ReturnCode 51 -> FAILED (não AUTHORIZED)', async () => {
    const r = await adapterCom({ MerchantOrderId: 'o1', Payment: { PaymentId: 'p', Status: 1, ReturnCode: '51', Amount: 1000 } }).autorizar(pedido)
    expect(r.status).toBe('FAILED')
  })

  it('autorizar: HTTP 200 com Status desconhecido ou ausente -> CREATED (não definitivo), jamais AUTHORIZED', async () => {
    for (const payment of [{ PaymentId: 'p', Status: 99, ReturnCode: '00' }, { PaymentId: 'p' }]) {
      const r = await adapterCom({ Payment: payment }).autorizar(pedido)
      expect(r.status).toBe('CREATED')
    }
  })

  it('capturar: HTTP 200 com Status 2 mas ReturnCode 51 -> CREATED (não definitivo), jamais CAPTURED; com ReturnCode 6 -> CAPTURED', async () => {
    expect((await adapterCom({ Status: 2, ReturnCode: '51', ReturnMessage: 'x' }).capturar('p', 500)).status).toBe('CREATED')
    expect((await adapterCom({ Status: 2, ReturnCode: '6', ReturnMessage: 'Operation Successful' }).capturar('p', 500)).status).toBe('CAPTURED')
  })

  it('cancelar: HTTP 200 só vira VOIDED com ReturnCode 0/9 + Status 10/11; Status 1 (ainda autorizada) com ReturnCode 0 NÃO é cancelamento', async () => {
    const naoConfirmado = await adapterCom({ Status: 1, ReturnCode: '0' }).cancelar('p')
    expect(naoConfirmado).toMatchObject({ status: 'AUTHORIZED', desfecho: 'INDEFINIDO', reversao: null })
    expect(await adapterCom({ Status: 10, ReturnCode: '0' }).cancelar('p')).toMatchObject({ status: 'VOIDED', desfecho: 'CONFIRMADO', reversao: 'VOIDED' })
    expect(await adapterCom({ Status: 11, ReturnCode: '9' }).cancelar('p')).toMatchObject({ status: 'VOIDED', desfecho: 'CONFIRMADO', reversao: 'REFUNDED' })
    expect(await adapterCom({ Status: 1, ReturnCode: '476' }).cancelar('p')).toMatchObject({ status: 'AUTHORIZED', desfecho: 'EM_ANDAMENTO' })
    expect(await adapterCom({ Status: 1, ReturnCode: '41' }).cancelar('p')).toMatchObject({ status: 'FAILED', desfecho: 'RECUSADO' })
  })

  it('consultar: Status 11 (estornada) -> VOIDED no domínio; Status 2 sem ReturnCode -> CREATED (não definitivo)', async () => {
    expect((await adapterCom({ Payment: { PaymentId: 'p', Status: 11, ReturnCode: '9' } }).consultar('p')).status).toBe('VOIDED')
    expect((await adapterCom({ Payment: { PaymentId: 'p', Status: 2 } }).consultar('p')).status).toBe('CREATED')
  })
})
