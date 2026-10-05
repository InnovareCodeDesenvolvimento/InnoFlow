import { describe, expect, it } from 'vitest'
import { avaliarPedidoDeEstorno, avaliarTetoDoCartao, calcularCobradoCents, descricaoDoEstornoNoExtrato, formatarDiaMes, type FotoCobrancaSessao } from '../../src/core/estornos/avaliarEstorno'
import { foraDaJanelaDeConsulta, interpretarReconsultaEstorno } from '../../src/core/estornos/interpretarReconsultaEstorno'

/** Núcleo PURO do estorno (L1.8): nada de banco/Redis/relógio aqui. */

const foto = (over: Partial<FotoCobrancaSessao> = {}): FotoCobrancaSessao => ({ totalCostCents: 1000, walletDebitCents: 1000, cardCapturedCents: 0, debtSettledCents: 0, estornadoCents: 0, ...over })

describe('avaliarPedidoDeEstorno / calcularCobradoCents', () => {
  it('cobrado = o que foi PAGO (carteira + cartão + dívida quitada), nunca acima do total da sessão', () => {
    expect(calcularCobradoCents(foto())).toBe(1000)
    expect(calcularCobradoCents(foto({ walletDebitCents: 400, debtSettledCents: 600 }))).toBe(1000)
    expect(calcularCobradoCents(foto({ walletDebitCents: 700, cardCapturedCents: 700 }))).toBe(1000) // dado incoerente: o teto é o total
    expect(calcularCobradoCents(foto({ walletDebitCents: 0 }))).toBe(0) // só dívida em aberto: nada foi pago
    expect(calcularCobradoCents(foto({ totalCostCents: null }))).toBe(0)
    expect(calcularCobradoCents(foto({ totalCostCents: 0 }))).toBe(0)
  })

  it('aceita até o que resta; recusa 1 centavo a mais, valor não inteiro e não positivo', () => {
    expect(avaliarPedidoDeEstorno(foto(), 1000)).toEqual({ ok: true, reembolsavelCents: 1000 })
    expect(avaliarPedidoDeEstorno(foto({ estornadoCents: 600 }), 400)).toEqual({ ok: true, reembolsavelCents: 400 })
    expect(avaliarPedidoDeEstorno(foto({ estornadoCents: 600 }), 401)).toEqual({ ok: false, codigo: 'AMOUNT_EXCEEDS_REFUNDABLE', reembolsavelCents: 400 })
    expect(avaliarPedidoDeEstorno(foto(), 10.5).ok).toBe(false)
    expect(avaliarPedidoDeEstorno(foto(), 0).ok).toBe(false)
    expect(avaliarPedidoDeEstorno(foto(), -1).ok).toBe(false)
  })

  it('sem nada cobrado é SESSION_NOT_BILLED (e não "excede")', () => {
    expect(avaliarPedidoDeEstorno(foto({ walletDebitCents: 0 }), 100)).toEqual({ ok: false, codigo: 'SESSION_NOT_BILLED' })
    expect(avaliarPedidoDeEstorno(foto({ totalCostCents: null }), 100)).toEqual({ ok: false, codigo: 'SESSION_NOT_BILLED' })
  })

  it('devolução no cartão: soma das do portal + novo pedido não passa do capturado', () => {
    expect(avaliarTetoDoCartao({ capturadoCents: 1000, devolucoesNoPortalCents: 300, amountCents: 700 })).toEqual({ ok: true })
    expect(avaliarTetoDoCartao({ capturadoCents: 1000, devolucoesNoPortalCents: 300, amountCents: 701 })).toEqual({ ok: false, disponivelCents: 700 })
  })

  it('texto do extrato e dd/mm no fuso do local (o motorista vê a data do carregador)', () => {
    expect(descricaoDoEstornoNoExtrato('05/10')).toBe('Estorno da recarga de 05/10')
    const d = new Date('2026-10-06T01:30:00Z') // 05/10 22:30 em São Paulo, 06/10 em UTC
    expect(formatarDiaMes(d, 'America/Sao_Paulo')).toBe('05/10')
    expect(formatarDiaMes(d, 'UTC')).toBe('06/10')
    expect(formatarDiaMes(d, 'Fuso/Que-Nao-Existe')).toBe('06/10') // fuso inválido cai em UTC, nunca lança
  })
})

describe('interpretarReconsultaEstorno — só confirma o inequívoco; o desconhecido é "não confirmado"', () => {
  it('Status 11 (Refunded) com o registro do ADMIN cobrindo o capturado inteiro -> CONFIRMADO', () => {
    expect(interpretarReconsultaEstorno({ statusBruto: 11, capturadoCents: 1000, devolucoesRegistradasCents: 1000 })).toEqual({ confirmado: true })
  })
  it('Status 11 mas o ADMIN registrou só parte -> divergência, NÃO confirma', () => {
    expect(interpretarReconsultaEstorno({ statusBruto: 11, capturadoCents: 1000, devolucoesRegistradasCents: 400 })).toEqual({ confirmado: false, motivo: 'STATUS_REFUNDED_MAS_REGISTRO_PARCIAL' })
  })
  it('Status 2 (ainda capturada — ou estorno PARCIAL, que a consulta não sabemos ler) -> não confirmado', () => {
    expect(interpretarReconsultaEstorno({ statusBruto: 2, capturadoCents: 1000, devolucoesRegistradasCents: 1000 })).toEqual({ confirmado: false, motivo: 'AINDA_CAPTURADA' })
  })
  it('status ausente, desconhecido ou capturado zero NUNCA confirma', () => {
    expect(interpretarReconsultaEstorno({ statusBruto: null, capturadoCents: 1000, devolucoesRegistradasCents: 1000 })).toEqual({ confirmado: false, motivo: 'SEM_STATUS' })
    expect(interpretarReconsultaEstorno({ statusBruto: undefined, capturadoCents: 1000, devolucoesRegistradasCents: 1000 }).confirmado).toBe(false)
    for (const s of [0, 1, 3, 10, 12, 13, 20, 99, -1]) expect(interpretarReconsultaEstorno({ statusBruto: s, capturadoCents: 1000, devolucoesRegistradasCents: 1000 }).confirmado, `status ${s}`).toBe(false)
    expect(interpretarReconsultaEstorno({ statusBruto: 11, capturadoCents: 0, devolucoesRegistradasCents: 0 }).confirmado).toBe(false)
  })
  it('janela da consulta (a Cielo só alcança ~3 meses)', () => {
    const agora = new Date('2026-10-05T12:00:00Z')
    expect(foraDaJanelaDeConsulta(new Date('2026-07-20T12:00:00Z'), agora, 85)).toBe(false)
    expect(foraDaJanelaDeConsulta(new Date('2026-07-01T12:00:00Z'), agora, 85)).toBe(true)
  })
})
