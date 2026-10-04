import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classificarFalhaHttpCielo, mensagemDeFalhaCielo } from '../../src/core/pagamentos/classificarFalhaCielo'
import { identificadoresParaGravar, normalizarIdentificadorAdquirente } from '../../src/core/pagamentos/identificadoresAdquirente'
import { higienizarSoftDescriptor } from '../../src/core/pagamentos/softDescriptor'
import { CieloHttpClient, CieloHttpError, resetAlertasCieloParaTeste } from '../../src/services/pagamentos/cieloHttpClient'
import { CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'
import { extrairCamposPagamento, montarPayloadAutorizacaoCartao } from '../../src/services/pagamentos/cieloPayloads'
import { logger } from '../../src/lib/logger'

const lista = (...codigos: number[]) => codigos.map((Code) => ({ Code, Message: 'qualquer texto' }))

describe('classificarFalhaHttpCielo (F3/F4) — oráculo: api.ts do Parque', () => {
  it.each([101, 131, 132, 138, 139, 140])('HTTP 400 com código %i = CREDENCIAL (a Cielo NÃO devolve 401 para credencial errada)', (codigo) => {
    expect(classificarFalhaHttpCielo(400, lista(codigo))).toEqual({ tipo: 'CREDENCIAL', codigos: [codigo] })
  })

  it('HTTP 400 cuja MENSAGEM cita MerchantId/MerchantKey é credencial mesmo com código novo (os códigos do sandbox não são os da produção)', () => {
    expect(classificarFalhaHttpCielo(400, [{ Code: 777, Message: 'MerchantKey is invalid' }]).tipo).toBe('CREDENCIAL')
    expect(classificarFalhaHttpCielo(400, [{ Code: 778, Message: 'merchant id not found' }]).tipo).toBe('CREDENCIAL')
  })

  it('HTTP 400 com erro de payload (ex.: 126 cartão expirado, 129 valor inválido) NÃO é credencial — é defeito de requisição', () => {
    expect(classificarFalhaHttpCielo(400, lista(126)).tipo).toBe('REQUISICAO_RECUSADA')
    expect(classificarFalhaHttpCielo(400, []).tipo).toBe('REQUISICAO_RECUSADA')
    expect(classificarFalhaHttpCielo(400, null).tipo).toBe('REQUISICAO_RECUSADA')
  })

  it('401 = credencial; 403 = IP fora da lista (NÃO credencial); 429; 404; 5xx = indisponível', () => {
    expect(classificarFalhaHttpCielo(401, null).tipo).toBe('CREDENCIAL')
    expect(classificarFalhaHttpCielo(403, null).tipo).toBe('IP_NAO_PERMITIDO')
    expect(classificarFalhaHttpCielo(429, null).tipo).toBe('LIMITE_DE_CHAMADAS')
    expect(classificarFalhaHttpCielo(404, null).tipo).toBe('NAO_ENCONTRADO')
    for (const s of [500, 502, 503, 504]) expect(classificarFalhaHttpCielo(s, null).tipo).toBe('INDISPONIVEL')
  })

  it('só os códigos numéricos saem — nunca o texto da Cielo (que pode ecoar dado do pagador)', () => {
    const f = classificarFalhaHttpCielo(400, [{ Code: 132, Message: 'ECO-SEGREDO-123456' }, { Code: '131', Message: 'x' }, { Code: 'abc' }, null, 7])
    expect(f.codigos).toEqual([132, 131])
    expect(JSON.stringify(f)).not.toContain('ECO-SEGREDO')
  })

  it('a mensagem do 403 manda conferir a lista de IPs ANTES de trocar a credencial; a de credencial cita o ambiente; nenhuma carrega corpo cru', () => {
    const ip = mensagemDeFalhaCielo({ tipo: 'IP_NAO_PERMITIDO', codigos: [] }, 403)
    expect(ip).toMatch(/lista de IPs confiáveis/)
    expect(ip).toMatch(/ANTES de trocar ou apagar a credencial/)
    expect(ip).not.toMatch(/credencial (recusada|inválida)/i)
    const cred = mensagemDeFalhaCielo({ tipo: 'CREDENCIAL', codigos: [132] }, 400)
    expect(cred).toMatch(/AMBIENTE/)
    expect(cred).toContain('132')
    expect(mensagemDeFalhaCielo({ tipo: 'INDISPONIVEL', codigos: [] }, 503)).toMatch(/indisponível/)
  })
})

describe('CieloHttpClient — falha classificada, alerta e log sem segredo', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => resetAlertasCieloParaTeste())

  function clientCom(status: number, corpo: unknown): CieloHttpClient {
    const fetchImpl = (async () => new Response(JSON.stringify(corpo), { status })) as typeof fetch
    return new CieloHttpClient({ merchantId: 'm', merchantKey: 'MERCHANT-KEY-SECRETA', apiBaseUrl: 'https://api.example.test', apiQueryBaseUrl: 'https://q.example.test', timeoutMs: 100, fetchImpl })
  }

  it('CieloHttpError carrega tipo e códigos; a mensagem é a do admin (sem o corpo cru)', async () => {
    const err = await clientCom(400, [{ Code: 132, Message: 'MerchantKey is invalid ECO-DO-PAGADOR-999' }]).postSale({}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CieloHttpError)
    const e = err as CieloHttpError
    expect(e).toMatchObject({ tipo: 'CREDENCIAL', httpStatus: 400, codigos: [132] })
    expect(e.message).not.toContain('ECO-DO-PAGADOR')
    expect(e.message).toContain('132')
  })

  it('credencial recusada dispara o alerta payment_gateway_credential_rejected e 403 dispara payment_gateway_ip_not_allowed (nunca com segredo)', async () => {
    const erro = vi.spyOn(logger, 'error')
    await clientCom(400, lista(132)).postSale({}).catch(() => {})
    await clientCom(403, null).getByPaymentId('p1').catch(() => {})
    const alertas = erro.mock.calls.map((c) => (c[0] as { alert?: string }).alert)
    expect(alertas).toContain('payment_gateway_credential_rejected')
    expect(alertas).toContain('payment_gateway_ip_not_allowed')
    expect(JSON.stringify(erro.mock.calls)).not.toContain('MERCHANT-KEY-SECRETA')
  })

  it('o CardToken do GET /1/card/{token} nunca vai ao log (o path é mascarado)', async () => {
    const warn = vi.spyOn(logger, 'warn')
    await clientCom(404, { message: 'x' }).getCard('CARD-TOKEN-SECRETO-ABC').catch(() => {})
    const tudo = JSON.stringify(warn.mock.calls)
    expect(tudo).not.toContain('CARD-TOKEN-SECRETO-ABC')
    expect(tudo).toContain('/1/card/***')
  })
})

