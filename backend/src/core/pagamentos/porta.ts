import type { CardPaymentStatus, DadosCliente, PedidoAutorizacaoCartao, PedidoPix, PixPaymentStatus } from './tipos'

/**
 * `PagamentoPort` — a porta é do GATEWAY (Cielo), não de "reservar/
 * liquidar/desfazer" como a carteira (decisão #1 da Nova,
 * `decisoes-f5-pagamento-cielo.md`). A carteira continua sendo o razão
 * (`services/carteira/walletLedger.ts`) e não implementa esta porta.
 *
 * Dois adaptadores nesta etapa (F5.1):
 *   - `services/pagamentos/cieloAdapter.ts`  — Cielo de verdade (sandbox/prod por env)
 *   - `services/pagamentos/fakeAdapter.ts`   — em memória, para os outros times testarem sem bater na Cielo
 *
 * F5.2/F5.3/F5.4 (próxima rodada) plugam esta porta:
 *   - `autorizar`          -> dentro de `POST /api/me/sessions/start`, ANTES do RemoteStart (decisão #2 da Nova)
 *   - `capturar`           -> worker, disparado por `finalizarSessao` marcando CAPTURE_PENDING
 *   - `criarPix`/`consultar` -> rota de recarga de carteira (WALLET_TOPUP_PIX)
 *   - `consultarPorPedido` -> reconciliação após timeout (API 3.0 não tem chave de idempotência — SEMPRE consultar por MerchantOrderId antes de repetir uma chamada que deu timeout)
 *   - `sessaoTokenizacao`  -> rota que devolve ao frontend os dados para o Silent Order Post (D1: cartão salvo, SAQ A-EP)
 */

export interface ResultadoAutorizacao {
  /** = `PaymentId` da Cielo (`PaymentIntent.cieloPaymentId`). */
  providerPaymentId: string
  status: CardPaymentStatus
  /** `ReturnCode` cru da Cielo — guardar para auditoria/suporte, nunca para decidir sozinho (ver normalizador). */
  returnCode: string | null
  amountAuthorizedCents: number | null
}

export interface ResultadoCaptura {
  providerPaymentId: string
  status: CardPaymentStatus
  returnCode: string | null
  amountCapturedCents: number | null
}

export interface ResultadoCancelamento {
  providerPaymentId: string
  status: CardPaymentStatus
  returnCode: string | null
}

export interface ResultadoConsultaPagamento {
  providerPaymentId: string
  merchantOrderId: string
  status: CardPaymentStatus
  returnCode: string | null
  amountAuthorizedCents: number | null
  amountCapturedCents: number | null
}

export interface ResultadoPix {
  providerPaymentId: string
  merchantOrderId: string
  status: PixPaymentStatus
  qrCodeString: string
  qrCodeBase64Image?: string | null
  expiresAt: Date
}

/**
 * Consulta de um pagamento PIX — GAP achado na F5.2 (Vega, 2026-09-30):
 * `consultar()`/`consultarPorPedido()` abaixo só existiam para CARTÃO
 * (devolvem `CardPaymentStatus`, normalizados por
 * `normalizarStatusCartaoCielo`). Reconsultar um pagamento Pix por ali
 * interpretaria `Status=2 PaymentConfirmed` como `CAPTURED` (vocabulário de
 * cartão) em vez de `PAID` — bug silencioso. `consultarPix` usa o
 * normalizador PRÓPRIO do Pix (`normalizarStatusPixCielo`) — mesmo endpoint
 * HTTP da Cielo (`GET /1/sales/{PaymentId}`), leitura diferente.
 */
export interface ResultadoConsultaPix {
  providerPaymentId: string
  merchantOrderId: string
  status: PixPaymentStatus
  returnCode: string | null
  /** Valor efetivamente pago, quando a Cielo devolve — `null` se ainda não há confirmação. */
  amountCents: number | null
}

