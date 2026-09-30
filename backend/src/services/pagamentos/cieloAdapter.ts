import type { DadosCliente, PedidoAutorizacaoCartao, PedidoPix } from '../../core/pagamentos/tipos'
import type { CardPaymentStatus, PixPaymentStatus } from '../../core/pagamentos/tipos'
import { normalizarStatusCartaoCielo, normalizarStatusPixCielo, type StatusCartaoNormalizado, type StatusPixNormalizado } from '../../core/pagamentos/normalizarStatusCielo'
import type { PagamentoPort, ResultadoAutorizacao, ResultadoCancelamento, ResultadoCaptura, ResultadoConsultaCartao, ResultadoConsultaPagamento, ResultadoConsultaPix, ResultadoPix, SessaoTokenizacao } from '../../core/pagamentos/porta'
import { CartaoTokenInvalidoError } from '../../core/pagamentos/erros'
import { CieloHttpClient, CieloHttpError, CieloTimeoutError } from './cieloHttpClient'
import { extrairCamposPagamento, extrairPagamentoMaisRecenteDaConsulta, montarPayloadAutorizacaoCartao, montarPayloadPix, type CamposPagamentoCielo } from './cieloPayloads'
import { obterAccessTokenSop } from './cieloSopOAuth'
import { logger } from '../../lib/logger'

/**
 * `PagamentoPort` de verdade — Cielo (sandbox/produção conforme env, ver
 * `criarCieloAdapterFromEnv`). Regra de reconciliação de timeout (decisão #2
 * da Nova, fato da Cielo — API 3.0 sem chave de idempotência): ANTES de
 * propagar um `CieloTimeoutError` do `autorizar`, consultamos por
 * `MerchantOrderId` — se a Cielo já processou (só a nossa resposta que se
 * perdeu na rede), devolvemos o resultado real em vez de deixar quem chamou
 * arriscar duplicar a cobrança tentando de novo.
 */

export interface CieloAdapterConfig {
  merchantId: string
  sandbox: boolean
  /** URL do script do Silent Order Post (SOP) que a página isolada da Lyra carrega — o navegador do motorista tokeniza o cartão direto na Cielo, nunca pelo nosso backend (F5.3). */
  sopScriptUrl?: string
  /** `client_credentials` OAuth para obter o `accessToken` da sessão de tokenização — ⚠️ não confirmado contra doc/sandbox real (ver `cieloSopOAuth.ts`). */
  sopOAuth?: { tokenUrl: string; clientId: string; clientSecret: string; timeoutMs: number; fetchImpl?: typeof fetch }
}

export class CieloAdapter implements PagamentoPort {
  constructor(
    private readonly client: CieloHttpClient,
    private readonly config: CieloAdapterConfig,
  ) {}

  async autorizar(pedido: PedidoAutorizacaoCartao): Promise<ResultadoAutorizacao> {
    const payload = montarPayloadAutorizacaoCartao(pedido)
    try {
      const body = await this.client.postSale(payload)
      const campos = extrairCamposPagamento(body)
      logResultadoCartao('autorizar', campos)
      return camposParaResultadoAutorizacao(campos)
    } catch (err) {
      if (err instanceof CieloTimeoutError) {
        logger.warn({ merchantOrderId: pedido.merchantOrderId }, '[cielo] timeout em autorizar — reconciliando por MerchantOrderId antes de propagar')
        const consulta = await this.consultarPorPedido(pedido.merchantOrderId)
        if (consulta) {
          return { providerPaymentId: consulta.providerPaymentId, status: consulta.status, returnCode: consulta.returnCode, amountAuthorizedCents: consulta.amountAuthorizedCents }
        }
        // Cielo não tem registro nenhum deste MerchantOrderId ainda — o timeout
        // foi mesmo antes de qualquer processamento. Quem chama decide se tenta de novo.
      }
      throw err
    }
  }

