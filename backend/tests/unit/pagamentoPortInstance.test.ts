import { beforeEach, describe, expect, it, vi } from 'vitest'

// env e logger MOCKADOS: o resolvedor lê `env` no import, e aqui precisamos variar NODE_ENV/credenciais por teste.
const envFake = vi.hoisted(() => ({
  NODE_ENV: 'production' as 'development' | 'test' | 'production',
  LOG_LEVEL: 'silent',
  CIELO_MERCHANT_ID: undefined as string | undefined,
  CIELO_MERCHANT_KEY: undefined as string | undefined,
  CIELO_API_BASE_URL: 'https://apisandbox.cieloecommerce.cielo.com.br',
  CIELO_API_QUERY_BASE_URL: 'https://apiquerysandbox.cieloecommerce.cielo.com.br',
  CIELO_SANDBOX: true,
  CIELO_TIMEOUT_MS: 8000,
  CIELO_SOP_SCRIPT_URL: undefined as string | undefined,
  CIELO_SOP_CLIENT_ID: undefined as string | undefined,
  CIELO_SOP_CLIENT_SECRET: undefined as string | undefined,
  CIELO_SOP_OAUTH_TOKEN_URL: undefined as string | undefined,
  PAYMENT_ALLOW_FAKE_ADAPTER: false,
}))
vi.mock('../../src/lib/env', () => ({ env: envFake }))
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { getPagamentoPort, isPagamentoDisponivel, isUsandoFakeAdapter, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { GatewayPagamentoNaoConfiguradoError } from '../../src/core/pagamentos/erros'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'

beforeEach(() => {
  resetPagamentoPortCacheParaTeste()
  envFake.NODE_ENV = 'production'
  envFake.CIELO_MERCHANT_ID = undefined
  envFake.CIELO_MERCHANT_KEY = undefined
  envFake.PAYMENT_ALLOW_FAKE_ADAPTER = false
})

describe('getPagamentoPort — produção nunca cai no simulador sem querer', () => {
  it('PRODUÇÃO sem credencial: lança GatewayPagamentoNaoConfiguradoError (as rotas viram 503) e NÃO devolve o Fake', () => {
    expect(() => getPagamentoPort()).toThrow(GatewayPagamentoNaoConfiguradoError)
    expect(isUsandoFakeAdapter()).toBe(false)
    expect(isPagamentoDisponivel()).toBe(false)
  })

  it('o bloqueio NÃO é cacheado: configurar a credencial depois destrava sem reiniciar o cache', () => {
    expect(() => getPagamentoPort()).toThrow(GatewayPagamentoNaoConfiguradoError)
    envFake.CIELO_MERCHANT_ID = 'merchant-id-teste'
    envFake.CIELO_MERCHANT_KEY = 'merchant-key-teste'
    expect(getPagamentoPort()).not.toBeInstanceOf(FakeAdapter)
    expect(isUsandoFakeAdapter()).toBe(false)
  })

  it('PRODUÇÃO com opt-in explícito: devolve o Fake (e marca como Fake)', () => {
    envFake.PAYMENT_ALLOW_FAKE_ADAPTER = true
    expect(getPagamentoPort()).toBeInstanceOf(FakeAdapter)
    expect(isUsandoFakeAdapter()).toBe(true)
    expect(isPagamentoDisponivel()).toBe(true)
  })

  it('desenvolvimento sem credencial: Fake, como sempre (demo/CI/testes seguem funcionando)', () => {
    envFake.NODE_ENV = 'development'
    expect(getPagamentoPort()).toBeInstanceOf(FakeAdapter)
    expect(isPagamentoDisponivel()).toBe(true)
  })

  it('credencial presente em produção: adaptador Cielo, nunca o Fake, mesmo com o opt-in ligado', () => {
    envFake.CIELO_MERCHANT_ID = 'merchant-id-teste'
    envFake.CIELO_MERCHANT_KEY = 'merchant-key-teste'
    envFake.PAYMENT_ALLOW_FAKE_ADAPTER = true
    expect(getPagamentoPort()).not.toBeInstanceOf(FakeAdapter)
    expect(isUsandoFakeAdapter()).toBe(false)
  })
})
