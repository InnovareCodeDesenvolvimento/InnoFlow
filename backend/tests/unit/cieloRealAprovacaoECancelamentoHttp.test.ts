import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { criarCieloAdapterFromEnv, type CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'
import { CieloFalsaHttp } from '../integration/helpers/cieloFalsaHttp'

/**
 * Íris (C2, 04/10/2026) — APROVAÇÃO e CANCELAMENTO pela "Cielo" HTTP de verdade (TCP local), não por `fetchImpl` injetado.
 *
 * Invariantes que NÃO dependem de como o normalizador foi escrito (o oráculo é a regra de negócio, não o `switch`):
 *   I1. Um ReturnCode de NEGAÇÃO do autorizador (tabela ISO 8583/Cielo abaixo) NUNCA vira AUTHORIZED nem CAPTURED, qualquer que seja o Status.
 *   I2. Status que não é número inteiro conhecido NUNCA vira AUTHORIZED/CAPTURED.
 *   I3. A Cielo só "cancelou" (VOIDED) com os DOIS sinais: ReturnCode 0/00/9 E Status 10/11.
 * E a comparação ponto a ponto contra o oráculo do Parque das Feiras (`traducao.ts`, conjunto {00,0,4,6}) — as divergências são DOCUMENTADAS aqui
 * (cada uma com a consequência), não escondidas.
 */

const CODIGOS_DE_NEGACAO = ['05', '5', '51', '57', '58', '04', '14', '54', '78', '91', '96', '99', '101', '102', '222', '-1', 'A', 'ERR', 'DENIED', 'null', 'undefined', '00x', '0 0', '000', '40', '41', '53']
const STATUS_GRADE: Array<number | string | null | undefined> = [-1, 0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 20, 99, 100, '1', '2', 'Authorized', null, undefined, 1.5]

// Oráculo do Parque (traducao.ts, copiado como CONSTANTE: o Parque é só leitura). `situacaoDe(returnCode, status)`.
const PARQUE_APROVA = new Set(['00', '0', '4', '6'])
function parqueSituacao(rc: unknown, status: unknown): 'confirmada' | 'em_analise' | 'recusada' | 'cancelada' | 'estornada' | 'aguardando' | 'desconhecida' {
  const num = typeof status === 'number' ? (Number.isInteger(status) ? status : null) : typeof status === 'string' && /^-?\d+$/.test(status.trim()) ? Number(status.trim()) : null
  const tab: Record<number, string> = { 0: 'aguardando', 1: 'em_analise', 2: 'confirmada', 3: 'recusada', 10: 'cancelada', 11: 'estornada', 12: 'aguardando', 13: 'cancelada' }
  const trad = num === null ? undefined : tab[num]
  const code = rc === null || rc === undefined ? null : typeof rc === 'number' ? String(rc) : typeof rc === 'string' ? rc.trim().toUpperCase() || null : null
  if (code === null || !PARQUE_APROVA.has(code)) {
    if (trad === 'recusada' || trad === 'cancelada' || trad === 'estornada') return trad
    return 'recusada'
  }
  return (trad as never) ?? 'desconhecida'
}

describe('Cielo HTTP real — aprovação e cancelamento (invariantes + oráculo do Parque)', () => {
  const cielo = new CieloFalsaHttp()
  let adapter: CieloAdapter

  beforeAll(async () => {
    const url = await cielo.iniciar()
    adapter = criarCieloAdapterFromEnv({
      CIELO_MERCHANT_ID: 'mid-iris',
      CIELO_MERCHANT_KEY: 'mkey-iris',
      CIELO_API_BASE_URL: url,
      CIELO_API_QUERY_BASE_URL: url,
      CIELO_TIMEOUT_MS: 1500,
      CIELO_SANDBOX: true,
    })
  })
  afterAll(() => cielo.parar())
  beforeEach(() => cielo.zerarRegistro())

  const pedido = (id: string) => ({ merchantOrderId: id, amountRequestedCents: 1000, cartao: { cardToken: 'tok-iris' }, cliente: { name: 'Motorista' } })

  async function autorizarCom(status: unknown, returnCode: unknown) {
    const id = `ord-${Math.random().toString(36).slice(2, 10)}`
    cielo.agendar('POST_SALE', { corpoRespostaCru: { MerchantOrderId: id, Payment: { PaymentId: `pay-${id}`, Amount: 1000, Status: status, ...(returnCode === undefined ? {} : { ReturnCode: returnCode }) } } })
    return adapter.autorizar(pedido(id))
  }

  it('I1+I2 — varredura Status x ReturnCode (HTTP 201 em todas): negação NUNCA aprova; só 00/4 aprova no Status 1', async () => {
    const aprovacoes: string[] = []
    for (const status of STATUS_GRADE) {
      for (const rc of [...CODIGOS_DE_NEGACAO, undefined, null, '', '   ']) {
        const r = await autorizarCom(status, rc)
        if (r.status === 'AUTHORIZED' || r.status === 'CAPTURED') aprovacoes.push(`Status=${JSON.stringify(status)} RC=${JSON.stringify(rc)} -> ${r.status}`)
      }
    }
    expect(aprovacoes, 'um código de NEGAÇÃO (ou ausente) virou aprovação').toEqual([])
  }, 120_000)

  it('HTTP 200/201 + Status 1 + ReturnCode 51 é NEGADA (o caso documentado pela Cielo): FAILED, nunca AUTHORIZED, e o ReturnCode fica para auditoria', async () => {
    const r = await autorizarCom(1, '51')
    expect(r.status).toBe('FAILED')
    expect(r.returnCode).toBe('51')
  })

  it.each([
    ['00', 'AUTHORIZED'],
    ['4', 'AUTHORIZED'],
    [4, 'AUTHORIZED'], // número no JSON
    [' 4 ', 'AUTHORIZED'], // espaços nas bordas
    ['00', 'AUTHORIZED'],
  ])('Status 1 + ReturnCode %j (aprovação LEGÍTIMA) -> %s', async (rc, esperado) => {
    expect((await autorizarCom(1, rc)).status).toBe(esperado)
  })

  it('"04" (código ISO 8583 de "capturar cartão") NÃO é o "4" da Cielo: não aprova (comparação é por string, não por número)', async () => {
    expect((await autorizarCom(1, '04')).status).toBe('FAILED')
    expect((await autorizarCom(1, '004')).status).toBe('FAILED')
  })

  it('Status 2 (capturada) SEM ReturnCode, ou com código de negação, é UNKNOWN->CREATED: nem CAPTURED (não afirma cobrança) nem FAILED (a venda pode estar capturada)', async () => {
    for (const rc of [undefined, null, '', '51', '05']) {
      const r = await autorizarCom(2, rc)
      expect(r.status, `Status 2 + RC ${JSON.stringify(rc)}`).toBe('CREATED')
    }
    expect((await autorizarCom(2, '6')).status).toBe('CAPTURED')
    expect((await autorizarCom(2, '00')).status).toBe('CAPTURED')
    expect((await autorizarCom(2, '4')).status).toBe('CAPTURED')
  })

  it('Status 0/12 (em processamento) é CREATED qualquer que seja o código; 3/13 é FAILED; 10/11 é VOIDED', async () => {
    for (const rc of ['4', '51', undefined]) {
      expect((await autorizarCom(0, rc)).status).toBe('CREATED')
      expect((await autorizarCom(12, rc)).status).toBe('CREATED')
      expect((await autorizarCom(3, rc)).status).toBe('FAILED')
      expect((await autorizarCom(13, rc)).status).toBe('FAILED')
    }
    expect((await autorizarCom(10, '0')).status).toBe('VOIDED')
    expect((await autorizarCom(11, '9')).status).toBe('VOIDED')
  })

  /**
   * DIVERGÊNCIAS contra o Parque (a Vega estreitou {00,0,4,6} -> {00,4} no Status 1 e {00,4,6} no Status 2). Esta tabela é o inventário honesto
   * do que muda: quando o Parque aprovaria e o InnoFlow NÃO. Para a Íris nenhuma delas é um código que a documentação da Cielo emita num Status 1
   * (0 é do Pix/cancelamento; 6 é "capturada"), MAS se a Cielo um dia emitir um Status 1 com '6', o InnoFlow recusa um motorista que foi autorizado
   * de verdade E deixa a pré-autorização viva sem ninguém cancelar (ver o teste de integração "órfã").
   */
  it('inventário de divergências vs Parque: o InnoFlow é MAIS ESTREITO (nunca mais largo) em Status 1/2 — e só nestes pares', async () => {
    const maisLargoQueParque: string[] = []
    const maisEstreitoQueParque: string[] = []
    for (const status of [0, 1, 2, 3, 10, 11, 12, 13, 20]) {
      for (const rc of ['00', '0', '4', '6', '51', '05', '9', '10', '223', '476', '101']) {
        const r = await autorizarCom(status, rc)
        const parque = parqueSituacao(rc, status)
        const nossoAprovou = r.status === 'AUTHORIZED' || r.status === 'CAPTURED'
        const parqueAprovou = parque === 'em_analise' || parque === 'confirmada'
        if (nossoAprovou && !parqueAprovou) maisLargoQueParque.push(`Status ${status} RC ${rc}: nós=${r.status} parque=${parque}`)
        if (!nossoAprovou && parqueAprovou) maisEstreitoQueParque.push(`Status ${status} RC ${rc}: nós=${r.status} parque=${parque}`)
      }
    }
    expect(maisLargoQueParque, 'o InnoFlow aprova algo que o Parque (produção) recusa').toEqual([])
    expect(maisEstreitoQueParque).toEqual(['Status 1 RC 0: nós=FAILED parque=em_analise', 'Status 1 RC 6: nós=FAILED parque=em_analise', 'Status 2 RC 0: nós=CREATED parque=confirmada'])
  }, 60_000)

  it('Status vindo como TEXTO ("1") no JSON vira não-definitivo (CREATED), nunca aprovação — o Parque aceita texto numérico (divergência de tolerância, a Cielo documenta número)', async () => {
    expect((await autorizarCom('1', '4')).status).toBe('CREATED')
    expect((await autorizarCom('2', '6')).status).toBe('CREATED')
  })

  describe('cancelamento (PUT void) — desfecho pelos DOIS sinais', () => {
    async function cancelarCom(status: unknown, returnCode: unknown) {
      const venda = cielo.plantarVenda({ merchantOrderId: `ord-${Math.random().toString(36).slice(2, 10)}` })
      cielo.agendar('PUT_VOID', { corpoRespostaCru: { Status: status, ReasonCode: 0, ...(returnCode === undefined ? {} : { ReturnCode: returnCode }) } })
      return adapter.cancelar(venda.paymentId)
    }

    it.each([
      [10, '0', 'CONFIRMADO', 'VOIDED'],
      [10, '00', 'CONFIRMADO', 'VOIDED'],
      [10, '9', 'CONFIRMADO', 'VOIDED'],
      [11, '9', 'CONFIRMADO', 'VOIDED'],
      [11, '0', 'CONFIRMADO', 'VOIDED'],
      [10, 0, 'CONFIRMADO', 'VOIDED'], // ReturnCode numérico
      [10, '10', 'EM_ANDAMENTO', 'AUTHORIZED'],
      [1, '223', 'EM_ANDAMENTO', 'AUTHORIZED'],
      [10, '476', 'EM_ANDAMENTO', 'AUTHORIZED'], // em andamento VENCE o Status 10: nada de dar por cancelado
      [1, '40', 'RECUSADO', 'FAILED'],
      [1, '41', 'RECUSADO', 'FAILED'],
      [1, '53', 'RECUSADO', 'FAILED'],
      [1, '101', 'RECUSADO', 'FAILED'],
      [1, '103', 'RECUSADO', 'FAILED'],
      [1, '107', 'RECUSADO', 'FAILED'],
      [10, '40', 'RECUSADO', 'FAILED'], // recusa vence o Status 10
      [1, '0', 'INDEFINIDO', 'AUTHORIZED'], // código de sucesso mas Status ainda 1: NÃO prova cancelamento
      [2, '0', 'INDEFINIDO', 'AUTHORIZED'],
      [10, undefined, 'INDEFINIDO', 'AUTHORIZED'], // Status 10 sem ReturnCode: fail-closed
      [11, undefined, 'INDEFINIDO', 'AUTHORIZED'],
      [10, '', 'INDEFINIDO', 'AUTHORIZED'],
      [10, '77', 'INDEFINIDO', 'AUTHORIZED'],
      [undefined, '0', 'INDEFINIDO', 'AUTHORIZED'],
      ['10', '0', 'INDEFINIDO', 'AUTHORIZED'], // Status texto
    ])('void devolve Status %j + ReturnCode %j -> desfecho %s, status do domínio %s', async (status, rc, desfecho, statusDominio) => {
      const r = await cancelarCom(status, rc)
      expect(r.desfecho).toBe(desfecho)
      expect(r.status).toBe(statusDominio)
    })

    it('I3 — varredura: VOIDED só com (RC 0/00/9) E (Status 10/11)', async () => {
      const voided: string[] = []
      for (const status of [-1, 0, 1, 2, 3, 10, 11, 12, 13, 20, undefined, null, '10']) {
        for (const rc of ['0', '00', '9', '10', '223', '476', '40', '41', '53', '101', '103', '51', '4', '6', '', undefined, null]) {
          const r = await cancelarCom(status, rc)
          const legitimo = ['0', '00', '9'].includes(String(rc)) && (status === 10 || status === 11)
          if (r.status === 'VOIDED' && !legitimo) voided.push(`Status=${JSON.stringify(status)} RC=${JSON.stringify(rc)}`)
          if (legitimo && r.status !== 'VOIDED') voided.push(`LEGÍTIMO NÃO CONFIRMADO: Status=${status} RC=${rc}`)
        }
      }
      expect(voided).toEqual([])
    }, 60_000)

    it('restrição cadastral (103-107) é sinalizada à parte; recusa comum não', async () => {
      expect((await cancelarCom(1, '104')).restricaoCadastral).toBe(true)
      expect((await cancelarCom(1, '40')).restricaoCadastral).toBe(false)
    })

    it('HTTP 4xx do void (venda já cancelada) NÃO vira VOIDED: o erro propaga como CieloHttpError', async () => {
      const venda = cielo.plantarVenda({ merchantOrderId: 'ord-ja-cancelada', status: 10, returnCode: '0' })
      await expect(adapter.cancelar(venda.paymentId)).rejects.toMatchObject({ name: 'CieloHttpError', httpStatus: 400 })
    })
  })
})