describe('identificadores da adquirente (C2.5)', () => {
  it('Tid/AuthorizationCode/ProofOfSale são lidos de Payment; vazio vira null; número vira texto', () => {
    const campos = extrairCamposPagamento({ Payment: { PaymentId: 'p', Status: 1, ReturnCode: '4', Tid: '10069930691D8CE81001', AuthorizationCode: '  123456 ', ProofOfSale: 987654 } })
    expect(campos.identificadores).toEqual({ tid: '10069930691D8CE81001', authorizationCode: '123456', proofOfSale: '987654' })
    expect(extrairCamposPagamento({ Payment: { Status: 1, Tid: '', AuthorizationCode: '   ', ProofOfSale: null } }).identificadores).toEqual({ tid: null, authorizationCode: null, proofOfSale: null })
    expect(extrairCamposPagamento({ Status: 2, ReturnCode: '6' }).identificadores).toEqual({ tid: null, authorizationCode: null, proofOfSale: null })
  })

  it('valor acima de 64 caracteres é TRUNCADO em 64 e sinalizado (por nome, nunca o valor) — nunca lança', () => {
    expect(normalizarIdentificadorAdquirente('x'.repeat(64))).toEqual({ valor: 'x'.repeat(64), truncado: false })
    expect(normalizarIdentificadorAdquirente('x'.repeat(65))).toEqual({ valor: 'x'.repeat(64), truncado: true })
    const campos = extrairCamposPagamento({ Payment: { Status: 1, Tid: 'T'.repeat(200), ProofOfSale: 'ok' } })
    expect(campos.identificadores.tid).toHaveLength(64)
    expect(campos.identificadoresTruncados).toEqual(['Tid'])
  })

  it('identificadoresParaGravar só devolve chaves com valor (um null não apaga o que a autorização gravou) e também trunca a 64', () => {
    expect(identificadoresParaGravar({ tid: 'T', authorizationCode: null, proofOfSale: null })).toEqual({ cieloTid: 'T' })
    expect(identificadoresParaGravar(null)).toEqual({})
    // cada chave é independente: um null em QUALQUER campo some do UPDATE (nunca vira `cieloX: null` por cima do que já está gravado)
    for (const parcial of [{ tid: null, authorizationCode: 'A', proofOfSale: 'P' }, { tid: 'T', authorizationCode: null, proofOfSale: 'P' }, { tid: 'T', authorizationCode: 'A', proofOfSale: null }]) {
      const dados = identificadoresParaGravar(parcial)
      expect(Object.values(dados)).not.toContain(null)
      expect(Object.keys(dados)).toHaveLength(2)
    }
    expect(identificadoresParaGravar({ tid: null, authorizationCode: null, proofOfSale: null })).toEqual({})
    expect(identificadoresParaGravar({ tid: 'y'.repeat(100), authorizationCode: null, proofOfSale: null }).cieloTid).toHaveLength(64)
  })

  it('o log do adaptador avisa o truncamento SEM o valor do identificador', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const fetchImpl = (async () => new Response(JSON.stringify({ Payment: { PaymentId: 'p', Status: 1, ReturnCode: '4', Amount: 100, Tid: 'SEGREDO-TID-'.repeat(10) } }), { status: 200 })) as typeof fetch
    const adapter = new CieloAdapter(new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: 'https://a.test', apiQueryBaseUrl: 'https://q.test', timeoutMs: 100, fetchImpl }), { merchantId: 'm', sandbox: true })
    const r = await adapter.autorizar({ merchantOrderId: 'o', amountRequestedCents: 100, cartao: { cardToken: 't' }, cliente: { name: 'N' } })
    expect(r.status).toBe('AUTHORIZED') // o fluxo NÃO cai
    expect(r.identificadores.tid).toHaveLength(64)
    const chamadaDeAlerta = warn.mock.calls.find((c) => (c[0] as { alert?: string }).alert === 'payment_cielo_identifier_truncated')
    expect(chamadaDeAlerta).toBeTruthy()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SEGREDO-TID')
  })
})

