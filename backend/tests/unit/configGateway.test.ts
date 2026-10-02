import { describe, expect, it } from 'vitest'
import {
  avaliarMudancaDeConfig,
  calcularReadiness,
  meioHabilitadoParaNovosPagamentos,
  montarWebhookUrl,
  resolverEstadoEfetivo,
  resolverUrlsCielo,
  temCredenciaisCielo,
  URLS_CIELO,
  verificarCoerenciaUrls,
  type EnvGateway,
  type LinhaConfigGateway,
} from '../../src/core/pagamentos/configGateway'

const ENV_VAZIO: EnvGateway = {
  sandbox: true,
  merchantId: null,
  temMerchantKey: false,
  sopClientId: null,
  temSopClientSecret: false,
  temWebhookHeaderSecret: false,
  sopScriptUrl: null,
  sopOauthTokenUrl: null,
  webhookPathToken: null,
  paymentSecretsKeyOk: true,
}

const ENV_COMPLETO: EnvGateway = {
  sandbox: true,
  merchantId: 'mid-env',
  temMerchantKey: true,
  sopClientId: 'sop-env',
  temSopClientSecret: true,
  temWebhookHeaderSecret: true,
  sopScriptUrl: 'https://sop.example/script.js',
  sopOauthTokenUrl: 'https://sop.example/token',
  webhookPathToken: 'token-do-caminho',
  paymentSecretsKeyOk: true,
}

function linha(over: Partial<LinhaConfigGateway> = {}): LinhaConfigGateway {
  return {
    environment: 'sandbox',
    merchantId: null,
    merchantKeyCiphertext: null,
    sopClientId: null,
    sopClientSecretCiphertext: null,
    webhookHeaderSecretCiphertext: null,
    cardEnabled: false,
    pixEnabled: false,
    updatedAt: new Date('2026-10-02T12:00:00Z'),
    ...over,
  }
}

describe('resolverEstadoEfetivo — banco manda, env é reserva', () => {
  it('sem linha: tudo vem do env, source "env", habilitado = há credenciais, updatedAt null', () => {
    const estado = resolverEstadoEfetivo(null, ENV_COMPLETO)
    expect(estado).toMatchObject({ source: 'env', environment: 'sandbox', merchantId: 'mid-env', temMerchantKey: true, cardEnabled: true, pixEnabled: true, updatedAt: null })
    expect(estado.origem).toEqual({ merchant: 'env', sop: 'env', webhookHeaderSecret: 'env' })
  })

  it('sem linha e CIELO_SANDBOX=false: ambiente efetivo é production', () => {
    expect(resolverEstadoEfetivo(null, { ...ENV_COMPLETO, sandbox: false }).environment).toBe('production')
  })

  it('sem linha e sem credencial: flags de exibição false (quem decide é o resolvedor do adaptador)', () => {
    const estado = resolverEstadoEfetivo(null, ENV_VAZIO)
    expect(estado.cardEnabled).toBe(false)
    expect(temCredenciaisCielo(estado)).toBe(false)
  })

  it('com linha: o ambiente e as flags são os do banco', () => {
    const estado = resolverEstadoEfetivo(linha({ environment: 'production', cardEnabled: true, pixEnabled: false }), ENV_COMPLETO)
    expect(estado).toMatchObject({ source: 'database', environment: 'production', cardEnabled: true, pixEnabled: false })
  })

  it('credencial do banco ganha do env (merchantId/chave do banco, par inteiro)', () => {
    const estado = resolverEstadoEfetivo(linha({ merchantId: 'mid-banco', merchantKeyCiphertext: 'cipher' }), ENV_COMPLETO)
    expect(estado.merchantId).toBe('mid-banco')
    expect(estado.origem.merchant).toBe('database')
  })

  it('o PAR de credencial nunca mistura: merchantId no banco SEM chave no banco NÃO herda a chave do env', () => {
    const estado = resolverEstadoEfetivo(linha({ merchantId: 'mid-banco' }), ENV_COMPLETO)
    expect(estado.merchantId).toBe('mid-banco')
    expect(estado.temMerchantKey).toBe(false)
    expect(temCredenciaisCielo(estado)).toBe(false)
  })

  it('linha sem nenhuma credencial: o par vem inteiro do env (salvar só uma flag não derruba o que funcionava pelo env)', () => {
    const estado = resolverEstadoEfetivo(linha({ cardEnabled: true }), ENV_COMPLETO)
    expect(estado.merchantId).toBe('mid-env')
    expect(estado.temMerchantKey).toBe(true)
    expect(estado.origem.merchant).toBe('env')
  })

  it('segredo do webhook: banco > env > nenhum', () => {
    expect(resolverEstadoEfetivo(linha({ webhookHeaderSecretCiphertext: 'c' }), ENV_COMPLETO).origem.webhookHeaderSecret).toBe('database')
    expect(resolverEstadoEfetivo(linha(), ENV_COMPLETO).origem.webhookHeaderSecret).toBe('env')
    const nenhum = resolverEstadoEfetivo(linha(), ENV_VAZIO)
    expect(nenhum.origem.webhookHeaderSecret).toBe('none')
    expect(nenhum.temWebhookHeaderSecret).toBe(false)
  })
})

