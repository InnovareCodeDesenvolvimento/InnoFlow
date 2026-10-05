import { beforeEach, describe, expect, it, vi } from 'vitest'

// env, logger e prisma MOCKADOS (mesma técnica de `pagamentoPortInstance.test.ts`): variamos credenciais/URLs/ambiente por teste, sem Postgres.
const envFake = vi.hoisted(() => ({
  NODE_ENV: 'production' as 'development' | 'test' | 'production',
  LOG_LEVEL: 'silent',
  CIELO_MERCHANT_ID: 'merchant-id-teste' as string | undefined,
  CIELO_MERCHANT_KEY: 'merchant-key-teste' as string | undefined,
  CIELO_API_BASE_URL: 'https://api.cieloecommerce.cielo.com.br',
  CIELO_API_QUERY_BASE_URL: 'https://apiquery.cieloecommerce.cielo.com.br',
  CIELO_SANDBOX: false,
  CIELO_TIMEOUT_MS: 8000,
  CIELO_SOP_SCRIPT_URL: undefined as string | undefined,
  CIELO_SOP_CLIENT_ID: 'sop-id' as string | undefined,
  CIELO_SOP_CLIENT_SECRET: 'sop-secret-teste' as string | undefined,
  CIELO_SOP_OAUTH_TOKEN_URL: undefined as string | undefined,
  CIELO_SOP_ACCESS_TOKEN_URL: undefined as string | undefined,
  CIELO_WEBHOOK_PATH_TOKEN: undefined as string | undefined,
  CIELO_WEBHOOK_HEADER_SECRET: undefined as string | undefined,
  PAYMENT_SECRETS_KEY: 'N9kxeAXn4BnqUUoF1v+dbfdbLGJLH0WPqIdGIqbbK28=' as string | undefined,
  PAYMENT_ALLOW_FAKE_ADAPTER: false,
}))
vi.mock('../../src/lib/env', () => ({ env: envFake }))
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const prismaFake = vi.hoisted(() => ({ paymentGatewayConfig: { findUnique: vi.fn() } }))
vi.mock('../../src/lib/prisma', () => ({ prisma: prismaFake }))

import {
  DOMINIOS_CIELO_PERMITIDOS_EM_PRODUCAO,
  URLS_CIELO,
  URLS_SOP,
  hostEhDominioCieloPermitido,
  hostEhLoopback,
  verificarCoerenciaUrls,
  verificarCoerenciaUrlsSop,
} from '../../src/core/pagamentos/configGateway'
import { getPagamentoPort, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPaymentSecretsKeyCacheParaTeste } from '../../src/lib/crypto/paymentSecrets'
import { ConfiguracaoGatewayIncoerenteError } from '../../src/core/pagamentos/erros'
import { CieloAdapter } from '../../src/services/pagamentos/cieloAdapter'

/**
 * S-3 (auditoria Cielo, fechado em 05/10/2026): em PRODUÇÃO, toda URL do gateway (API de vendas + 3 do SOP) precisa estar na allowlist de domínios Cielo/Braspag
 * (https, 443, sem credencial na URL); a única exceção é loopback (suíte de integração com Cielo falsa). Em SANDBOX o override segue livre.
 */

const SOP_PROD = URLS_SOP.production
const API_PROD = URLS_CIELO.production

