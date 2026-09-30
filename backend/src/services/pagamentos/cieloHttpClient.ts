import { logger } from '../../lib/logger'

/**
 * Transporte HTTP cru para a API 3.0 da Cielo. NÃO conhece `PaymentIntent`
 * nem o vocabulário de domínio (`CardPaymentStatus` etc.) — isso é
 * responsabilidade do `CieloAdapter` (`cieloAdapter.ts`), que implementa a
 * `PagamentoPort`. Esta separação existe para o parsing/normalização ficar
 * testável sem depender de rede.
 *
 * Regra dura da tarefa (prioridade alta, recomendação do Órion): NUNCA logar
 * o corpo inteiro de request/response — só os campos não sensíveis
 * (PaymentId, Status, ReturnCode, valores). O corpo pode conter CardNumber/
 * SecurityCode/CardToken mesmo com tokenização (ex.: eco do payload em erro
 * de validação) — não vale confiar só no redact do logger para isto.
 *
 * Dois hosts (fato da Cielo): cobrança/cancelamento em `apiBaseUrl`,
 * consulta em `apiQueryBaseUrl` (janela de 3 meses).
 *
 * Timeout via `AbortController` — SEM retry automático aqui: a API 3.0 não
 * tem chave de idempotência, então repetir cegamente um POST que deu timeout
 * pode duplicar a cobrança. A política de "timeout -> consultar por
 * MerchantOrderId antes de repetir" mora no `CieloAdapter`, não aqui.
 */

export interface CieloHttpClientConfig {
  merchantId: string
  merchantKey: string
  apiBaseUrl: string
  apiQueryBaseUrl: string
  timeoutMs: number
  /** Injeção para teste — nunca bate na rede de verdade nos testes unitários. */
  fetchImpl?: typeof fetch
}

export class CieloTimeoutError extends Error {
  constructor(path: string) {
    super(`timeout chamando Cielo: ${path}`)
    this.name = 'CieloTimeoutError'
  }
}

export class CieloHttpError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    /** Corpo de erro já parseado — só usado internamente para extrair Status/ReturnCode; nunca logado inteiro. */
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'CieloHttpError'
  }
}

export class CieloHttpClient {
  constructor(private readonly config: CieloHttpClientConfig) {}

  private async request<T>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
    const fetchImpl = this.config.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          MerchantId: this.config.merchantId,
          MerchantKey: this.config.merchantKey,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      })

      const bodyText = await res.text()
      const body = bodyText ? safeJsonParse(bodyText) : null

      if (!res.ok) {
        logger.warn({ httpStatus: res.status, path }, '[cielo] resposta HTTP não-OK')
        throw new CieloHttpError(`Cielo respondeu HTTP ${res.status}`, res.status, body)
      }

      return body as T
    } catch (err) {
      if (err instanceof CieloHttpError) throw err
      if (isAbortError(err)) {
        logger.warn({ path, timeoutMs: this.config.timeoutMs }, '[cielo] timeout')
        throw new CieloTimeoutError(path)
      }
      logger.error({ path, err: err instanceof Error ? err.message : String(err) }, '[cielo] erro de rede')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** `POST /1/sales/` — cria pedido + autoriza (pré-autorização, `Capture: false`). */
  postSale(payload: unknown): Promise<unknown> {
    return this.request(this.config.apiBaseUrl, '/1/sales/', { method: 'POST', body: JSON.stringify(payload) })
  }

  /** `PUT /1/sales/{PaymentId}/capture?amount=` — captura parcial/total (uma única vez, fato da Cielo). */
  capture(providerPaymentId: string, amountCents?: number): Promise<unknown> {
    const qs = amountCents !== undefined ? `?amount=${amountCents}` : ''
    return this.request(this.config.apiBaseUrl, `/1/sales/${encodeURIComponent(providerPaymentId)}/capture${qs}`, { method: 'PUT' })
  }

  /** `PUT /1/sales/{PaymentId}/void?amount=` — cancelamento total (sem `amount`) ou parcial. */
  void(providerPaymentId: string, amountCents?: number): Promise<unknown> {
    const qs = amountCents !== undefined ? `?amount=${amountCents}` : ''
    return this.request(this.config.apiBaseUrl, `/1/sales/${encodeURIComponent(providerPaymentId)}/void${qs}`, { method: 'PUT' })
  }

  /** `GET /1/sales/{PaymentId}` no host de CONSULTA. */
  getByPaymentId(providerPaymentId: string): Promise<unknown> {
    return this.request(this.config.apiQueryBaseUrl, `/1/sales/${encodeURIComponent(providerPaymentId)}`, { method: 'GET' })
  }

  /** `GET /1/sales?merchantOrderId=` no host de CONSULTA — caminho de reconciliação pós-timeout. */
  getByMerchantOrderId(merchantOrderId: string): Promise<unknown> {
    return this.request(this.config.apiQueryBaseUrl, `/1/sales?merchantOrderId=${encodeURIComponent(merchantOrderId)}`, { method: 'GET' })
  }

  /** `POST /1/pix/` — cobrança Pix (`Payment.Type: "Pix"`, `Payment.Provider: "Cielo2"`). Fato: sem sandbox real (ver handoff). */
  postPix(payload: unknown): Promise<unknown> {
    return this.request(this.config.apiBaseUrl, '/1/pix/', { method: 'POST', body: JSON.stringify(payload) })
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Cielo às vezes devolve texto puro em erro 5xx/gateway — não deixamos isso derrubar o parsing.
    return { raw: text }
  }
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'AbortError'
}

/**
 * Constrói o cliente a partir da env. Lança se `CIELO_MERCHANT_ID`/
 * `CIELO_MERCHANT_KEY` não estiverem configuradas — de propósito NÃO é
 * chamado no boot dos 3 entrypoints (ver `env.ts`), só no primeiro uso real
 * (F5.2 pluga isto nas rotas). Sem credencial, use `FakeAdapter`.
 */
export function criarCieloHttpClientFromEnv(env: {
  CIELO_MERCHANT_ID?: string
  CIELO_MERCHANT_KEY?: string
  CIELO_API_BASE_URL: string
  CIELO_API_QUERY_BASE_URL: string
  CIELO_TIMEOUT_MS: number
}): CieloHttpClient {
  if (!env.CIELO_MERCHANT_ID || !env.CIELO_MERCHANT_KEY) {
    throw new Error('CIELO_MERCHANT_ID/CIELO_MERCHANT_KEY não configurados — use FakeAdapter em ambiente sem credencial Cielo.')
  }
  return new CieloHttpClient({
    merchantId: env.CIELO_MERCHANT_ID,
    merchantKey: env.CIELO_MERCHANT_KEY,
    apiBaseUrl: env.CIELO_API_BASE_URL,
    apiQueryBaseUrl: env.CIELO_API_QUERY_BASE_URL,
    timeoutMs: env.CIELO_TIMEOUT_MS,
  })
}
