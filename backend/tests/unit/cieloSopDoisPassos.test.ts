import { afterEach, describe, expect, it, vi } from 'vitest'
import { URLS_SOP, resolverUrlsSop } from '../../src/core/pagamentos/configGateway'
import { CieloSopOAuthError, emitirAccessTokenSop, type CieloSopConfig } from '../../src/services/pagamentos/cieloSopOAuth'
import { criarCieloAdapterFromEnv } from '../../src/services/pagamentos/cieloAdapter'
import { logger } from '../../src/lib/logger'

/**
 * C1.1 — SOP em DOIS passos. ORÁCULO: os valores literais abaixo foram copiados do código que roda em produção no Parque das Feiras
 * (`ParquedasFeiras/backend/src/lib/pagamentos/adaptadores/cielo/sop.ts` — hosts do OAuth e do accesstoken, formato das duas requisições —
 * e `frontend/src/lib/cieloSop.ts` — URL do script). Nenhuma chamada foi feita à Cielo: o `fetch` é sempre injetado.
 */

const json = (status: number, corpo: unknown): Response => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } })

describe('URLs do SOP por ambiente (valores EXATOS do Parque)', () => {
  it('sandbox', () => {
    expect(URLS_SOP.sandbox).toEqual({
      oauthToken: 'https://authsandbox.braspag.com.br/oauth2/token',
      accessToken: 'https://transactionsandbox.pagador.com.br/post/api/public/v2/accesstoken',
      script: 'https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js',
    })
  })

  it('produção — o script mora em OUTRO host (cieloecommerce) que o accesstoken (pagador)', () => {
    expect(URLS_SOP.production).toEqual({
      oauthToken: 'https://auth.braspag.com.br/oauth2/token',
      accessToken: 'https://transaction.pagador.com.br/post/api/public/v2/accesstoken',
      script: 'https://transaction.cieloecommerce.cielo.com.br/post/scripts/silentorderpost-1.0.min.js',
    })
  })

  it('sem override devolve o default do ambiente; as 3 envs CIELO_SOP_*_URL são override opcional', () => {
    expect(resolverUrlsSop('production')).toEqual(URLS_SOP.production)
    expect(resolverUrlsSop('sandbox', { oauthToken: '  ', script: '' })).toEqual(URLS_SOP.sandbox)
    expect(resolverUrlsSop('sandbox', { oauthToken: ' https://mock.local/oauth ', script: 'https://mock.local/sop.js' })).toEqual({
      oauthToken: 'https://mock.local/oauth',
      accessToken: URLS_SOP.sandbox.accessToken, // sem override do accesstoken, vale o default do ambiente
      script: 'https://mock.local/sop.js',
    })
    expect(resolverUrlsSop('production', { accessToken: 'https://mock.local/accesstoken' }).accessToken).toBe('https://mock.local/accesstoken')
  })
})

interface Chamada {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
}

function sopComFetch(respostas: Array<Response | Error>, over: Partial<CieloSopConfig> = {}): { config: CieloSopConfig; chamadas: Chamada[] } {
  const chamadas: Chamada[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    chamadas.push({ url: String(url), method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined })
    const r = respostas.shift()
    if (r === undefined) throw new Error('fetch inesperado')
    if (r instanceof Error) throw r
    return r
  }) as typeof fetch
  return {
    chamadas,
    config: {
      clientId: 'client-id-x',
      clientSecret: 'client-secret-y',
      merchantId: '11111111-2222-3333-4444-555555555555',
      oauthTokenUrl: URLS_SOP.production.oauthToken,
      accessTokenUrl: URLS_SOP.production.accessToken,
      timeoutMs: 200,
      fetchImpl,
      ...over,
    },
  }
}

