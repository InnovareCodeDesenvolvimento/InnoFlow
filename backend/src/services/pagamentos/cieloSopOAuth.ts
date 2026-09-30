import { logger } from '../../lib/logger'

/**
 * OAuth2 `client_credentials` para obter o `accessToken` de sessão da página
 * de tokenização (Silent Order Post, F5.3, D1: SAQ A-EP) — usa `sopClientId`/
 * `sopClientSecret` (MESMO par que o Cronos já previu em
 * `PaymentGatewayConfig.sopClientId`/`sopClientSecretCiphertext`).
 *
 * ⚠️ NÃO CONFIRMADO contra doc/sandbox real da Cielo nesta tarefa (sem
 * credencial — mesma limitação já registrada em
 * `.claude/agent-memory/nova/cielo-fatos-verificados.md`, que não encontrou
 * um endpoint OAuth para o SOP). Implementação segue o formato PADRÃO OAuth2
 * `client_credentials` (RFC 6749: `Authorization: Basic base64(id:secret)`,
 * corpo `grant_type=client_credentials`, resposta `{access_token, expires_in}`)
 * — é a suposição mais razoável dado o par `sopClientId`/`sopClientSecret`
 * existir no schema, mas PRECISA ser confirmada contra a doc oficial (ou
 * suporte Cielo) antes de produção. `CIELO_SOP_OAUTH_TOKEN_URL` fica SEM
 * default (mesmo padrão de `CIELO_SOP_POST_URL`/`CIELO_SOP_SCRIPT_URL`) —
 * nunca inventamos uma URL.
 */

export interface CieloSopOAuthConfig {
  tokenUrl: string
  clientId: string
  clientSecret: string
  timeoutMs: number
  /** Injeção para teste — nunca bate na rede de verdade nos testes unitários. */
  fetchImpl?: typeof fetch
}

export interface CieloSopAccessToken {
  accessToken: string
  expiresInSeconds: number
}

export class CieloSopOAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CieloSopOAuthError'
  }
}

export async function obterAccessTokenSop(config: CieloSopOAuthConfig): Promise<CieloSopAccessToken> {
  const fetchImpl = config.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
    const res = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: controller.signal,
    })

    const bodyText = await res.text()
    if (!res.ok) {
      // NUNCA logar o corpo (pode ecoar client_secret em erro de validação) — só status.
      logger.warn({ httpStatus: res.status }, '[cielo][sop-oauth] resposta HTTP não-OK ao obter accessToken')
      throw new CieloSopOAuthError(`Cielo (OAuth SOP) respondeu HTTP ${res.status}`)
    }

    const body = JSON.parse(bodyText) as { access_token?: unknown; expires_in?: unknown }
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new CieloSopOAuthError('Cielo (OAuth SOP) não devolveu access_token na resposta.')
    }
    const expiresInSeconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : undefined
    return { accessToken: body.access_token, expiresInSeconds: expiresInSeconds ?? 900 }
  } catch (err) {
    if (err instanceof CieloSopOAuthError) throw err
    if (isAbortError(err)) {
      logger.warn({ timeoutMs: config.timeoutMs }, '[cielo][sop-oauth] timeout')
      throw new CieloSopOAuthError('timeout chamando Cielo (OAuth SOP)')
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[cielo][sop-oauth] erro de rede')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'AbortError'
}
