import type { DadosCliente, PedidoAutorizacaoCartao, PedidoPix } from '../../core/pagamentos/tipos'
import type { CardPaymentStatus, PixPaymentStatus } from '../../core/pagamentos/tipos'
import { normalizarStatusCartaoCielo, normalizarStatusPixCielo, type StatusCartaoNormalizado, type StatusPixNormalizado } from '../../core/pagamentos/normalizarStatusCielo'
import type { PagamentoPort, ResultadoAutorizacao, ResultadoCancelamento, ResultadoCaptura, ResultadoConsultaPagamento, ResultadoPix, SessaoTokenizacao } from '../../core/pagamentos/porta'
import { CieloHttpClient, CieloTimeoutError } from './cieloHttpClient'
import { extrairCamposPagamento, extrairPagamentoMaisRecenteDaConsulta, montarPayloadAutorizacaoCartao, montarPayloadPix, type CamposPagamentoCielo } from './cieloPayloads'
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
  /** URL de destino do Silent Order Post (SOP) — o navegador do motorista posta o cartão direto aqui, nunca pelo nosso backend. */
  sopPostUrl?: string
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

  sessaoTokenizacao(_cliente?: DadosCliente): SessaoTokenizacao {
    if (!this.config.sopPostUrl) {
      throw new Error(
        'CIELO_SOP_POST_URL não configurada — URL do Silent Order Post não foi confirmada contra a doc oficial nesta tarefa (F5.1). Configurar antes de plugar na rota (F5.2).',
      )
    }
    return { merchantId: this.config.merchantId, postUrl: this.config.sopPostUrl, sandbox: this.config.sandbox }
  }
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
  CIELO_SOP_POST_URL?: string
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
  return new CieloAdapter(client, { merchantId: env.CIELO_MERCHANT_ID, sandbox: env.CIELO_SANDBOX, sopPostUrl: env.CIELO_SOP_POST_URL })
}