describe('meioHabilitadoParaNovosPagamentos', () => {
  it('sem linha: habilitado (preserva o comportamento anterior; sem credencial quem decide é o resolvedor do adaptador)', () => {
    expect(meioHabilitadoParaNovosPagamentos(null, 'CARD')).toBe(true)
    expect(meioHabilitadoParaNovosPagamentos(null, 'PIX')).toBe(true)
  })
  it('com linha: respeita cada flag separadamente', () => {
    const l = linha({ cardEnabled: false, pixEnabled: true })
    expect(meioHabilitadoParaNovosPagamentos(l, 'CARD')).toBe(false)
    expect(meioHabilitadoParaNovosPagamentos(l, 'PIX')).toBe(true)
  })
})

describe('calcularReadiness', () => {
  it('env completo: os dois meios prontos', () => {
    const r = calcularReadiness(resolverEstadoEfetivo(null, ENV_COMPLETO), ENV_COMPLETO)
    expect(r.card).toEqual({ ready: true, missing: [] })
    expect(r.pix).toEqual({ ready: true, missing: [] })
  })

  it('tudo vazio: lista cada requisito, na ordem estável do contrato; PIX não exige PAYMENT_SECRETS_KEY se nada está cifrado no banco', () => {
    const r = calcularReadiness(resolverEstadoEfetivo(null, { ...ENV_VAZIO, paymentSecretsKeyOk: false }), { ...ENV_VAZIO, paymentSecretsKeyOk: false })
    expect(r.pix.missing).toEqual(['MERCHANT_ID', 'MERCHANT_KEY', 'WEBHOOK_PATH_TOKEN', 'WEBHOOK_HEADER_SECRET'])
    expect(r.card.missing).toEqual(['MERCHANT_ID', 'MERCHANT_KEY', 'SOP_CLIENT_ID', 'SOP_CLIENT_SECRET', 'SOP_SCRIPT_URL', 'SOP_OAUTH_TOKEN_URL', 'PAYMENT_SECRETS_KEY'])
  })

  it('PIX passa a exigir PAYMENT_SECRETS_KEY quando a chave Cielo (ou o segredo do webhook) está cifrada no banco', () => {
    const envSemChave = { ...ENV_COMPLETO, paymentSecretsKeyOk: false }
    const doBanco = resolverEstadoEfetivo(linha({ merchantId: 'm', merchantKeyCiphertext: 'c' }), envSemChave)
    expect(calcularReadiness(doBanco, envSemChave).pix.missing).toEqual(['PAYMENT_SECRETS_KEY'])
    const soWebhook = resolverEstadoEfetivo(linha({ webhookHeaderSecretCiphertext: 'c' }), envSemChave)
    expect(calcularReadiness(soWebhook, envSemChave).pix.missing).toEqual(['PAYMENT_SECRETS_KEY'])
  })

  it('CARD exige PAYMENT_SECRETS_KEY SEMPRE (o CardToken do motorista é cifrado em repouso), mesmo com tudo no env', () => {
    const envSemChave = { ...ENV_COMPLETO, paymentSecretsKeyOk: false }
    const r = calcularReadiness(resolverEstadoEfetivo(null, envSemChave), envSemChave)
    expect(r.card.missing).toEqual(['PAYMENT_SECRETS_KEY'])
    expect(r.pix.ready).toBe(true)
  })

  it('requisitos só de env do servidor (SOP_SCRIPT_URL, SOP_OAUTH_TOKEN_URL, WEBHOOK_PATH_TOKEN) contam como presentes se a env estiver setada', () => {
    const e = { ...ENV_VAZIO, sopScriptUrl: 'https://x/s.js', sopOauthTokenUrl: 'https://x/t', webhookPathToken: 'abcdefgh' }
    const estado = resolverEstadoEfetivo(linha({ merchantId: 'm', merchantKeyCiphertext: 'c', sopClientId: 's', sopClientSecretCiphertext: 'c2', webhookHeaderSecretCiphertext: 'c3' }), e)
    const r = calcularReadiness(estado, e)
    expect(r.card.ready).toBe(true)
    expect(r.pix.ready).toBe(true)
  })
})