describe('emitirAccessTokenSop — formato das duas requisições (oráculo: Parque)', () => {
  it('passo 1: POST no OAuth, Basic base64(ClientId:ClientSecret), form-urlencoded, SEM scope; passo 2: Bearer do passo 1, header MerchantId e corpo {MerchantId}', async () => {
    const { config, chamadas } = sopComFetch([json(200, { access_token: 'oauth-token-123', expires_in: 599 }), json(200, { AccessToken: 'sop-access-token-456', ExpiresIn: 1200 })])
    const r = await emitirAccessTokenSop(config)

    expect(chamadas).toHaveLength(2)
    const [p1, p2] = chamadas
    expect(p1.url).toBe('https://auth.braspag.com.br/oauth2/token')
    expect(p1.method).toBe('POST')
    expect(p1.headers.Authorization).toBe(`Basic ${Buffer.from('client-id-x:client-secret-y').toString('base64')}`)
    expect(p1.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(p1.body).toBe('grant_type=client_credentials') // exatamente: sem scope, sem JSON

    expect(p2.url).toBe('https://transaction.pagador.com.br/post/api/public/v2/accesstoken')
    expect(p2.method).toBe('POST')
    expect(p2.headers.Authorization).toBe('Bearer oauth-token-123')
    expect(p2.headers['Content-Type']).toBe('application/json')
    expect(p2.headers.MerchantId).toBe('11111111-2222-3333-4444-555555555555')
    expect(JSON.parse(p2.body!)).toEqual({ MerchantId: '11111111-2222-3333-4444-555555555555' })

    // O que vai ao navegador é o AccessToken do passo 2, não o token OAuth.
    expect(r.accessToken).toBe('sop-access-token-456')
    expect(r.expiresInSeconds).toBe(1170) // ExpiresIn 1200 - 30 s de folga
  })

  it('validade: ExpiresIn pequeno vira no mínimo 30 s; ausente assume 540 s (o mesmo do Parque); aceita accessToken em camelCase', async () => {
    const a = await emitirAccessTokenSop(sopComFetch([json(200, { access_token: 't' }), json(200, { AccessToken: 'x', ExpiresIn: 40 })]).config)
    expect(a.expiresInSeconds).toBe(30)
    const b = await emitirAccessTokenSop(sopComFetch([json(200, { access_token: 't' }), json(200, { accessToken: 'y' })]).config)
    expect(b).toEqual({ accessToken: 'y', expiresInSeconds: 540 })
  })
})

describe('emitirAccessTokenSop — classificação dos erros (medida pelo Parque em 02/09/2026)', () => {
  async function falha(respostas: Array<Response | Error>, over: Partial<CieloSopConfig> = {}): Promise<CieloSopOAuthError> {
    try {
      await emitirAccessTokenSop(sopComFetch(respostas, over).config)
    } catch (err) {
      expect(err).toBeInstanceOf(CieloSopOAuthError)
      return err as CieloSopOAuthError
    }
    throw new Error('devia ter lançado')
  }

  it('OAuth 400 com error=invalid_client é CREDENCIAL (não 401/403), no passo oauth', async () => {
    const e = await falha([json(400, { error: 'invalid_client', error_description: 'Client authentication failed' })])
    expect(e).toMatchObject({ kind: 'credencial_invalida', passo: 'oauth', httpStatus: 400 })
    expect(e.message).toContain('invalid_client')
    expect(e.message).toMatch(/AMBIENTE|ambiente/) // sandbox x produção: a mesma recusa de uma credencial errada
  })

  it('OAuth 401 e 403 também são credencial', async () => {
    expect((await falha([json(401, {})])).kind).toBe('credencial_invalida')
    expect((await falha([json(403, {})])).kind).toBe('credencial_invalida')
  })

  it('OAuth 400 com OUTRO error (unsupported_grant_type, invalid_request) é defeito NOSSO — não manda o admin trocar credencial', async () => {
    for (const error of ['unsupported_grant_type', 'invalid_request']) {
      const e = await falha([json(400, { error })])
      expect(e).toMatchObject({ kind: 'indisponivel', passo: 'oauth', httpStatus: 400 })
    }
    expect((await falha([json(503, {})])).kind).toBe('indisponivel')
  })

  it('OAuth sem access_token -> indisponível', async () => {
    expect(await falha([json(200, { token_type: 'bearer' })])).toMatchObject({ kind: 'indisponivel', passo: 'oauth' })
  })

  it('passo 2: 401 puro (sem corpo) é credencial; 500 é indisponível e a mensagem aponta MerchantId/ClientId de lojistas diferentes; sem AccessToken é indisponível', async () => {
    const oauth = () => json(200, { access_token: 't' })
    expect(await falha([oauth(), new Response(null, { status: 401 })])).toMatchObject({ kind: 'credencial_invalida', passo: 'accesstoken', httpStatus: 401 })
    const e500 = await falha([oauth(), json(500, {})])
    expect(e500).toMatchObject({ kind: 'indisponivel', passo: 'accesstoken', httpStatus: 500 })
    expect(e500.message).toMatch(/lojistas|cadastros/)
    expect(await falha([oauth(), json(200, { ExpiresIn: 100 })])).toMatchObject({ kind: 'indisponivel', passo: 'accesstoken' })
  })

  it('queda de rede e timeout viram indisponível, no passo certo', async () => {
    expect(await falha([new TypeError('fetch failed')])).toMatchObject({ kind: 'indisponivel', passo: 'oauth' })
    const e = await falha([json(200, { access_token: 't' }), Object.assign(new Error('aborted'), { name: 'AbortError' })])
    expect(e).toMatchObject({ kind: 'indisponivel', passo: 'accesstoken' })
    expect(e.message).toMatch(/não respondeu/)
  })

  it('ClientId/ClientSecret vazios falham ANTES de qualquer rede', async () => {
    const { config, chamadas } = sopComFetch([], { clientSecret: '' })
    await expect(emitirAccessTokenSop(config)).rejects.toMatchObject({ kind: 'credencial_invalida' })
    expect(chamadas).toHaveLength(0)
  })
})

describe('emitirAccessTokenSop — nada sensível no log nem na mensagem', () => {
  afterEach(() => vi.restoreAllMocks())

  it('nem o ClientSecret, nem o access_token OAuth, nem o AccessToken, nem o corpo de erro (que pode ecoar a credencial) aparecem em log ou mensagem de erro', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const error = vi.spyOn(logger, 'error')
    const info = vi.spyOn(logger, 'info')
    const SEG = ['client-secret-y', 'oauth-token-ULTRA', 'ACCESS-TOKEN-ULTRA', 'ECO-DA-CREDENCIAL']

    // falha no passo 1 com corpo que ecoa a credencial
    const e1 = await emitirAccessTokenSop(sopComFetch([json(400, { error: 'invalid_client', error_description: 'ECO-DA-CREDENCIAL client-secret-y' })]).config).catch((e) => e as Error)
    // falha no passo 2 depois de um OAuth bem-sucedido
    const e2 = await emitirAccessTokenSop(sopComFetch([json(200, { access_token: 'oauth-token-ULTRA' }), json(500, { raw: 'ECO-DA-CREDENCIAL' })]).config).catch((e) => e as Error)
    // sucesso
    await emitirAccessTokenSop(sopComFetch([json(200, { access_token: 'oauth-token-ULTRA' }), json(200, { AccessToken: 'ACCESS-TOKEN-ULTRA', ExpiresIn: 600 })]).config)

    const tudo = JSON.stringify([warn.mock.calls, error.mock.calls, info.mock.calls, (e1 as Error).message, (e2 as Error).message])
    for (const segredo of SEG) expect(tudo).not.toContain(segredo)
    expect(warn).toHaveBeenCalled() // o controle positivo: houve log, e ele é só de status/passo
  })
})

