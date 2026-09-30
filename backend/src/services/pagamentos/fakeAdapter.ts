import type { PagamentoPort, ResultadoAutorizacao, ResultadoCancelamento, ResultadoCaptura, ResultadoConsultaPagamento, ResultadoConsultaPix, ResultadoPix, SessaoTokenizacao } from '../../core/pagamentos/porta'
import type { CardPaymentStatus, DadosCliente, PedidoAutorizacaoCartao, PedidoPix, PixPaymentStatus } from '../../core/pagamentos/tipos'

/**
 * `PagamentoPort` em memória — para Íris/Lyra/outros times de F5.2+
 * testarem o fluxo (rotas, handlers OCPP, telas) SEM bater na Cielo de
 * verdade. Comportamento determinístico e configurável via
 * `FakeAdapterOptions` (ex.: forçar negação para testar o caminho de erro).
 *
 * NÃO é um mock de teste unitário (fica em `services/`, implementa a porta
 * de verdade) — é um adaptador de fato, plugável no lugar do `CieloAdapter`
 * em ambiente sem credencial (dev local, CI, demo).
 */

export interface FakeAdapterOptions {
  /** `cardToken`s que devem ser tratados como recusados pelo emissor (simula `Status=3 Denied`). */
  cardTokensNegados?: string[]
  /** Gera IDs previsíveis para asserção em teste (`fake-payment-1`, `fake-payment-2`, ...). Default: `crypto.randomUUID()`. */
  gerarId?: () => string
}

interface IntentSimulado {
  providerPaymentId: string
  merchantOrderId: string
  status: CardPaymentStatus
  returnCode: string | null
  amountAuthorizedCents: number | null
  amountCapturedCents: number | null
}

/** Pix vive num mapa SEPARADO do cartão (mesma separação de vocabulário do `PagamentoPort` real — `PixPaymentStatus` != `CardPaymentStatus`, ver gap fechado em `ResultadoConsultaPix`). */
interface IntentPixSimulado {
  providerPaymentId: string
  merchantOrderId: string
  status: PixPaymentStatus
  amountRequestedCents: number
}

export class FakeAdapter implements PagamentoPort {
  private readonly intents = new Map<string, IntentSimulado>()
  private readonly porMerchantOrderId = new Map<string, string>()
  private readonly pixIntents = new Map<string, IntentPixSimulado>()
  private contador = 0

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  private proximoId(): string {
    if (this.options.gerarId) return this.options.gerarId()
    this.contador += 1
    return `fake-payment-${this.contador}`
  }

  async autorizar(pedido: PedidoAutorizacaoCartao): Promise<ResultadoAutorizacao> {
    const negado = this.options.cardTokensNegados?.includes(pedido.cartao.cardToken) ?? false
    const providerPaymentId = this.proximoId()

    const intent: IntentSimulado = negado
      ? { providerPaymentId, merchantOrderId: pedido.merchantOrderId, status: 'FAILED', returnCode: '2', amountAuthorizedCents: null, amountCapturedCents: null }
      : { providerPaymentId, merchantOrderId: pedido.merchantOrderId, status: 'AUTHORIZED', returnCode: '00', amountAuthorizedCents: pedido.amountRequestedCents, amountCapturedCents: null }

    this.intents.set(providerPaymentId, intent)
    this.porMerchantOrderId.set(pedido.merchantOrderId, providerPaymentId)

    return { providerPaymentId, status: intent.status, returnCode: intent.returnCode, amountAuthorizedCents: intent.amountAuthorizedCents }
  }

  async capturar(providerPaymentId: string, amountCents: number): Promise<ResultadoCaptura> {
    const intent = this.exigirIntent(providerPaymentId)
    if (intent.status !== 'AUTHORIZED') {
      throw new Error(`FakeAdapter.capturar: intent ${providerPaymentId} está em ${intent.status}, esperado AUTHORIZED`)
    }
    intent.status = 'CAPTURED'
    intent.amountCapturedCents = amountCents
    intent.returnCode = '6'
    return { providerPaymentId, status: intent.status, returnCode: intent.returnCode, amountCapturedCents: intent.amountCapturedCents }
  }

