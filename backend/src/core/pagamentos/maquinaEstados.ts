import type { CardPaymentStatus, PixPaymentStatus } from './tipos'

/**
 * Máquinas de estado de `PaymentIntent` — PURAS (sem I/O), um reducer
 * `(estadoAtual, evento) -> novoEstado | erro`. Quem chama decide o que fazer
 * com o resultado (persistir, logar, disparar próximo passo); esta função
 * só sabe se a transição é válida.
 *
 * Fluxo cartão: CREATED -> AUTHORIZED -> CAPTURE_PENDING -> CAPTURED
 *                                     \-> VOIDED           \-> FAILED
 *               CREATED -> FAILED (autorização negada/erro)
 * (captura parcial é decisão de VALOR, não de estado — `amountCapturedCents`
 *  fica em CAPTURED de qualquer forma; ver fato #1 da Cielo.)
 *
 * Fluxo Pix:    CREATED -> PENDING -> PAID
 *                                  \-> EXPIRED
 *                                  \-> FAILED
 *               CREATED -> FAILED (erro ao gerar o QR)
 */

export type CardPaymentEventType = 'AUTHORIZED' | 'AUTHORIZATION_DENIED' | 'AUTHORIZATION_FAILED' | 'CAPTURE_REQUESTED' | 'CAPTURED' | 'CAPTURE_FAILED' | 'VOIDED'

export type PixPaymentEventType = 'QR_GENERATED' | 'GENERATION_FAILED' | 'PAID' | 'EXPIRED' | 'FAILED'

export interface TransicaoResultado<TStatus> {
  ok: boolean
  estado: TStatus
  /** Presente só quando `ok === false` — motivo para log/erro estruturado do chamador. */
  motivo?: string
}

const CARD_TRANSITIONS: Record<CardPaymentStatus, Partial<Record<CardPaymentEventType, CardPaymentStatus>>> = {
  CREATED: {
    AUTHORIZED: 'AUTHORIZED',
    AUTHORIZATION_DENIED: 'FAILED',
    AUTHORIZATION_FAILED: 'FAILED',
  },
  AUTHORIZED: {
    CAPTURE_REQUESTED: 'CAPTURE_PENDING',
    VOIDED: 'VOIDED',
  },
  CAPTURE_PENDING: {
    CAPTURED: 'CAPTURED',
    CAPTURE_FAILED: 'FAILED',
  },
  CAPTURED: {},
  FAILED: {},
  VOIDED: {},
}

const PIX_TRANSITIONS: Record<PixPaymentStatus, Partial<Record<PixPaymentEventType, PixPaymentStatus>>> = {
  CREATED: {
    QR_GENERATED: 'PENDING',
    GENERATION_FAILED: 'FAILED',
  },
  PENDING: {
    PAID: 'PAID',
    EXPIRED: 'EXPIRED',
    FAILED: 'FAILED',
  },
  PAID: {},
  EXPIRED: {},
  FAILED: {},
}

export function transicionarCartao(estadoAtual: CardPaymentStatus, evento: CardPaymentEventType): TransicaoResultado<CardPaymentStatus> {
  const destino = CARD_TRANSITIONS[estadoAtual][evento]
  if (!destino) {
    return { ok: false, estado: estadoAtual, motivo: `transição de cartão inválida: ${estadoAtual} -(${evento})-> ?` }
  }
  return { ok: true, estado: destino }
}

export function transicionarPix(estadoAtual: PixPaymentStatus, evento: PixPaymentEventType): TransicaoResultado<PixPaymentStatus> {
  const destino = PIX_TRANSITIONS[estadoAtual][evento]
  if (!destino) {
    return { ok: false, estado: estadoAtual, motivo: `transição de Pix inválida: ${estadoAtual} -(${evento})-> ?` }
  }
  return { ok: true, estado: destino }
}
