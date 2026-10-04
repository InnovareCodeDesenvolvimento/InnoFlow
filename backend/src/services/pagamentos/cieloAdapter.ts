import type { DadosCliente, PedidoAutorizacaoCartao, PedidoPix } from '../../core/pagamentos/tipos'
import type { CardPaymentStatus, PixPaymentStatus } from '../../core/pagamentos/tipos'
import { interpretarCancelamentoCielo, normalizarStatusCartaoCielo, normalizarStatusPixCielo, type StatusCartaoNormalizado, type StatusPixNormalizado } from '../../core/pagamentos/normalizarStatusCielo'
import type { PagamentoPort, ResultadoAutorizacao, ResultadoCancelamento, ResultadoCaptura, ResultadoConsultaCartao, ResultadoConsultaPagamento, ResultadoConsultaPix, ResultadoPix, SessaoTokenizacao } from '../../core/pagamentos/porta'
import { resolverUrlsSop } from '../../core/pagamentos/configGateway'
import { expiracaoPixEfetivaSegundos } from '../../core/pagamentos/expiracaoPix'
import { CieloHttpClient, CieloHttpError, CieloTimeoutError } from './cieloHttpClient'
import { extrairCamposPagamento, extrairPagamentoMaisRecenteDaConsulta, montarPayloadAutorizacaoCartao, montarPayloadPix, type CamposPagamentoCielo } from './cieloPayloads'
import { emitirAccessTokenSop } from './cieloSopOAuth'
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
  /**
   * Silent Order Post (C1.1): o navegador do motorista tokeniza o cartão direto na Braspag/Cielo, nunca pelo nosso backend (F5.3). O servidor
   * faz os DOIS passos (OAuth + `accesstoken`, ver `cieloSopOAuth.ts`) e entrega ao navegador o `AccessToken` e a URL do script.
   * Ausente = sem par ClientId/ClientSecret configurado (as URLs sempre existem: default por ambiente em `URLS_SOP`).
   */
  sop?: {
    clientId: string
    clientSecret: string
    oauthTokenUrl: string
    accessTokenUrl: string
    /** URL do script que a página isolada da Lyra carrega (`<script src>`). */
    scriptUrl: string
    timeoutMs: number
    fetchImpl?: typeof fetch
  }
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
        // F20: a Cielo NÃO tem chave de idempotência — um POST /1/sales que deu timeout PODE ter autorizado. NUNCA repetimos o POST: consultamos por MerchantOrderId.
        logger.warn({ merchantOrderId: pedido.merchantOrderId }, '[cielo] timeout em autorizar — reconciliando por MerchantOrderId antes de propagar')
        const consulta = await this.consultarPorPedido(pedido.merchantOrderId)
        if (consulta) {
          return { providerPaymentId: consulta.providerPaymentId, status: consulta.status, returnCode: consulta.returnCode, amountAuthorizedCents: consulta.amountAuthorizedCents, identificadores: consulta.identificadores }
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
        identificadores: campos.identificadores,
      }
    } catch (err) {
      if (err instanceof CieloTimeoutError) {
        // F20: PUT /capture também não é idempotente (captura parcial só uma vez) — reconsulta por PaymentId, nunca repete o PUT às cegas.
        logger.warn({ providerPaymentId }, '[cielo] timeout em capturar — reconciliando por PaymentId antes de propagar')
        const consulta = await this.consultar(providerPaymentId)
        if (consulta.status === 'CAPTURED' || consulta.status === 'FAILED' || consulta.status === 'VOIDED') {
          return { providerPaymentId: consulta.providerPaymentId, status: consulta.status, returnCode: consulta.returnCode, amountCapturedCents: consulta.amountCapturedCents, identificadores: consulta.identificadores }
        }
      }
      throw err
    }
  }

  /**
   * `PUT /1/sales/{id}/void`. HTTP 2xx NÃO é "cancelado" (F19, C2.3): o desfecho sai do `ReturnCode` E do `Status` (`interpretarCancelamentoCielo`).
   * `status: 'VOIDED'` só quando a Cielo confirmou (cancelou, Status 10, OU estornou, Status 11); em andamento/indefinido nada foi provado e devolvemos
   * `AUTHORIZED` (segue como estava); recusa definitiva devolve `FAILED`. Quem chama decide o estado do intent pelo `desfecho`.
   */
  async cancelar(providerPaymentId: string): Promise<ResultadoCancelamento> {
    const body = await this.client.void(providerPaymentId)
    const campos = extrairCamposPagamento(body)
    const interpretacao = interpretarCancelamentoCielo(campos)
    logResultadoCartao('cancelar', campos, interpretacao.desfecho)
    return {
      providerPaymentId: campos.paymentId ?? providerPaymentId,
      status: interpretacao.desfecho === 'CONFIRMADO' ? 'VOIDED' : interpretacao.desfecho === 'RECUSADO' ? 'FAILED' : 'AUTHORIZED',
      returnCode: campos.returnCode,
      desfecho: interpretacao.desfecho,
      reversao: interpretacao.reversao,
      restricaoCadastral: interpretacao.restricaoCadastral,
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

    const expiresInSeconds = expiracaoPixEfetivaSegundos(pedido.expiresInSeconds)
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
    const sop = this.config.sop
    if (!sop) {
      throw new Error('Par ClientId/ClientSecret do Silent Order Post (Braspag) não configurado — o AccessToken de tokenização não pode ser emitido. Cadastre-o na tela do gateway.')
    }
    const token = await emitirAccessTokenSop({
      clientId: sop.clientId,
      clientSecret: sop.clientSecret,
      merchantId: this.config.merchantId,
      oauthTokenUrl: sop.oauthTokenUrl,
      accessTokenUrl: sop.accessTokenUrl,
      timeoutMs: sop.timeoutMs,
      fetchImpl: sop.fetchImpl,
    })
    return {
      // O AccessToken do PASSO 2 (não o token OAuth do passo 1): é o que o script do SOP aceita no navegador.
      accessToken: token.accessToken,
      merchantId: this.config.merchantId,
      environment: this.config.sandbox ? 'sandbox' : 'production',
      scriptUrl: sop.scriptUrl,
      expiresAt: new Date(Date.now() + token.expiresInSeconds * 1000),
    }
  }

  /**
   * `GET /1/card/{token}` — ENRIQUECIMENTO de melhor esforço (C1.3, R2/F25): esse endpoint NÃO está confirmado (não aparece no índice da doc
   * oficial e o Parque nunca o usou), então o cadastro de cartão NÃO depende dele. A fonte principal de `last4`/validade/bandeira é a página
   * isolada (o script do SOP não devolve a bandeira, que é detectada no navegador). Qualquer falha aqui — 404 (endpoint inexistente OU token
   * desconhecido: indistinguíveis), 5xx, timeout, rede — vira "sem dados" com um aviso no log; NUNCA lança e NUNCA vira
   * `CartaoTokenInvalidoError`. A validade do token só é provada na primeira pré-autorização. O `cardToken` nunca vai ao log.
   */
  async consultarCartaoTokenizado(cardToken: string): Promise<ResultadoConsultaCartao> {
    const semDados: ResultadoConsultaCartao = { cardToken, brand: null, last4: null, holderName: null, expiryMonth: null, expiryYear: null }
    try {
      return extrairDadosCartao(await this.client.getCard(cardToken), cardToken)
    } catch (err) {
      logger.warn(
        { httpStatus: err instanceof CieloHttpError ? err.httpStatus : null, timeout: err instanceof CieloTimeoutError },
        '[cielo] consulta do CardToken indisponível — seguindo só com os dados enviados pela página de cartão (enriquecimento é opcional)',
      )
      return semDados
    }
  }
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
    identificadores: campos.identificadores,
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
    identificadores: campos.identificadores,
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
    case 'REFUNDED': // estorno aprovado (Status 11): o dinheiro voltou — para o domínio é "revertido", como VOIDED
      return 'VOIDED'
    case 'DENIED':
    case 'FAILED':
      return 'FAILED'
    case 'PENDING':
    case 'UNKNOWN': // ainda não sei (Status fora da tabela ou incoerente com o ReturnCode): NÃO definitivo, quem chama reconsulta — ver `normalizarStatusCartaoCielo`
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

/**
 * Log SEM corpo inteiro — só os campos não sensíveis (regra dura da tarefa). Os identificadores (`Tid` etc.) NÃO vão ao log. Avisa (sem valores) quando
 * um identificador estourou 64 caracteres e foi truncado (C2.5: o fluxo segue, o metadado é que fica cortado) e quando o par Status/ReturnCode não é
 * reconhecido (`UNKNOWN`: nunca aprovação, mas o plantão precisa saber).
 */
function logResultadoCartao(operacao: string, campos: CamposPagamentoCielo, desfechoCancelamento?: string): void {
  logger.info(
    { operacao, paymentId: campos.paymentId, status: campos.status, returnCode: campos.returnCode, amountAuthorizedCents: campos.amountAuthorizedCents, amountCapturedCents: campos.amountCapturedCents, ...(desfechoCancelamento ? { desfechoCancelamento } : {}) },
    `[cielo] ${operacao}`,
  )
  if (campos.identificadoresTruncados.length > 0) {
    logger.warn({ alert: 'payment_cielo_identifier_truncated', operacao, paymentId: campos.paymentId, campos: campos.identificadoresTruncados }, '[cielo] identificador da adquirente acima de 64 caracteres — gravado TRUNCADO (o pagamento segue)')
  }
  if (operacao !== 'cancelar' && normalizarStatusCartaoCielo(campos) === 'UNKNOWN') {
    logger.warn({ alert: 'payment_cielo_status_unrecognized', operacao, paymentId: campos.paymentId, status: campos.status, returnCode: campos.returnCode }, '[cielo] Status/ReturnCode não reconhecido — tratado como NÃO definitivo (será reconsultado)')
  }
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
  CIELO_SOP_ACCESS_TOKEN_URL?: string
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
  // C1.1: URLs do SOP por AMBIENTE (default = as do Parque, provadas em produção); as envs `CIELO_SOP_*_URL` são só override.
  const urlsSop = resolverUrlsSop(env.CIELO_SANDBOX ? 'sandbox' : 'production', { oauthToken: env.CIELO_SOP_OAUTH_TOKEN_URL, accessToken: env.CIELO_SOP_ACCESS_TOKEN_URL, script: env.CIELO_SOP_SCRIPT_URL })
  const sop =
    env.CIELO_SOP_CLIENT_ID && env.CIELO_SOP_CLIENT_SECRET
      ? { clientId: env.CIELO_SOP_CLIENT_ID, clientSecret: env.CIELO_SOP_CLIENT_SECRET, oauthTokenUrl: urlsSop.oauthToken, accessTokenUrl: urlsSop.accessToken, scriptUrl: urlsSop.script, timeoutMs: env.CIELO_TIMEOUT_MS }
      : undefined
  return new CieloAdapter(client, { merchantId: env.CIELO_MERCHANT_ID, sandbox: env.CIELO_SANDBOX, sop })
}
