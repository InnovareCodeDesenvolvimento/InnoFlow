import { describe, expect, it } from 'vitest'
import { decidirReenfileirarCaptura, severidadeCapturaPendente } from '../../src/core/pagamentos/politicaCapturaPendente'
import {
  ConfiguracaoGatewayIncoerenteError,
  ConfiguracaoGatewayIndisponivelError,
  GatewayPagamentoNaoConfiguradoError,
  CartaoTokenInvalidoError,
  ehGatewayIndisponivelPorConfiguracao,
} from '../../src/core/pagamentos/erros'

describe('severidadeCapturaPendente (alerta escalonado por idade — F5.7)', () => {
  it.each([
    [0, 'normal'],
    [59, 'normal'],
    [60, 'alta'],
    [24 * 60 - 1, 'alta'],
    [24 * 60, 'critica'],
    [5 * 24 * 60, 'critica'],
  ] as const)('%i min -> %s', (minutos, esperado) => {
    expect(severidadeCapturaPendente(minutos)).toBe(esperado)
  })
})

describe('decidirReenfileirarCaptura (teto de tentativas do varredor)', () => {
  it('abaixo do teto reenfileira; no teto (>=) para', () => {
    expect(decidirReenfileirarCaptura(0, 100)).toBe('REENFILEIRAR')
    expect(decidirReenfileirarCaptura(99, 100)).toBe('REENFILEIRAR')
    expect(decidirReenfileirarCaptura(100, 100)).toBe('TETO_ATINGIDO')
    expect(decidirReenfileirarCaptura(250, 100)).toBe('TETO_ATINGIDO')
  })
})

describe('ehGatewayIndisponivelPorConfiguracao (job adia sem gastar tentativa)', () => {
  it('só os 3 erros de configuração/ambiente do gateway; qualquer outro erro continua sendo falha da operação', () => {
    expect(ehGatewayIndisponivelPorConfiguracao(new GatewayPagamentoNaoConfiguradoError())).toBe(true)
    expect(ehGatewayIndisponivelPorConfiguracao(new ConfiguracaoGatewayIndisponivelError('x'))).toBe(true)
    expect(ehGatewayIndisponivelPorConfiguracao(new ConfiguracaoGatewayIncoerenteError('x'))).toBe(true)
    expect(ehGatewayIndisponivelPorConfiguracao(new CartaoTokenInvalidoError('***1234'))).toBe(false)
    expect(ehGatewayIndisponivelPorConfiguracao(new Error('ECONNRESET'))).toBe(false)
    expect(ehGatewayIndisponivelPorConfiguracao(undefined)).toBe(false)
  })
})
