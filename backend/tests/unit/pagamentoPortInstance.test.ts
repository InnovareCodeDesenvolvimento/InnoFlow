import { beforeEach, describe, expect, it, vi } from 'vitest'

// env, logger e prisma MOCKADOS: o resolvedor lê `env` no import e agora lê a config do banco — aqui variamos
// NODE_ENV/credenciais/linha do banco por teste, sem Postgres.
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
  CIELO_WEBHOOK_PATH_TOKEN: undefined as string | undefined,
  CIELO_WEBHOOK_HEADER_SECRET: undefined as string | undefined,
  PAYMENT_SECRETS_KEY: 'N9kxeAXn4BnqUUoF1v+dbfdbLGJLH0WPqIdGIqbbK28=' as string | undefined,
  PAYMENT_ALLOW_FAKE_ADAPTER: false,
}))
vi.mock('../../src/lib/env', () => ({ env: envFake }))
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const prismaFake = vi.hoisted(() => ({ paymentGatewayConfig: { findUnique: vi.fn() } }))
vi.mock('../../src/lib/prisma', () => ({ prisma: prismaFake }))

import { getPagamentoPort, isPagamentoDisponivel, isUsandoFakeAdapter, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { invalidarCacheConfigGateway, resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { encryptPaymentSecret, resetPaymentSecretsKeyCacheParaTeste } from '../../src/lib/crypto/paymentSecrets'
import { ConfiguracaoGatewayIncoerenteError, ConfiguracaoGatewayIndisponivelError, GatewayPagamentoNaoConfiguradoError } from '../../src/core/pagamentos/erros'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'

const CHAVE_A = 'N9kxeAXn4BnqUUoF1v+dbfdbLGJLH0WPqIdGIqbbK28='
const CHAVE_B = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

function linhaBanco(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    environment: 'sandbox',
    merchantId: null,
    merchantKeyCiphertext: null,
    sopClientId: null,
    sopClientSecretCiphertext: null,
    webhookHeaderSecretCiphertext: null,
    cardEnabled: true,
    pixEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

type CieloInterno = { config: { merchantId: string; sandbox: boolean } }

beforeEach(() => {
  resetPagamentoPortCacheParaTeste()
  resetGatewayConfigCacheParaTeste()
  envFake.PAYMENT_SECRETS_KEY = CHAVE_A
  resetPaymentSecretsKeyCacheParaTeste()
  prismaFake.paymentGatewayConfig.findUnique.mockReset()
  prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(null) // sem linha: vale o env (comportamento anterior à F5.5)
  envFake.NODE_ENV = 'production'
  envFake.CIELO_MERCHANT_ID = undefined
  envFake.CIELO_MERCHANT_KEY = undefined
  envFake.CIELO_SANDBOX = true
  envFake.PAYMENT_ALLOW_FAKE_ADAPTER = false
  delete process.env.CIELO_API_BASE_URL
  delete process.env.CIELO_API_QUERY_BASE_URL
})

describe('getPagamentoPort — produção nunca cai no simulador sem querer (env, sem linha no banco)', () => {
  it('PRODUÇÃO sem credencial: lança GatewayPagamentoNaoConfiguradoError (as rotas viram 503) e NÃO devolve o Fake', async () => {
    await expect(getPagamentoPort()).rejects.toThrow(GatewayPagamentoNaoConfiguradoError)
    expect(isUsandoFakeAdapter()).toBe(false)
    expect(await isPagamentoDisponivel()).toBe(false)
  })

  it('o bloqueio NÃO é cacheado: configurar a credencial depois destrava', async () => {
    await expect(getPagamentoPort()).rejects.toThrow(GatewayPagamentoNaoConfiguradoError)
    envFake.CIELO_MERCHANT_ID = 'merchant-id-teste'
    envFake.CIELO_MERCHANT_KEY = 'merchant-key-teste'
    expect(await getPagamentoPort()).not.toBeInstanceOf(FakeAdapter)
    expect(isUsandoFakeAdapter()).toBe(false)
  })

  it('PRODUÇÃO com opt-in explícito: devolve o Fake (e marca como Fake)', async () => {
    envFake.PAYMENT_ALLOW_FAKE_ADAPTER = true
    expect(await getPagamentoPort()).toBeInstanceOf(FakeAdapter)
    expect(isUsandoFakeAdapter()).toBe(true)
    expect(await isPagamentoDisponivel()).toBe(true)
  })

  it('desenvolvimento sem credencial: Fake, como sempre (demo/CI/testes seguem funcionando) — e é o MESMO singleton entre chamadas', async () => {
    envFake.NODE_ENV = 'development'
    const a = await getPagamentoPort()
    expect(a).toBeInstanceOf(FakeAdapter)
    expect(await getPagamentoPort()).toBe(a)
    expect(await isPagamentoDisponivel()).toBe(true)
  })

  it('credencial presente em produção: adaptador Cielo, nunca o Fake, mesmo com o opt-in ligado', async () => {
    envFake.CIELO_MERCHANT_ID = 'merchant-id-teste'
    envFake.CIELO_MERCHANT_KEY = 'merchant-key-teste'
    envFake.PAYMENT_ALLOW_FAKE_ADAPTER = true
    expect(await getPagamentoPort()).not.toBeInstanceOf(FakeAdapter)
    expect(isUsandoFakeAdapter()).toBe(false)
  })
})

describe('getPagamentoPort — config do BANCO (F5.5): não reabre o furo do Fake em produção', () => {
  it('credencial vinda SÓ do banco (env vazio) em produção conta como "tem credencial": adaptador Cielo, não bloqueia nem cai no Fake', async () => {
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(linhaBanco({ merchantId: 'mid-banco', merchantKeyCiphertext: encryptPaymentSecret('chave-banco') }))
    const port = await getPagamentoPort()
    expect(port).toBeInstanceOf(CieloAdapter)
    expect(isUsandoFakeAdapter()).toBe(false)
    expect(await isPagamentoDisponivel()).toBe(true)
  })

  it('FAIL-CLOSED: falha ao LER o banco => ConfiguracaoGatewayIndisponivelError em produção e em dev; NUNCA o Fake', async () => {
    prismaFake.paymentGatewayConfig.findUnique.mockRejectedValue(new Error('connection refused'))
    await expect(getPagamentoPort()).rejects.toThrow(ConfiguracaoGatewayIndisponivelError)
    envFake.NODE_ENV = 'development' // até em dev: erro de leitura não vira simulador silencioso
    await expect(getPagamentoPort()).rejects.toThrow(ConfiguracaoGatewayIndisponivelError)
    expect(isUsandoFakeAdapter()).toBe(false)
    expect(await isPagamentoDisponivel()).toBe(false)
  })

  it('FAIL-CLOSED: segredo do banco que NÃO decifra (chave trocada) => ConfiguracaoGatewayIndisponivelError, mesmo com credencial no env e opt-in do Fake ligado', async () => {
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(linhaBanco({ merchantId: 'mid-banco', merchantKeyCiphertext: encryptPaymentSecret('chave-banco') }))
    envFake.PAYMENT_SECRETS_KEY = CHAVE_B // outra chave de 32 bytes
    resetPaymentSecretsKeyCacheParaTeste()
    envFake.CIELO_MERCHANT_ID = 'mid-env'
    envFake.CIELO_MERCHANT_KEY = 'chave-env'
    envFake.PAYMENT_ALLOW_FAKE_ADAPTER = true
    await expect(getPagamentoPort()).rejects.toThrow(ConfiguracaoGatewayIndisponivelError)
    expect(isUsandoFakeAdapter()).toBe(false)
  })

  it('banco manda: a credencial do banco é a usada (merchantId do banco no adaptador), mesmo com outra no env', async () => {
    envFake.CIELO_MERCHANT_ID = 'mid-env'
    envFake.CIELO_MERCHANT_KEY = 'chave-env'
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(linhaBanco({ merchantId: 'mid-banco', merchantKeyCiphertext: encryptPaymentSecret('chave-banco') }))
    const port = (await getPagamentoPort()) as unknown as CieloInterno
    expect(port.config.merchantId).toBe('mid-banco')
  })

  it('credencial trocada passa a valer: depois de invalidar o cache, o adaptador é RECONSTRUÍDO com o merchantId novo', async () => {
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(linhaBanco({ merchantId: 'mid-A', merchantKeyCiphertext: encryptPaymentSecret('chave-A'), updatedAt: new Date(1000) }))
    expect(((await getPagamentoPort()) as unknown as CieloInterno).config.merchantId).toBe('mid-A')
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(linhaBanco({ merchantId: 'mid-B', merchantKeyCiphertext: encryptPaymentSecret('chave-B'), updatedAt: new Date(2000) }))
    invalidarCacheConfigGateway()
    expect(((await getPagamentoPort()) as unknown as CieloInterno).config.merchantId).toBe('mid-B')
  })

  it('dentro do TTL o banco NÃO é consultado de novo (cache) — e só 1 leitura mesmo com chamadas concorrentes', async () => {
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(linhaBanco({ merchantId: 'mid-A', merchantKeyCiphertext: encryptPaymentSecret('chave-A') }))
    await Promise.all([getPagamentoPort(), getPagamentoPort(), getPagamentoPort()])
    await getPagamentoPort()
    expect(prismaFake.paymentGatewayConfig.findUnique).toHaveBeenCalledTimes(1)
  })

  it('o ambiente do BANCO decide o flag sandbox do adaptador (production no banco => sandbox=false)', async () => {
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(linhaBanco({ environment: 'production', merchantId: 'm', merchantKeyCiphertext: encryptPaymentSecret('k') }))
    expect(((await getPagamentoPort()) as unknown as CieloInterno).config.sandbox).toBe(false)
  })

  it('production no banco + CIELO_API_BASE_URL EXPLÍCITA de sandbox no servidor => recusa construir (nunca "production" com URLs de sandbox em silêncio)', async () => {
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(linhaBanco({ environment: 'production', merchantId: 'm', merchantKeyCiphertext: encryptPaymentSecret('k') }))
    process.env.CIELO_API_BASE_URL = 'https://apisandbox.cieloecommerce.cielo.com.br'
    await expect(getPagamentoPort()).rejects.toThrow(ConfiguracaoGatewayIncoerenteError)
  })

  it('sandbox no banco + URL EXPLÍCITA do host de PRODUÇÃO => recusa (cobraria de verdade achando que é teste)', async () => {
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(linhaBanco({ environment: 'sandbox', merchantId: 'm', merchantKeyCiphertext: encryptPaymentSecret('k') }))
    process.env.CIELO_API_QUERY_BASE_URL = 'https://apiquery.cieloecommerce.cielo.com.br'
    await expect(getPagamentoPort()).rejects.toThrow(ConfiguracaoGatewayIncoerenteError)
  })
})
