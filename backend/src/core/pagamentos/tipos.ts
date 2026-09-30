/**
 * Tipos de domínio da F5 (pagamento real — Cielo). Núcleo PURO (sem Prisma,
 * sem HTTP — ver `eslint.config.mjs`, bloco `src/core/**`).
 *
 * Desenho: .claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md
 * (item 1 — a porta é do GATEWAY, não de "reservar/liquidar" como a
 * carteira) e .claude/agent-memory/nova/cielo-fatos-verificados.md.
 *
 * IMPORTANTE — status de domínio aqui NÃO são os mesmos valores do enum
 * `PaymentIntentStatus` do Prisma (`prisma/schema.prisma`, de propriedade do
 * Cronos, em mudança em paralelo a esta tarefa). Motivo: o enum do banco só
 * tem CREATED/AUTHORIZED/CAPTURE_PENDING/CAPTURED/CANCELLED/DENIED/VOIDED/
 * FAILED/EXPIRED — não existe `PENDING` nem `PAID` (que o fluxo Pix
 * precisa). Este módulo modela os DOIS fluxos (cartão e Pix) com o
 * vocabulário mais fiel ao domínio; a camada de serviço (F5.2, que grava no
 * Postgres) é responsável por projetar estes estados no enum do Prisma —
 * ver `GAP` no handoff desta tarefa para a proposta de mapeamento.
 */

/** Estado do fluxo de CARTÃO (pré-autorização + captura, ver fato #1 da Cielo: captura parcial única). */
export type CardPaymentStatus = 'CREATED' | 'AUTHORIZED' | 'CAPTURE_PENDING' | 'CAPTURED' | 'FAILED' | 'VOIDED'

/** Estado do fluxo PIX (sem reserva — carteira pré-paga, ver fato #2 da Cielo). */
export type PixPaymentStatus = 'CREATED' | 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED'

export function isTerminalCardStatus(status: CardPaymentStatus): boolean {
  return status === 'CAPTURED' || status === 'FAILED' || status === 'VOIDED'
}

export function isTerminalPixStatus(status: PixPaymentStatus): boolean {
  return status === 'PAID' || status === 'EXPIRED' || status === 'FAILED'
}

/**
 * Dados de um cartão TOKENIZADO — nunca PAN/CVV crus (regra dura da tarefa,
 * SAQ A-EP via Silent Order Post: o número não passa pelo nosso backend).
 * `cardToken` é o `CardToken` PERMANENTE do cofre "Cartão Protegido" da
 * Cielo (`enableTokenize: true` no SOP) — ver fato de 30/09/2026.
 */
export interface CartaoTokenizado {
  cardToken: string
  brand?: string | null
  last4?: string | null
  holderName?: string | null
}

export interface DadosCliente {
  name: string
  /** CPF — dado sensível; NUNCA logar em claro (ver redact do logger). */
  identity?: string | null
}

/** Pedido de pré-autorização de cartão — nasce na API, ANTES do RemoteStart (decisão #2 da Nova). */
export interface PedidoAutorizacaoCartao {
  /** = `PaymentIntent.id` — usado como `MerchantOrderId` na Cielo (não há chave de idempotência na API 3.0; ver fato #Cielo). */
  merchantOrderId: string
  amountRequestedCents: number
  cartao: CartaoTokenizado
  cliente: DadosCliente
  /** Texto que aparece na fatura do cartão do motorista. */
  softDescriptor?: string
}

export interface PedidoPix {
  merchantOrderId: string
  amountRequestedCents: number
  cliente: DadosCliente
  /** Segundos até expirar o QR — default 86400 (fato da Cielo: não há aviso de expiração, quem expira somos nós). */
  expiresInSeconds?: number
}