  async capturar(providerPaymentId: string, amountCents: number): Promise<ResultadoCaptura> {
    try {
      const body = await this.client.capture(providerPaymentId, amountCents)
      const campos = extrairCamposPagamento(body)
      logResultadoCartao('capturar', campos)
      return {
        providerPaymentId: campos.paymentId ?? providerPaymentId,
        status: mapStatusCartaoParaDominio(normalizarStatusCartaoCielo(campos)),
        returnCode: campos.returnCode,
        amountCapturedCents: campos.amountCapturedCents,
      }
    } catch (err) {
      if (err instanceof CieloTimeoutError) {
        logger.warn({ providerPaymentId }, '[cielo] timeout em capturar — reconciliando por PaymentId antes de propagar')
        const consulta = await this.consultar(providerPaymentId)
        if (consulta.status === 'CAPTURED' || consulta.status === 'FAILED' || consulta.status === 'VOIDED') {
          return { providerPaymentId: consulta.providerPaymentId, status: consulta.status, returnCode: consulta.returnCode, amountCapturedCents: consulta.amountCapturedCents }
        }
      }
      throw err
    }
  }

  async cancelar(providerPaymentId: string): Promise<ResultadoCancelamento> {
    const body = await this.client.void(providerPaymentId)
    const campos = extrairCamposPagamento(body)
    logResultadoCartao('cancelar', campos)
    return {
      providerPaymentId: campos.paymentId ?? providerPaymentId,
      status: mapStatusCartaoParaDominio(normalizarStatusCartaoCielo(campos)),
      returnCode: campos.returnCode,
    }
  }

  async consultar(providerPaymentId: string): Promise<ResultadoConsultaPagamento> {
    const body = await this.client.getByPaymentId(providerPaymentId)
    const campos = extrairCamposPagamento(body)
    return camposParaResultadoConsulta(campos, providerPaymentId)
  }

  async consultarPorPedido(merchantOrderId: string): Promise<ResultadoConsultaPagamento | null> {
    const body = await this.client.getByMerchantOrderId(merchantOrderId)
    const campos = extrairPagamentoMaisRecenteDaConsulta(body)
    if (!campos) return null
    return camposParaResultadoConsulta(campos, campos.paymentId ?? '')
  }

  async criarPix(pedido: PedidoPix): Promise<ResultadoPix> {
    const payload = montarPayloadPix(pedido)
    const body = await this.client.postPix(payload)
    const campos = extrairCamposPagamento(body)
    const raw = body as Record<string, unknown>
    const payment = (raw.Payment as Record<string, unknown> | undefined) ?? {}
    const qrCodeString = typeof payment.QrCodeString === 'string' ? payment.QrCodeString : ''
    const qrCodeBase64Image = typeof payment.QrCodeBase64Image === 'string' ? payment.QrCodeBase64Image : null

    logger.info({ merchantOrderId: pedido.merchantOrderId, paymentId: campos.paymentId, status: campos.status }, '[cielo] Pix criado')

    const expiresInSeconds = pedido.expiresInSeconds ?? 86_400
    return {
      providerPaymentId: campos.paymentId ?? '',
      merchantOrderId: pedido.merchantOrderId,
      status: mapStatusPixParaDominio(normalizarStatusPixCielo(campos)),
      qrCodeString,
      qrCodeBase64Image,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    }
  }

  /**
   * GAP fechado na F5.2 (ver comentário de `ResultadoConsultaPix`): mesmo
   * endpoint de consulta de cartão (`GET /1/sales/{PaymentId}` no host de
   * query), mas normalizado com o vocabulário PIX
   * (`normalizarStatusPixCielo`), nunca com `normalizarStatusCartaoCielo`.
   */
  async consultarPix(providerPaymentId: string): Promise<ResultadoConsultaPix> {
    const body = await this.client.getByPaymentId(providerPaymentId)
    const campos = extrairCamposPagamento(body)
    return {
      providerPaymentId: campos.paymentId ?? providerPaymentId,
      merchantOrderId: campos.merchantOrderId ?? '',
      status: mapStatusPixParaDominio(normalizarStatusPixCielo(campos)),
      returnCode: campos.returnCode,
      amountCents: campos.amountAuthorizedCents,
    }
  }