  async cancelar(providerPaymentId: string): Promise<ResultadoCancelamento> {
    const intent = this.exigirIntent(providerPaymentId)
    intent.status = 'VOIDED'
    return { providerPaymentId, status: intent.status, returnCode: intent.returnCode }
  }

  async consultar(providerPaymentId: string): Promise<ResultadoConsultaPagamento> {
    const intent = this.exigirIntent(providerPaymentId)
    return {
      providerPaymentId: intent.providerPaymentId,
      merchantOrderId: intent.merchantOrderId,
      status: intent.status,
      returnCode: intent.returnCode,
      amountAuthorizedCents: intent.amountAuthorizedCents,
      amountCapturedCents: intent.amountCapturedCents,
    }
  }

  async consultarPorPedido(merchantOrderId: string): Promise<ResultadoConsultaPagamento | null> {
    const providerPaymentId = this.porMerchantOrderId.get(merchantOrderId)
    if (!providerPaymentId) return null
    return this.consultar(providerPaymentId)
  }

  async criarPix(pedido: PedidoPix): Promise<ResultadoPix> {
    const providerPaymentId = this.proximoId()
    const expiresInSeconds = pedido.expiresInSeconds ?? 86_400

    this.pixIntents.set(providerPaymentId, {
      providerPaymentId,
      merchantOrderId: pedido.merchantOrderId,
      status: 'PENDING',
      amountRequestedCents: pedido.amountRequestedCents,
    })

    return {
      providerPaymentId,
      merchantOrderId: pedido.merchantOrderId,
      status: 'PENDING',
      qrCodeString: `00020126-fake-pix-${providerPaymentId}`,
      // Base64 de 1x1 px — só para exercitar o caminho "existe imagem" nos
      // testes/telas sem depender de rede nenhuma.
      qrCodeBase64Image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    }
  }

  async consultarPix(providerPaymentId: string): Promise<ResultadoConsultaPix> {
    const intent = this.pixIntents.get(providerPaymentId)
    if (!intent) throw new Error(`FakeAdapter: providerPaymentId (Pix) desconhecido: ${providerPaymentId}`)
    return {
      providerPaymentId: intent.providerPaymentId,
      merchantOrderId: intent.merchantOrderId,
      status: intent.status,
      returnCode: intent.status === 'PAID' ? '6' : null,
      amountCents: intent.status === 'PAID' ? intent.amountRequestedCents : null,
    }
  }

  sessaoTokenizacao(_cliente?: DadosCliente): SessaoTokenizacao {
    return { merchantId: 'fake-merchant-id', postUrl: 'https://fake.local/sop', sandbox: true }
  }

  private exigirIntent(providerPaymentId: string): IntentSimulado {
    const intent = this.intents.get(providerPaymentId)
    if (!intent) throw new Error(`FakeAdapter: providerPaymentId desconhecido: ${providerPaymentId}`)
    return intent
  }

  // ------------------------------------------------------------
  // Helpers SÓ de teste — simulam o que a Cielo faria "do outro lado" (o
  // motorista pagando o QR no app do banco). Nenhum caminho de produção
  // chama isto; existe para os testes de integração (webhook, varredor de
  // expiração) poderem fazer `consultarPix` mudar de PENDING para PAID/
  // EXPIRED sem precisar de rede.
  // ------------------------------------------------------------

  /** Simula o pagamento confirmado do lado da Cielo — depois disto, `consultarPix(providerPaymentId)` devolve `PAID`. */
  marcarPixComoPago(providerPaymentId: string): void {
    const intent = this.pixIntents.get(providerPaymentId)
    if (!intent) throw new Error(`FakeAdapter.marcarPixComoPago: providerPaymentId desconhecido: ${providerPaymentId}`)
    intent.status = 'PAID'
  }

  /** Simula a Cielo confirmando que o QR expirou sem pagamento. */
  marcarPixComoExpirado(providerPaymentId: string): void {
    const intent = this.pixIntents.get(providerPaymentId)
    if (!intent) throw new Error(`FakeAdapter.marcarPixComoExpirado: providerPaymentId desconhecido: ${providerPaymentId}`)
    intent.status = 'EXPIRED'
  }
}