describe('allowlist de domínios (puro)', () => {
  it('os DEFAULTS de produção e de sandbox (API + SOP) passam — a allowlist nunca pode bloquear os hosts reais já usados', () => {
    expect(verificarCoerenciaUrls('production', API_PROD, SOP_PROD)).toBeNull()
    expect(verificarCoerenciaUrls('sandbox', URLS_CIELO.sandbox, URLS_SOP.sandbox)).toBeNull()
    for (const url of [API_PROD.api, API_PROD.query, SOP_PROD.oauthToken, SOP_PROD.accessToken, SOP_PROD.script]) {
      expect(hostEhDominioCieloPermitido(new URL(url).hostname), url).toBe(true)
    }
  })

  it('a URL canônica que a doc oficial cita para o script (www.pagador.com.br) e as variações de subdomínio da Cielo passam como override em produção', () => {
    expect(verificarCoerenciaUrlsSop('production', { ...SOP_PROD, script: 'https://www.pagador.com.br/post/scripts/silentorderpost-1.0.min.js' })).toBeNull()
    expect(verificarCoerenciaUrls('production', { api: 'https://api.cieloecommerce.cielo.com.br/', query: 'https://apiquery.cieloecommerce.cielo.com.br:443' })).toBeNull()
  })

  it.each([
    ['host qualquer', 'https://cielo.exemplo.com'],
    ['sufixo sem fronteira de rótulo (evilpagador.com.br)', 'https://evilpagador.com.br/x'],
    ['domínio Cielo como SUBdomínio de outro (pagador.com.br.evil.com)', 'https://pagador.com.br.evil.com/x'],
    ['domínio Cielo no caminho, host diferente', 'https://evil.com/api.cieloecommerce.cielo.com.br'],
    ['userinfo disfarçando o host', 'https://api.cieloecommerce.cielo.com.br@evil.com/x'],
    ['userinfo mesmo com host legítimo', 'https://user:pass@api.cieloecommerce.cielo.com.br/x'],
    ['http (sem TLS) num host legítimo', 'http://api.cieloecommerce.cielo.com.br'],
    ['porta não padrão num host legítimo', 'https://api.cieloecommerce.cielo.com.br:8443'],
    ['IP público', 'https://203.0.113.10'],
    ['metadata de nuvem', 'http://169.254.169.254/latest/meta-data'],
    ['0.0.0.0 (não é loopback)', 'http://0.0.0.0:3000'],
    ['localhost.evil.com (não é loopback)', 'http://localhost.evil.com'],
    ['hostname com ponto final (fail-closed)', 'https://api.cieloecommerce.cielo.com.br./'],
    ['esquema estranho', 'ftp://api.cieloecommerce.cielo.com.br'],
  ])('PRODUÇÃO recusa: %s', (_nome, url) => {
    for (const campo of ['api', 'query'] as const) {
      expect(verificarCoerenciaUrls('production', { ...API_PROD, [campo]: url }), `${campo}: ${url}`).toMatch(/production/)
    }
    for (const campo of ['oauthToken', 'accessToken', 'script'] as const) {
      expect(verificarCoerenciaUrlsSop('production', { ...SOP_PROD, [campo]: url }), `${campo}: ${url}`).toMatch(/production/)
    }
  })

  it('a mensagem de recusa nomeia a variável e o host, e NUNCA a URL completa/credencial', () => {
    const msg = verificarCoerenciaUrls('production', { ...API_PROD, api: 'https://usuario:SENHA-SECRETA@evil.example/caminho?token=SEGREDO' }) ?? ''
    expect(msg).toContain('CIELO_API_BASE_URL')
    expect(msg).not.toContain('SENHA-SECRETA')
    expect(msg).not.toContain('SEGREDO')
    const msg2 = verificarCoerenciaUrlsSop('production', { ...SOP_PROD, oauthToken: 'https://evil.example/oauth2/token?x=SEGREDO' }) ?? ''
    expect(msg2).toContain('CIELO_SOP_OAUTH_TOKEN_URL')
    expect(msg2).toContain('evil.example')
    expect(msg2).not.toContain('SEGREDO')
  })

  it('LOOPBACK (Cielo falsa da suíte) é a única exceção: localhost, 127.x.x.x e [::1], qualquer porta/esquema — e só eles', () => {
    for (const url of ['http://127.0.0.1:4000', 'http://localhost:9999', 'https://127.1.2.3', 'http://[::1]:8080']) {
      expect(hostEhLoopback(new URL(url).hostname), url).toBe(true)
      expect(verificarCoerenciaUrls('production', { api: url, query: url }, { oauthToken: url, accessToken: url, script: url }), url).toBeNull()
    }
    for (const h of ['0.0.0.0', 'localhost.evil.com', '169.254.169.254', '10.0.0.1', '128.0.0.1', '127.0.0', 'evil.com']) expect(hostEhLoopback(h), h).toBe(false)
  })

  it('SANDBOX: override livre (servidor falso/proxy), mas continua recusando o host oficial de PRODUÇÃO — agora também o do SOP', () => {
    expect(verificarCoerenciaUrls('sandbox', { api: 'https://proxy.interno/cielo', query: 'http://localhost:1' }, { oauthToken: 'https://proxy.interno/o', accessToken: 'http://127.0.0.1:2', script: 'https://sop.example/s.js' })).toBeNull()
    expect(verificarCoerenciaUrls('sandbox', URLS_CIELO.sandbox, { ...URLS_SOP.sandbox, oauthToken: SOP_PROD.oauthToken })).toMatch(/sandbox.*PRODU/)
    expect(verificarCoerenciaUrlsSop('sandbox', { ...URLS_SOP.sandbox, accessToken: SOP_PROD.accessToken })).toMatch(/CIELO_SOP_ACCESS_TOKEN_URL/)
  })

  it('PRODUÇÃO continua recusando host de sandbox (regra anterior preservada, agora também no SOP)', () => {
    expect(verificarCoerenciaUrls('production', API_PROD, URLS_SOP.sandbox)).toMatch(/sandbox/)
  })

  it('URL inválida segue acusada (API e SOP) e a allowlist está documentada com os 3 domínios', () => {
    expect(verificarCoerenciaUrlsSop('production', { ...SOP_PROD, script: 'não é url' })).toMatch(/URL válida/)
    expect([...DOMINIOS_CIELO_PERMITIDOS_EM_PRODUCAO].sort()).toEqual(['braspag.com.br', 'cieloecommerce.cielo.com.br', 'pagador.com.br'])
  })
})

