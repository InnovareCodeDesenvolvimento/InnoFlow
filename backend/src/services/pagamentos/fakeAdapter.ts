import type { PagamentoPort, ResultadoAutorizacao, ResultadoCancelamento, ResultadoCaptura, ResultadoConsultaCartao, ResultadoConsultaPagamento, ResultadoConsultaPix, ResultadoPix, SessaoTokenizacao } from '../../core/pagamentos/porta'
import type { CardPaymentStatus, DadosCliente, PedidoAutorizacaoCartao, PedidoPix, PixPaymentStatus } from '../../core/pagamentos/tipos'
import { CartaoTokenInvalidoError } from '../../core/pagamentos/erros'
import { expiracaoPixEfetivaSegundos } from '../../core/pagamentos/expiracaoPix'
import { SEM_IDENTIFICADORES_ADQUIRENTE, type IdentificadoresAdquirente } from '../../core/pagamentos/identificadoresAdquirente'

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
  /** `cardToken`s que `consultarCartaoTokenizado` deve tratar como desconhecidos/inválidos (F5.3, simula `GET /1/card/{token}` 404). */
  cardTokensInvalidos?: string[]
  /**
   * Como `capturar()` se comporta (F5.7, M1) — para provar a política "só resultado definitivo decide a cobrança":
   *  - `NORMAL` (default): captura na hora.
   *  - `PENDENTE`: a Cielo aceita a captura mas ainda processa (`Status=PENDING` -> `CREATED` no vocabulário da porta):
   *    `capturar()` e `consultar()` devolvem CREATED até `concluirCapturaPendente()` (que simula "a Cielo concluiu depois").
   *  - `NEGADA`: a Cielo recusa a captura de forma DEFINITIVA (`FAILED`).
   * Mutável em runtime via `definirModoCaptura()`.
   */
  modoCaptura?: 'NORMAL' | 'PENDENTE' | 'NEGADA'
  /**
   * Como `cancelar()` se comporta (C2.3, F19) — para provar que o estado do intent só muda com cancelamento CONFIRMADO:
   *  - `NORMAL` (default): cancelou (Status 10, `ReturnCode` 0);
   *  - `ESTORNO`: depois de 23h59 a Cielo estorna (Status 11, `ReturnCode` 9) — confirmado, `reversao: 'REFUNDED'`;
   *  - `EM_ANDAMENTO`: já existe um cancelamento andando (`ReturnCode` 476) — nem sucesso nem recusa;
   *  - `RECUSADO`: recusa definitiva (`ReturnCode` 41, status não permite);
   *  - `INDEFINIDO`: resposta que não sabemos ler.
   * Em qualquer modo diferente de NORMAL/ESTORNO o pagamento simulado NÃO é cancelado. Mutável em runtime via `definirModoCancelamento()`.
   */
  modoCancelamento?: 'NORMAL' | 'ESTORNO' | 'EM_ANDAMENTO' | 'RECUSADO' | 'INDEFINIDO'
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
  /** `Tid`/`AuthorizationCode`/`ProofOfSale` simulados (C2.5) — nascem na autorização e são devolvidos de novo na captura. */
  identificadores: IdentificadoresAdquirente
  /** Captura aceita mas ainda em processamento (modo PENDENTE): `consultar()` devolve CREATED enquanto isto existir. */
  capturaPendenteCents?: number
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
  private readonly capturasSolicitadas = new Map<string, number>()
  private modoCaptura: 'NORMAL' | 'PENDENTE' | 'NEGADA'
  private modoCancelamento: 'NORMAL' | 'ESTORNO' | 'EM_ANDAMENTO' | 'RECUSADO' | 'INDEFINIDO'
  private readonly cancelamentosSolicitados = new Map<string, number>()

  constructor(private readonly options: FakeAdapterOptions = {}) {
    this.modoCaptura = options.modoCaptura ?? 'NORMAL'
    this.modoCancelamento = options.modoCancelamento ?? 'NORMAL'
  }

  /** Só de teste: muda como os PRÓXIMOS cancelamentos se comportam (ver `FakeAdapterOptions.modoCancelamento`). */
  definirModoCancelamento(modo: 'NORMAL' | 'ESTORNO' | 'EM_ANDAMENTO' | 'RECUSADO' | 'INDEFINIDO'): void {
    this.modoCancelamento = modo
  }

  /** Só de teste: quantas vezes `cancelar()` foi CHAMADO para este pagamento. */
  contagemCancelar(providerPaymentId: string): number {
    return this.cancelamentosSolicitados.get(providerPaymentId) ?? 0
  }

  /** Só de teste: muda como as PRÓXIMAS capturas se comportam (ver `FakeAdapterOptions.modoCaptura`). */
  definirModoCaptura(modo: 'NORMAL' | 'PENDENTE' | 'NEGADA'): void {
    this.modoCaptura = modo
  }

  /** Só de teste: quantas vezes `capturar()` foi CHAMADO para este pagamento — a prova de que nunca se captura 2x. */
  contagemCapturar(providerPaymentId: string): number {
    return this.capturasSolicitadas.get(providerPaymentId) ?? 0
  }

  /** Só de teste: a Cielo concluiu a captura que estava pendente — depois disto `consultar()` devolve CAPTURED. */
  concluirCapturaPendente(providerPaymentId: string): void {
    const intent = this.exigirIntent(providerPaymentId)
    if (intent.capturaPendenteCents === undefined) throw new Error(`FakeAdapter.concluirCapturaPendente: ${providerPaymentId} não tem captura pendente`)
    intent.status = 'CAPTURED'
    intent.amountCapturedCents = intent.capturaPendenteCents
    intent.returnCode = '6'
    delete intent.capturaPendenteCents
  }

  private proximoId(): string {
    // Achado real da Íris (F5.2, 30/09/2026): o default aqui documentava
    // `crypto.randomUUID()` (comentário acima) mas gerava
    // `fake-payment-${contador}` sequencial de verdade — `cieloPaymentId` é
    // UNIQUE no banco, então dois `FakeAdapter` sem `gerarId` customizado
    // (arquivos de teste diferentes, ou duas execuções sucessivas contra o
    // mesmo Postgres persistente) colidiam no mesmo `fake-payment-1`.
    // Reproduzido em 4 de 5 rodadas da suíte. `randomUUID()` é o default de
    // verdade agora — passe `gerarId` só quando o teste precisar de um ID
    // PREVISÍVEL para asserção.
    return this.options.gerarId?.() ?? crypto.randomUUID()
  }

  async autorizar(pedido: PedidoAutorizacaoCartao): Promise<ResultadoAutorizacao> {
    const negado = this.options.cardTokensNegados?.includes(pedido.cartao.cardToken) ?? false
    const providerPaymentId = this.proximoId()

    const sufixo = providerPaymentId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase()
    const identificadores: IdentificadoresAdquirente = negado
      ? { tid: `FAKETID${sufixo}`, authorizationCode: null, proofOfSale: null } // negada: tem Tid, não tem código de autorização
      : { tid: `FAKETID${sufixo}`, authorizationCode: `A${sufixo.slice(0, 5)}`, proofOfSale: `P${sufixo.slice(0, 6)}` }
    const intent: IntentSimulado = negado
      ? { providerPaymentId, merchantOrderId: pedido.merchantOrderId, status: 'FAILED', returnCode: '2', amountAuthorizedCents: null, amountCapturedCents: null, identificadores }
      : { providerPaymentId, merchantOrderId: pedido.merchantOrderId, status: 'AUTHORIZED', returnCode: '00', amountAuthorizedCents: pedido.amountRequestedCents, amountCapturedCents: null, identificadores }

    this.intents.set(providerPaymentId, intent)
    this.porMerchantOrderId.set(pedido.merchantOrderId, providerPaymentId)

    return { providerPaymentId, status: intent.status, returnCode: intent.returnCode, amountAuthorizedCents: intent.amountAuthorizedCents, identificadores: intent.identificadores }
  }

  async capturar(providerPaymentId: string, amountCents: number): Promise<ResultadoCaptura> {
    const intent = this.exigirIntent(providerPaymentId)
    if (intent.status !== 'AUTHORIZED') {
      throw new Error(`FakeAdapter.capturar: intent ${providerPaymentId} está em ${intent.status}, esperado AUTHORIZED`)
    }
    this.capturasSolicitadas.set(providerPaymentId, this.contagemCapturar(providerPaymentId) + 1)
    if (this.modoCaptura === 'PENDENTE') {
      intent.capturaPendenteCents = amountCents
      return { providerPaymentId, status: 'CREATED', returnCode: null, amountCapturedCents: null, identificadores: SEM_IDENTIFICADORES_ADQUIRENTE }
    }
    if (this.modoCaptura === 'NEGADA') {
      intent.status = 'FAILED'
      intent.returnCode = '57'
      return { providerPaymentId, status: 'FAILED', returnCode: intent.returnCode, amountCapturedCents: null, identificadores: SEM_IDENTIFICADORES_ADQUIRENTE }
    }
    intent.status = 'CAPTURED'
    intent.amountCapturedCents = amountCents
    intent.returnCode = '6'
    return { providerPaymentId, status: intent.status, returnCode: intent.returnCode, amountCapturedCents: intent.amountCapturedCents, identificadores: intent.identificadores }
  }

  async cancelar(providerPaymentId: string): Promise<ResultadoCancelamento> {
    const intent = this.exigirIntent(providerPaymentId)
    this.cancelamentosSolicitados.set(providerPaymentId, this.contagemCancelar(providerPaymentId) + 1)
    switch (this.modoCancelamento) {
      case 'NORMAL':
        intent.status = 'VOIDED'
        return { providerPaymentId, status: 'VOIDED', returnCode: '0', desfecho: 'CONFIRMADO', reversao: 'VOIDED', restricaoCadastral: false }
      case 'ESTORNO':
        intent.status = 'VOIDED'
        return { providerPaymentId, status: 'VOIDED', returnCode: '9', desfecho: 'CONFIRMADO', reversao: 'REFUNDED', restricaoCadastral: false }
      case 'EM_ANDAMENTO':
        return { providerPaymentId, status: 'AUTHORIZED', returnCode: '476', desfecho: 'EM_ANDAMENTO', reversao: null, restricaoCadastral: false }
      case 'RECUSADO':
        return { providerPaymentId, status: 'FAILED', returnCode: '41', desfecho: 'RECUSADO', reversao: null, restricaoCadastral: false }
      case 'INDEFINIDO':
        return { providerPaymentId, status: 'AUTHORIZED', returnCode: null, desfecho: 'INDEFINIDO', reversao: null, restricaoCadastral: false }
    }
  }

  async consultar(providerPaymentId: string): Promise<ResultadoConsultaPagamento> {
    const intent = this.exigirIntent(providerPaymentId)
    return {
      providerPaymentId: intent.providerPaymentId,
      merchantOrderId: intent.merchantOrderId,
      status: intent.capturaPendenteCents !== undefined ? 'CREATED' : intent.status,
      returnCode: intent.returnCode,
      amountAuthorizedCents: intent.amountAuthorizedCents,
      amountCapturedCents: intent.amountCapturedCents,
      identificadores: intent.identificadores,
    }
  }

  async consultarPorPedido(merchantOrderId: string): Promise<ResultadoConsultaPagamento | null> {
    const providerPaymentId = this.porMerchantOrderId.get(merchantOrderId)
    if (!providerPaymentId) return null
    return this.consultar(providerPaymentId)
  }

  async criarPix(pedido: PedidoPix): Promise<ResultadoPix> {
    const providerPaymentId = this.proximoId()
    const expiresInSeconds = expiracaoPixEfetivaSegundos(pedido.expiresInSeconds) // mesma conta do adaptador real (teto de 24 h da Cielo)

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

  /**
   * `scriptUrl` PRECISA conter o marcador `mock-sop` — é o que
   * `frontend/src/pagamento-cartao/sopClient.ts` (Lyra) usa para decidir
   * "tokenizar local, nunca bater em rede" em vez de tentar carregar um
   * script real da Cielo que não existe em dev/CI. Achado coordenando com o
   * trabalho em paralelo da Lyra (F5.3, 30/09/2026) — sem isto, a página
   * isolada dela tentaria (e falharia) carregar `session.scriptUrl` de
   * verdade sempre que o backend cair no `FakeAdapter` (todo ambiente sem
   * credencial Cielo real, inclusive CI).
   */
  async sessaoTokenizacao(_cliente?: DadosCliente): Promise<SessaoTokenizacao> {
    return {
      accessToken: `fake-access-token-${this.proximoId()}`,
      merchantId: 'fake-merchant-id',
      environment: 'sandbox',
      scriptUrl: 'https://fake.local/mock-sop/script.js',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    }
  }

  /**
   * Determinístico (mesmo `cardToken` -> mesmos dados) — `cardTokensInvalidos`
   * simula `GET /1/card/{token}` 404. Reconhece o formato `mocktok.*` que o
   * `tokenizeCardMock` da Lyra gera (`pagamento-cartao/sopClient.ts`) e
   * decodifica last4/validade/nome de volta — SEM isso, o `FakeAdapter`
   * devolveria dados genéricos desconectados do que o motorista "digitou" no
   * formulário mock, e um teste ponta a ponta (Íris) não conseguiria
   * verificar que o cartão certo foi salvo. Token qualquer fora desse
   * formato (ex. testes deste próprio arquivo) cai no fallback genérico.
   */
  async consultarCartaoTokenizado(cardToken: string): Promise<ResultadoConsultaCartao> {
    if (this.options.cardTokensInvalidos?.includes(cardToken)) {
      throw new CartaoTokenInvalidoError(cardToken.length > 4 ? `***${cardToken.slice(-4)}` : '***')
    }
    const mock = parseMockCardToken(cardToken)
    if (mock) {
      // `brand: null` de propósito — o mock NÃO embute bandeira (ela é
      // detectada pelo BIN no próprio documento isolado, ver
      // `pagamento-cartao/cardBrand.ts`); a rota usa o `brand` que o
      // cliente mandou quando a consulta não devolve um (ver `cieloAdapter.ts`).
      return { cardToken, brand: null, last4: mock.last4, holderName: mock.holderName || null, expiryMonth: mock.expiryMonth, expiryYear: mock.expiryYear }
    }
    const last4 = cardToken.replace(/\D/g, '').slice(-4).padStart(4, '0')
    return { cardToken, brand: 'Visa', last4, holderName: 'MOTORISTA TESTE', expiryMonth: 12, expiryYear: 2030 }
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

/**
 * Decodifica `mocktok.{last4}.{MMYYYY}.{holderB64}.{timestamp}{seq}` — MESMO
 * formato que `tokenizeCardMock` (Lyra, `pagamento-cartao/sopClient.ts`)
 * gera no navegador. `Buffer.from(holderB64, 'base64').toString('utf8')`
 * decodifica direto (o `btoa(unescape(encodeURIComponent(...)))` do lado do
 * browser existe só porque `btoa` nativo do navegador só aceita Latin1 —
 * `Buffer` do Node já lida com UTF-8 sem essa dança). Devolve `null` para
 * qualquer coisa que não bata no formato exato — NUNCA lança (chamado antes
 * de decidir se o token é "mock" ou um CardToken normal).
 */
function parseMockCardToken(cardToken: string): { last4: string; expiryMonth: number; expiryYear: number; holderName: string } | null {
  if (!cardToken.startsWith('mocktok.')) return null
  const parts = cardToken.split('.')
  if (parts.length < 4) return null
  const [, last4, mmYYYY, holderB64] = parts
  if (!/^\d{4}$/.test(last4) || !/^\d{6}$/.test(mmYYYY)) return null
  const expiryMonth = Number(mmYYYY.slice(0, 2))
  const expiryYear = Number(mmYYYY.slice(2))
  if (expiryMonth < 1 || expiryMonth > 12) return null
  let holderName = ''
  try {
    holderName = Buffer.from(holderB64, 'base64').toString('utf8')
  } catch {
    holderName = ''
  }
  return { last4, expiryMonth, expiryYear, holderName }
}