describe('SoftDescriptor (F21/C2.4)', () => {
  it('higieniza: sem acento, maiúsculo, só A-Z0-9, máx. 13', () => {
    expect(higienizarSoftDescriptor('InnoFlow')).toBe('INNOFLOW')
    expect(higienizarSoftDescriptor('Elétron Posto & Cia. - Recarga!')).toBe('ELETRONPOSTOC')
    expect(higienizarSoftDescriptor('São João 24h')).toBe('SAOJOAO24H')
    expect(higienizarSoftDescriptor('A'.repeat(30))).toHaveLength(13)
    expect(higienizarSoftDescriptor('Ç-Ã_Õ ñ')).toBe('CAON')
  })

  it('vazio depois de higienizar vira null (o campo não vai)', () => {
    for (const v of [undefined, null, '', '   ', '---', '!!!']) expect(higienizarSoftDescriptor(v)).toBeNull()
  })

  it('o payload de autorização manda SoftDescriptor higienizado, e omite o campo se nada sobra', () => {
    const base = { merchantOrderId: 'o', amountRequestedCents: 100, cartao: { cardToken: 't' }, cliente: { name: 'N' } }
    expect(montarPayloadAutorizacaoCartao({ ...base, softDescriptor: 'Inno-Flow & Cia' }).Payment.SoftDescriptor).toBe('INNOFLOWCIA')
    expect(montarPayloadAutorizacaoCartao({ ...base, softDescriptor: '---' }).Payment).not.toHaveProperty('SoftDescriptor')
    expect(montarPayloadAutorizacaoCartao(base).Payment).not.toHaveProperty('SoftDescriptor')
  })
})