describe('avaliarMudancaDeConfig', () => {
  function avaliar(antesLinha: LinhaConfigGateway | null, depoisLinha: LinhaConfigGateway, env: EnvGateway, confirmProduction = false) {
    const antes = resolverEstadoEfetivo(antesLinha, env)
    const depois = resolverEstadoEfetivo(depoisLinha, env)
    return avaliarMudancaDeConfig({ antes, depois, readinessAntes: calcularReadiness(antes, env), readinessDepois: calcularReadiness(depois, env), confirmProduction })
  }

  it('sandbox -> production sem confirmProduction: PRODUCTION_CONFIRMATION_REQUIRED (antes de qualquer outra checagem)', () => {
    const r = avaliar(linha(), linha({ environment: 'production' }), ENV_COMPLETO)
    expect(r).toEqual({ kind: 'PRODUCTION_CONFIRMATION_REQUIRED' })
  })

  it('sandbox -> production confirmado, com meio habilitado e NÃO pronto: GATEWAY_NOT_READY lista o que falta', () => {
    const r = avaliar(linha(), linha({ environment: 'production', pixEnabled: true }), ENV_VAZIO, true)
    expect(r).toEqual({ kind: 'GATEWAY_NOT_READY', missing: ['MERCHANT_ID', 'MERCHANT_KEY', 'WEBHOOK_PATH_TOKEN', 'WEBHOOK_HEADER_SECRET'] })
  })

  it('sandbox -> production confirmado e meios desligados: passa (nada habilitado para ficar pronto)', () => {
    expect(avaliar(linha(), linha({ environment: 'production' }), ENV_VAZIO, true)).toBeNull()
  })

  it('sandbox -> production confirmado com tudo pronto: passa', () => {
    expect(avaliar(linha(), linha({ environment: 'production', cardEnabled: true, pixEnabled: true }), ENV_COMPLETO, true)).toBeNull()
  })

  it('já era production: não pede confirmação de novo', () => {
    expect(avaliar(linha({ environment: 'production' }), linha({ environment: 'production', merchantId: 'm', merchantKeyCiphertext: 'c' }), ENV_COMPLETO)).toBeNull()
  })

  it('production -> sandbox nunca pede confirmação', () => {
    expect(avaliar(linha({ environment: 'production' }), linha({ environment: 'sandbox' }), ENV_COMPLETO)).toBeNull()
  })

  it('habilitar um meio sem pré-requisitos: GATEWAY_NOT_READY', () => {
    const r = avaliar(linha(), linha({ cardEnabled: true }), { ...ENV_VAZIO, sopScriptUrl: 'https://x/s.js' })
    expect(r?.kind).toBe('GATEWAY_NOT_READY')
    if (r?.kind === 'GATEWAY_NOT_READY') expect(r.missing).toContain('MERCHANT_ID')
  })

  it('habilitar um meio pronto: passa', () => {
    expect(avaliar(linha(), linha({ pixEnabled: true }), ENV_COMPLETO)).toBeNull()
  })

  it('desligar um meio quebrado sempre passa', () => {
    expect(avaliar(linha({ pixEnabled: true }), linha({ pixEnabled: false }), ENV_VAZIO)).toBeNull()
  })

  it('par de credencial pela metade (merchantId no banco, sem chave em lugar nenhum do banco) é recusado mesmo com os meios desligados', () => {
    const r = avaliar(linha(), linha({ merchantId: 'mid-novo' }), ENV_COMPLETO)
    expect(r).toEqual({ kind: 'GATEWAY_NOT_READY', missing: ['MERCHANT_KEY'] })
  })

  it('PIORAR um meio que estava pronto (trocar o merchantId sem reenviar a chave, par vindo do env) é recusado', () => {
    const r = avaliar(linha({ pixEnabled: true }), linha({ pixEnabled: true, merchantId: 'outro' }), ENV_COMPLETO)
    expect(r?.kind).toBe('GATEWAY_NOT_READY')
  })

  it('editar campo alheio de um meio que JÁ estava habilitado e incompleto não é bloqueado (só se bloqueia ligar/piorar)', () => {
    // pix habilitado e quebrado (sem token do webhook no servidor) desde antes; admin só ajusta o sopClientId
    const env = { ...ENV_COMPLETO, webhookPathToken: null }
    expect(avaliar(linha({ pixEnabled: true }), linha({ pixEnabled: true, sopClientId: 'novo-sop' }), env)).toBeNull()
  })

  it('...mas virar production com esse meio quebrado habilitado bloqueia (production exige o estado resultante pronto)', () => {
    const env = { ...ENV_COMPLETO, webhookPathToken: null }
    const r = avaliar(linha({ pixEnabled: true }), linha({ pixEnabled: true, environment: 'production' }), env, true)
    expect(r).toEqual({ kind: 'GATEWAY_NOT_READY', missing: ['WEBHOOK_PATH_TOKEN'] })
  })
})