describe('criarCieloAdapterFromEnv — as URLs reais por ambiente chegam ao fetch (sem nenhuma env CIELO_SOP_*_URL)', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function sessaoDo(sandbox: boolean, extra: Record<string, string> = {}) {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      (async (url: string) => {
        urls.push(String(url))
        return String(url).includes('oauth2') ? json(200, { access_token: 't' }) : json(200, { AccessToken: 'a', ExpiresIn: 600 })
      }) as typeof fetch,
    )
    const adapter = criarCieloAdapterFromEnv({
      CIELO_MERCHANT_ID: 'mid',
      CIELO_MERCHANT_KEY: 'mkey',
      CIELO_API_BASE_URL: 'https://api.example.test',
      CIELO_API_QUERY_BASE_URL: 'https://apiquery.example.test',
      CIELO_TIMEOUT_MS: 1000,
      CIELO_SANDBOX: sandbox,
      CIELO_SOP_CLIENT_ID: 'cid',
      CIELO_SOP_CLIENT_SECRET: 'csecret',
      ...extra,
    })
    return { sessao: await adapter.sessaoTokenizacao(), urls }
  }

  it('sandbox: hosts e script de sandbox', async () => {
    const { sessao, urls } = await sessaoDo(true)
    expect(urls).toEqual([URLS_SOP.sandbox.oauthToken, URLS_SOP.sandbox.accessToken])
    expect(sessao).toMatchObject({ scriptUrl: 'https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js', environment: 'sandbox', merchantId: 'mid', accessToken: 'a' })
  })

  it('produção: hosts e script de produção', async () => {
    const { sessao, urls } = await sessaoDo(false)
    expect(urls).toEqual(['https://auth.braspag.com.br/oauth2/token', 'https://transaction.pagador.com.br/post/api/public/v2/accesstoken'])
    expect(sessao).toMatchObject({ scriptUrl: 'https://transaction.cieloecommerce.cielo.com.br/post/scripts/silentorderpost-1.0.min.js', environment: 'production' })
  })

  it('override por env continua valendo (reserva)', async () => {
    const { sessao, urls } = await sessaoDo(true, { CIELO_SOP_OAUTH_TOKEN_URL: 'https://mock.local/oauth2/token', CIELO_SOP_SCRIPT_URL: 'https://mock.local/sop.js' })
    expect(urls[0]).toBe('https://mock.local/oauth2/token')
    expect(sessao.scriptUrl).toBe('https://mock.local/sop.js')
  })
})