  async sessaoTokenizacao(_cliente?: DadosCliente): Promise<SessaoTokenizacao> {
    if (!this.config.sopScriptUrl) {
      throw new Error(
        'CIELO_SOP_SCRIPT_URL não configurada — URL do script do Silent Order Post não foi confirmada contra a doc oficial (F5.1/F5.3). Configurar antes de expor a rota de tokenização.',
      )
    }
    if (!this.config.sopOAuth) {
      throw new Error(
        'CIELO_SOP_CLIENT_ID/CIELO_SOP_CLIENT_SECRET/CIELO_SOP_OAUTH_TOKEN_URL não configurados — accessToken de tokenização (F5.3) não pode ser emitido. Ver cieloSopOAuth.ts (mecanismo ainda não confirmado contra a doc real da Cielo).',
      )
    }
    const token = await obterAccessTokenSop(this.config.sopOAuth)
    return {
      accessToken: token.accessToken,
      merchantId: this.config.merchantId,
      environment: this.config.sandbox ? 'sandbox' : 'production',
      scriptUrl: this.config.sopScriptUrl,
      expiresAt: new Date(Date.now() + token.expiresInSeconds * 1000),
    }
  }

  /**
   * `GET /1/card/{token}` — valida + consulta o CardToken recebido do
   * frontend ANTES de gravar `PaymentMethod` (F5.3). HTTP 404 é o caso
   * "token desconhecido/inválido" (achado nesta tarefa, sem sandbox — melhor
   * esforço a partir da convenção REST da própria Cielo no resto da API) e
   * vira `CartaoTokenInvalidoError` (a rota mapeia para 400
   * `INVALID_CARD_TOKEN`); qualquer outro erro (timeout, 5xx) propaga cru
   * (a rota mapeia para `CARD_VERIFICATION_FAILED`).
   */
  async consultarCartaoTokenizado(cardToken: string): Promise<ResultadoConsultaCartao> {
    let body: unknown
    try {
      body = await this.client.getCard(cardToken)
    } catch (err) {
      if (err instanceof CieloHttpError && err.httpStatus === 404) {
        throw new CartaoTokenInvalidoError(mascararCardToken(cardToken))
      }
      throw err
    }
    return extrairDadosCartao(body, cardToken)
  }
}

/** Nunca logar/propagar o token inteiro em mensagem de erro — só os 4 últimos caracteres, suficiente para correlacionar sem expor o segredo. */
function mascararCardToken(cardToken: string): string {
  return cardToken.length > 4 ? `***${cardToken.slice(-4)}` : '***'
}

/**
 * Resposta de `GET /1/card/{token}` — formato MELHOR ESFORÇO (não batido
 * contra sandbox real): `{ CardNumber: "000000******0001", Holder: "NOME",
 * ExpirationDate: "12/2030", Brand: "Visa" }`. Aceita variações plausíveis de
 * nome de campo sem quebrar caso a doc real confirme outro formato.
 */
function extrairDadosCartao(body: unknown, cardToken: string): ResultadoConsultaCartao {
  const raw = (body as Record<string, unknown> | null | undefined) ?? {}
  const cardNumber = typeof raw.CardNumber === 'string' ? raw.CardNumber : null
  const last4 = cardNumber && cardNumber.length >= 4 ? cardNumber.slice(-4) : null
  const holderName = typeof raw.Holder === 'string' ? raw.Holder : null
  const brand = typeof raw.Brand === 'string' ? raw.Brand : null
  const expirationDate = typeof raw.ExpirationDate === 'string' ? raw.ExpirationDate : null
  const [expiryMonth, expiryYear] = parseExpirationDate(expirationDate)

  return { cardToken, brand, last4, holderName, expiryMonth, expiryYear }
}

function parseExpirationDate(value: string | null): [number | null, number | null] {
  if (!value) return [null, null]
  const match = /^(\d{1,2})\/(\d{4})$/.exec(value.trim())
  if (!match) return [null, null]
  const month = Number(match[1])
  const year = Number(match[2])
  if (month < 1 || month > 12) return [null, null]
  return [month, year]
}

function camposParaResultadoAutorizacao(campos: CamposPagamentoCielo): ResultadoAutorizacao {
  return {
    providerPaymentId: campos.paymentId ?? '',
    status: mapStatusCartaoParaDominio(normalizarStatusCartaoCielo(campos)),
    returnCode: campos.returnCode,
    amountAuthorizedCents: campos.amountAuthorizedCents,
  }
}

