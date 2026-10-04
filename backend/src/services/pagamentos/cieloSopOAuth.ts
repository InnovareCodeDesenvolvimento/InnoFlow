import { logger } from '../../lib/logger'

/**
 * Silent Order Post (SOP): o `AccessToken` que o NAVEGADOR usa para tokenizar o cartão direto na Braspag/Cielo, sem passar por
 * este servidor (D1 do dono: SAQ A-EP). São DOIS passos do SERVIDOR — fluxo que roda em produção no Parque das Feiras
 * (`ParquedasFeiras/backend/src/lib/pagamentos/adaptadores/cielo/sop.ts`, fatos F7/F8 de `docs/GATEWAY-CIELO-PARQUE-VS-INNOFLOW.md`):
 *
 *   1. OAuth2 na Braspag: `POST {oauthTokenUrl}`, `Authorization: Basic base64(ClientId:ClientSecret)`, corpo
 *      `grant_type=client_credentials` em form-urlencoded, SEM `scope`. Devolve o `access_token` OAuth (~599 s).
 *   2. `POST {accessTokenUrl}` (`.../post/api/public/v2/accesstoken`) com `Authorization: Bearer <access_token do passo 1>`, o
 *      cabeçalho `MerchantId` e o corpo `{ "MerchantId": "..." }`. Devolve `AccessToken` (e `ExpiresIn`) — ESTE é o que vai ao
 *      navegador. Entregar o token do passo 1 (o que a F5.3 fazia) não funciona: o script do SOP não o aceita.
 *
 * As URLs vêm por ambiente (`core/pagamentos/configGateway.ts#resolverUrlsSop`); este módulo só recebe o que usar.
 *
 * Classificação do erro (medida pelo Parque em 02/09/2026):
 *  - passo 1 é OAuth2 padrão: credencial recusada volta HTTP 400 com `{"error":"invalid_client"}` (NÃO 401/403). Um 400 com OUTRO `error`
 *    (`unsupported_grant_type`, `invalid_request`...) é defeito NOSSO de requisição, não credencial do admin;
 *  - passo 2 com credencial ruim volta 401 puro, sem corpo; HTTP 500 costuma indicar MerchantId e ClientId de lojistas diferentes.
 *
 * NUNCA logar `clientSecret`, o `access_token` nem o `AccessToken`, nem o CORPO de erro (pode ecoar a credencial) — só status e o `error` OAuth.
 */

export interface CieloSopConfig {
  clientId: string
  clientSecret: string
  /** `MerchantId` da Cielo — vai no cabeçalho e no corpo do passo 2. */
  merchantId: string
  /** Passo 1 (OAuth2 na Braspag). */
  oauthTokenUrl: string
  /** Passo 2 (emite o AccessToken do navegador). */
  accessTokenUrl: string
  timeoutMs: number
  /** Injeção para teste — nunca bate na rede de verdade nos testes unitários. */
  fetchImpl?: typeof fetch
}

export interface CieloSopAccessToken {
  /** O `AccessToken` do passo 2 — o que o navegador usa. */
  accessToken: string
  /** Validade em segundos já com folga (errar para MENOS faz o frontend renovar cedo, que é barato). */
  expiresInSeconds: number
}

export type CieloSopErroKind = 'credencial_invalida' | 'indisponivel'
export type CieloSopPasso = 'oauth' | 'accesstoken'

export class CieloSopOAuthError extends Error {
  constructor(
    message: string,
    readonly kind: CieloSopErroKind,
    readonly passo: CieloSopPasso,
    readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'CieloSopOAuthError'
  }
}

/** Validade assumida quando a resposta não traz `ExpiresIn` (o Parque assume 540 s). */
const EXPIRACAO_PADRAO_SEGUNDOS = 540
const FOLGA_EXPIRACAO_SEGUNDOS = 30
const MINIMO_SEGUNDOS = 30

/** Passos 1 e 2. Devolve o `AccessToken` do navegador. */
export async function emitirAccessTokenSop(config: CieloSopConfig): Promise<CieloSopAccessToken> {
  const tokenOAuth = await obterTokenOAuthSop(config)
  return emitirAccessTokenDoNavegadorSop(config, tokenOAuth)
}