describe('getPagamentoPort — a allowlist vale na construção do adaptador (fail-closed)', () => {
  beforeEach(() => {
    resetPagamentoPortCacheParaTeste()
    resetGatewayConfigCacheParaTeste()
    resetPaymentSecretsKeyCacheParaTeste()
    prismaFake.paymentGatewayConfig.findUnique.mockReset()
    prismaFake.paymentGatewayConfig.findUnique.mockResolvedValue(null) // sem linha: vale o env
    envFake.NODE_ENV = 'production'
    envFake.CIELO_SANDBOX = false
    envFake.CIELO_SOP_OAUTH_TOKEN_URL = undefined
    envFake.CIELO_SOP_ACCESS_TOKEN_URL = undefined
    envFake.CIELO_SOP_SCRIPT_URL = undefined
    delete process.env.CIELO_API_BASE_URL
    delete process.env.CIELO_API_QUERY_BASE_URL
  })

  it('produção com os defaults (nenhum override): adaptador Cielo', async () => {
    expect(await getPagamentoPort()).toBeInstanceOf(CieloAdapter)
  })

  it.each([
    ['CIELO_SOP_OAUTH_TOKEN_URL', 'CIELO_SOP_OAUTH_TOKEN_URL', 'https://auth.exemplo-malicioso.com/oauth2/token'],
    ['CIELO_SOP_ACCESS_TOKEN_URL', 'CIELO_SOP_ACCESS_TOKEN_URL', 'https://exemplo-malicioso.com/accesstoken'],
    ['CIELO_SOP_SCRIPT_URL', 'CIELO_SOP_SCRIPT_URL', 'https://exemplo-malicioso.com/script.js'],
  ] as const)('produção com %s fora da allowlist: RECUSA construir o adaptador (ConfiguracaoGatewayIncoerenteError => 503 nas rotas)', async (_n, chave, valor) => {
    envFake[chave] = valor
    await expect(getPagamentoPort()).rejects.toThrow(ConfiguracaoGatewayIncoerenteError)
  })

  it('produção com CIELO_API_BASE_URL fora da allowlist: RECUSA (a MerchantKey não vai a esse host)', async () => {
    process.env.CIELO_API_BASE_URL = 'https://cielo.exemplo-malicioso.com'
    await expect(getPagamentoPort()).rejects.toThrow(ConfiguracaoGatewayIncoerenteError)
  })

  it('produção com override DENTRO da allowlist (nova URL canônica do script): constrói normalmente', async () => {
    envFake.CIELO_SOP_SCRIPT_URL = 'https://www.pagador.com.br/post/scripts/silentorderpost-1.0.min.js'
    expect(await getPagamentoPort()).toBeInstanceOf(CieloAdapter)
  })

  it('sandbox com override livre (mock/proxy): constrói — o comportamento de sandbox não mudou', async () => {
    envFake.CIELO_SANDBOX = true
    envFake.CIELO_SOP_OAUTH_TOKEN_URL = 'http://127.0.0.1:9/oauth2/token'
    envFake.CIELO_SOP_SCRIPT_URL = 'https://sop.example/script.js'
    process.env.CIELO_API_BASE_URL = 'http://localhost:9'
    process.env.CIELO_API_QUERY_BASE_URL = 'http://localhost:9'
    expect(await getPagamentoPort()).toBeInstanceOf(CieloAdapter)
  })
})