function camposParaResultadoConsulta(campos: CamposPagamentoCielo, fallbackPaymentId: string): ResultadoConsultaPagamento {
  return {
    providerPaymentId: campos.paymentId ?? fallbackPaymentId,
    merchantOrderId: campos.merchantOrderId ?? '',
    status: mapStatusCartaoParaDominio(normalizarStatusCartaoCielo(campos)),
    returnCode: campos.returnCode,
    amountAuthorizedCents: campos.amountAuthorizedCents,
    amountCapturedCents: campos.amountCapturedCents,
  }
}

/** `PENDING` (Cielo ainda processando) não existe em `CardPaymentStatus` — mapeado para `CREATED` (ainda sem decisão). `DENIED` vira `FAILED` (a máquina de estados não distingue negado de erro; `returnCode` preserva o detalhe). */
function mapStatusCartaoParaDominio(normalizado: StatusCartaoNormalizado): CardPaymentStatus {
  switch (normalizado) {
    case 'AUTHORIZED':
      return 'AUTHORIZED'
    case 'CAPTURED':
      return 'CAPTURED'
    case 'VOIDED':
      return 'VOIDED'
    case 'DENIED':
    case 'FAILED':
      return 'FAILED'
    case 'PENDING':
      return 'CREATED'
  }
}

function mapStatusPixParaDominio(normalizado: StatusPixNormalizado): PixPaymentStatus {
  switch (normalizado) {
    case 'PAID':
      return 'PAID'
    case 'PENDING':
      return 'PENDING'
    case 'ABORTED':
    case 'FAILED':
      return 'FAILED'
  }
}

/** Log SEM corpo inteiro — só os campos não sensíveis (regra dura da tarefa). */
function logResultadoCartao(operacao: string, campos: CamposPagamentoCielo): void {
  logger.info(
    { operacao, paymentId: campos.paymentId, status: campos.status, returnCode: campos.returnCode, amountAuthorizedCents: campos.amountAuthorizedCents, amountCapturedCents: campos.amountCapturedCents },
    `[cielo] ${operacao}`,
  )
}

export function criarCieloAdapterFromEnv(env: {
  CIELO_MERCHANT_ID?: string
  CIELO_MERCHANT_KEY?: string
  CIELO_API_BASE_URL: string
  CIELO_API_QUERY_BASE_URL: string
  CIELO_TIMEOUT_MS: number
  CIELO_SANDBOX: boolean
  CIELO_SOP_SCRIPT_URL?: string
  CIELO_SOP_CLIENT_ID?: string
  CIELO_SOP_CLIENT_SECRET?: string
  CIELO_SOP_OAUTH_TOKEN_URL?: string
}): CieloAdapter {
  if (!env.CIELO_MERCHANT_ID || !env.CIELO_MERCHANT_KEY) {
    throw new Error('CIELO_MERCHANT_ID/CIELO_MERCHANT_KEY não configurados — use FakeAdapter em ambiente sem credencial Cielo.')
  }
  const client = new CieloHttpClient({
    merchantId: env.CIELO_MERCHANT_ID,
    merchantKey: env.CIELO_MERCHANT_KEY,
    apiBaseUrl: env.CIELO_API_BASE_URL,
    apiQueryBaseUrl: env.CIELO_API_QUERY_BASE_URL,
    timeoutMs: env.CIELO_TIMEOUT_MS,
  })
  const sopOAuth =
    env.CIELO_SOP_CLIENT_ID && env.CIELO_SOP_CLIENT_SECRET && env.CIELO_SOP_OAUTH_TOKEN_URL
      ? { tokenUrl: env.CIELO_SOP_OAUTH_TOKEN_URL, clientId: env.CIELO_SOP_CLIENT_ID, clientSecret: env.CIELO_SOP_CLIENT_SECRET, timeoutMs: env.CIELO_TIMEOUT_MS }
      : undefined
  return new CieloAdapter(client, { merchantId: env.CIELO_MERCHANT_ID, sandbox: env.CIELO_SANDBOX, sopScriptUrl: env.CIELO_SOP_SCRIPT_URL, sopOAuth })
}