describe('resolverUrlsCielo / verificarCoerenciaUrls', () => {
  it('sem URL explícita: deriva do ambiente (sandbox x produção)', () => {
    expect(resolverUrlsCielo('sandbox', {})).toMatchObject({ api: URLS_CIELO.sandbox.api, query: URLS_CIELO.sandbox.query, origem: { api: 'ambiente', query: 'ambiente' } })
    expect(resolverUrlsCielo('production', {})).toMatchObject({ api: URLS_CIELO.production.api, query: URLS_CIELO.production.query })
  })

  it('URL explícita do servidor ganha (e string vazia/espaços conta como não definida)', () => {
    const u = resolverUrlsCielo('production', { api: ' https://proxy.interno/cielo ', query: '   ' })
    expect(u.api).toBe('https://proxy.interno/cielo')
    expect(u.query).toBe(URLS_CIELO.production.query)
    expect(u.origem).toEqual({ api: 'explicita', query: 'ambiente' })
  })

  it('os hosts de produção NUNCA contêm "sandbox" e os de sandbox sempre contêm', () => {
    expect(URLS_CIELO.production.api).not.toMatch(/sandbox/)
    expect(URLS_CIELO.production.query).not.toMatch(/sandbox/)
    expect(URLS_CIELO.sandbox.api).toMatch(/sandbox/)
    expect(URLS_CIELO.sandbox.query).toMatch(/sandbox/)
  })

  it('coerente: derivadas passam; production com URL de sandbox e sandbox com host oficial de produção são acusadas', () => {
    expect(verificarCoerenciaUrls('sandbox', URLS_CIELO.sandbox)).toBeNull()
    expect(verificarCoerenciaUrls('production', URLS_CIELO.production)).toBeNull()
    expect(verificarCoerenciaUrls('production', URLS_CIELO.sandbox)).toMatch(/production.*sandbox/)
    expect(verificarCoerenciaUrls('sandbox', URLS_CIELO.production)).toMatch(/sandbox.*PRODU/)
  })

  it('host customizado (mock local/proxy) em sandbox passa; URL inválida é acusada', () => {
    expect(verificarCoerenciaUrls('sandbox', { api: 'http://localhost:9999', query: 'http://localhost:9999' })).toBeNull()
    expect(verificarCoerenciaUrls('sandbox', { api: 'não é url', query: URLS_CIELO.sandbox.query })).toMatch(/URL válida/)
  })
})

describe('montarWebhookUrl', () => {
  it('base + /api/webhooks/cielo/{token}, sem barra duplicada', () => {
    expect(montarWebhookUrl('https://api.exemplo.com.br/', 'tok-12345')).toBe('https://api.exemplo.com.br/api/webhooks/cielo/tok-12345')
  })
  it('sem token (ou sem base): null', () => {
    expect(montarWebhookUrl('https://api.exemplo.com.br', null)).toBeNull()
    expect(montarWebhookUrl(null, 'tok-12345')).toBeNull()
  })
})