/** Passo 1 — OAuth2 `client_credentials` na Braspag. */
export async function obterTokenOAuthSop(config: CieloSopConfig): Promise<string> {
  if (!config.clientId || !config.clientSecret) {
    throw new CieloSopOAuthError('Credencial do Silent Order Post ausente (ClientId/ClientSecret da Braspag).', 'credencial_invalida', 'oauth')
  }
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')
  const res = await chamar(config, 'oauth', config.oauthTokenUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials',
  })

  if (!res.ok) {
    const corpoErro = (await lerJson(res)) as { error?: unknown } | null
    const oauthError = typeof corpoErro?.error === 'string' ? corpoErro.error.slice(0, 64) : null
    const credencial = oauthError === 'invalid_client' || res.status === 401 || res.status === 403
    logger.warn({ httpStatus: res.status, oauthError, passo: 'oauth' }, '[cielo][sop] OAuth recusado pela Braspag')
    throw new CieloSopOAuthError(
      credencial
        ? `A Braspag recusou a autenticação do Silent Order Post por credencial inválida (HTTP ${res.status}${oauthError ? `, error=${oauthError}` : ''}). Confira ClientId/ClientSecret e o AMBIENTE: credencial de sandbox é recusada em produção e vice-versa.`
        : `A Braspag recusou a requisição OAuth2 do Silent Order Post por motivo que NÃO parece credencial (HTTP ${res.status}${oauthError ? `, error=${oauthError}` : ''}).`,
      credencial ? 'credencial_invalida' : 'indisponivel',
      'oauth',
      res.status,
    )
  }

  const corpo = (await lerJson(res)) as { access_token?: unknown } | null
  const token = typeof corpo?.access_token === 'string' ? corpo.access_token.trim() : ''
  if (!token) throw new CieloSopOAuthError('A Braspag respondeu ao OAuth do Silent Order Post sem access_token.', 'indisponivel', 'oauth', res.status)
  return token
}

/** Passo 2 — troca o token OAuth pelo `AccessToken` que o navegador usa. */
export async function emitirAccessTokenDoNavegadorSop(config: CieloSopConfig, tokenOAuth: string): Promise<CieloSopAccessToken> {
  const res = await chamar(config, 'accesstoken', config.accessTokenUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenOAuth}`, 'Content-Type': 'application/json', Accept: 'application/json', MerchantId: config.merchantId },
    body: JSON.stringify({ MerchantId: config.merchantId }),
  })

  if (!res.ok) {
    const credencial = res.status === 401 || res.status === 403
    logger.warn({ httpStatus: res.status, passo: 'accesstoken' }, '[cielo][sop] emissão do AccessToken recusada')
    throw new CieloSopOAuthError(
      `A Braspag recusou a emissão do AccessToken do Silent Order Post (HTTP ${res.status}).` +
        (res.status === 500 ? ' HTTP 500 costuma indicar MerchantId e ClientId de lojistas (cadastros) diferentes.' : ''),
      credencial ? 'credencial_invalida' : 'indisponivel',
      'accesstoken',
      res.status,
    )
  }

  const corpo = (await lerJson(res)) as Record<string, unknown> | null
  const accessToken = typeof corpo?.AccessToken === 'string' ? corpo.AccessToken.trim() : typeof corpo?.accessToken === 'string' ? corpo.accessToken.trim() : ''
  if (!accessToken) throw new CieloSopOAuthError('A Braspag respondeu sem AccessToken na emissão do Silent Order Post.', 'indisponivel', 'accesstoken', res.status)

  const expiresIn = typeof corpo?.ExpiresIn === 'number' && Number.isFinite(corpo.ExpiresIn) ? Math.max(MINIMO_SEGUNDOS, Math.floor(corpo.ExpiresIn) - FOLGA_EXPIRACAO_SEGUNDOS) : EXPIRACAO_PADRAO_SEGUNDOS
  return { accessToken, expiresInSeconds: expiresIn }
}

/** `fetch` com prazo; queda de rede e timeout viram `CieloSopOAuthError` `indisponivel` (a causa vai sem segredo: só nome e mensagem do erro de rede). */
async function chamar(config: CieloSopConfig, passo: CieloSopPasso, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    // S-2: nunca seguir redirect (o Basic/Bearer/MerchantId iriam junto para o destino).
    return await (config.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal, redirect: 'error' })
  } catch (err) {
    const abortou = controller.signal.aborted || isAbortError(err)
    logger.warn({ passo, timeout: abortou, err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, '[cielo][sop] falha de rede')
    throw new CieloSopOAuthError(
      abortou ? `A Braspag não respondeu em ${config.timeoutMs} ms (Silent Order Post, passo ${passo}).` : `Não foi possível falar com a Braspag (Silent Order Post, passo ${passo}).`,
      'indisponivel',
      passo,
    )
  } finally {
    clearTimeout(timer)
  }
}

async function lerJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text())
  } catch {
    return null
  }
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'AbortError'
}