/**
 * Dados para a página ISOLADA da Lyra (F5.3, D1: cartão salvo/SAQ A-EP)
 * carregar o script do Silent Order Post da Cielo e tokenizar o cartão DIRETO
 * no navegador do motorista — o número nunca passa pelo nosso backend.
 *
 * `accessToken` é o `AccessToken` do SOP (C1.1): resultado de DOIS passos no servidor — OAuth2 na Braspag (`client_credentials` com o par
 * `sopClientId`/`sopClientSecret`) e depois `POST .../post/api/public/v2/accesstoken` (Bearer do passo 1 + `MerchantId`). NÃO é o token OAuth
 * do passo 1. Ver `services/pagamentos/cieloSopOAuth.ts`.
 */
export interface SessaoTokenizacao {
  accessToken: string
  merchantId: string
  environment: 'sandbox' | 'production'
  /** URL do script da Cielo que a página isolada carrega (`<script src>`) — NÃO é o endpoint de POST do formulário (esse é detalhe interno do próprio script). */
  scriptUrl: string
  expiresAt: Date
}

/**
 * Dados devolvidos pela Cielo ao consultar um CardToken do cofre "Cartão
 * Protegido" (`GET /1/card/{token}`) — usado para VALIDAR o token recebido
 * do frontend antes de gravar `PaymentMethod` (F5.3) e para obter dados que o
 * frontend não manda (`last4`, validade, nome do portador). Formato da
 * resposta NÃO confirmado contra sandbox real nesta tarefa (sem credencial —
 * ver `.claude/agent-memory/nova/cielo-fatos-verificados.md`, "ainda não
 * confirmado: GET /1/card/{token} devolver bandeira/final").
 */
export interface ResultadoConsultaCartao {
  cardToken: string
  brand: string | null
  last4: string | null
  holderName: string | null
  expiryMonth: number | null
  expiryYear: number | null
}

export interface PagamentoPort {
  autorizar(pedido: PedidoAutorizacaoCartao): Promise<ResultadoAutorizacao>
  /**
   * `providerPaymentId` = `PaymentIntent.cieloPaymentId` (o `PaymentId` que a
   * Cielo devolveu no `autorizar`), NÃO o `PaymentIntent.id` nosso — mapear
   * um para o outro é responsabilidade de quem chama a porta (tem Prisma;
   * `core/` não tem). Único método que usa o NOSSO id é `consultarPorPedido`,
   * porque é exatamente o caso em que ainda não temos certeza de ter
   * recebido o `PaymentId` da Cielo (timeout no `autorizar`/`capturar`).
   */
  capturar(providerPaymentId: string, amountCents: number): Promise<ResultadoCaptura>
  cancelar(providerPaymentId: string): Promise<ResultadoCancelamento>
  consultar(providerPaymentId: string): Promise<ResultadoConsultaPagamento>
  /** Reconciliação pós-timeout (fato da Cielo: API 3.0 não tem chave de idempotência) — busca por `merchantOrderId` = `PaymentIntent.id`. */
  consultarPorPedido(merchantOrderId: string): Promise<ResultadoConsultaPagamento | null>
  criarPix(pedido: PedidoPix): Promise<ResultadoPix>
  /** Reconsulta OBRIGATÓRIA antes de creditar (webhook nunca é verdade, ver decisão §3 da Nova) — usa `providerPaymentId` = `PaymentIntent.cieloPaymentId`. */
  consultarPix(providerPaymentId: string): Promise<ResultadoConsultaPix>
  /** Async (F5.3): monta um `accessToken` de sessão para a página isolada de tokenização — pode exigir chamada de rede (OAuth), diferente de F5.1 (síncrono). */
  sessaoTokenizacao(cliente?: DadosCliente): Promise<SessaoTokenizacao>
  /** Valida + consulta um CardToken do cofre "Cartão Protegido" — lança `CartaoTokenInvalidoError` (`core/pagamentos/erros.ts`) se o token for desconhecido/inválido na Cielo. */
  consultarCartaoTokenizado(cardToken: string): Promise<ResultadoConsultaCartao>
}
