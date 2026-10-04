import type { PedidoAutorizacaoCartao, PedidoPix } from '../../core/pagamentos/tipos'
import type { RespostaPagamentoCielo } from '../../core/pagamentos/normalizarStatusCielo'
import { expiracaoPixEfetivaSegundos } from '../../core/pagamentos/expiracaoPix'

/**
 * Mapeamento LITERAL do formato de fio (wire format) da API 3.0 da Cielo —
 * `PedidoAutorizacaoCartao`/`PedidoPix` (domínio, `core/pagamentos/tipos.ts`)
 * para cá, resposta da Cielo para cá. Fica em `services/` (não em `core/`)
 * de propósito: é vocabulário da Cielo, não vocabulário do nosso domínio —
 * ver decisão #1/#3 da Nova (não vazar o vocabulário do provedor).
 *
 * ⚠️ Os payloads de CARTÃO foram conferidos contra a documentação oficial
 * (campos e formato — ver `.claude/agent-memory/nova/cielo-fatos-verificados.md`).
 * O payload de PIX segue a doc oficial "cielo2-gerar-qr-code-pix" (`POST /1/sales`, `Payment.QrCode.Expiration`; C1.5) e a Cielo2 NÃO tem
 * sandbox (fato confirmado): nenhuma resposta real foi vista — a prova é em produção, com valor baixo.
 */

export interface CieloSalePayload {
  MerchantOrderId: string
  Customer: { Name: string; Identity?: string; IdentityType?: 'CPF' }
  Payment: {
    Type: 'CreditCard'
    Amount: number
    Installments: 1
    Capture: false
    SoftDescriptor?: string
    CreditCard: { CardToken: string; SaveCard: false; Brand?: string }
  }
}

export function montarPayloadAutorizacaoCartao(pedido: PedidoAutorizacaoCartao): CieloSalePayload {
  return {
    MerchantOrderId: pedido.merchantOrderId,
    Customer: {
      Name: pedido.cliente.name,
      ...(pedido.cliente.identity ? { Identity: pedido.cliente.identity, IdentityType: 'CPF' } : {}),
    },
    Payment: {
      Type: 'CreditCard',
      Amount: pedido.amountRequestedCents,
      Installments: 1,
      // Pré-autorização — captura é sempre um passo separado (decisão #2 da Nova).
      Capture: false,
      ...(pedido.softDescriptor ? { SoftDescriptor: pedido.softDescriptor } : {}),
      CreditCard: {
        CardToken: pedido.cartao.cardToken,
        // Já é um CardToken permanente do cofre — não pedimos pra Cielo tokenizar de novo.
        SaveCard: false,
        ...(pedido.cartao.brand ? { Brand: pedido.cartao.brand } : {}),
      },
    },
  }
}

export interface CieloPixPayload {
  MerchantOrderId: string
  Customer: { Name: string; Identity?: string; IdentityType?: 'CPF' }
  Payment: {
    Type: 'Pix'
    Amount: number
    Provider: 'Cielo2'
    // C1.5 (B3): o campo é `Payment.QrCode.Expiration` (objeto aninhado), em SEGUNDOS, máximo 86400 (24 h) — não `Payment.QrCodeExpiration`.
    QrCode: { Expiration: number }
  }
}

export function montarPayloadPix(pedido: PedidoPix): CieloPixPayload {
  return {
    MerchantOrderId: pedido.merchantOrderId,
    Customer: {
      Name: pedido.cliente.name,
      ...(pedido.cliente.identity ? { Identity: pedido.cliente.identity, IdentityType: 'CPF' } : {}),
    },
    Payment: {
      Type: 'Pix',
      Amount: pedido.amountRequestedCents,
      Provider: 'Cielo2',
      // Acima do máximo a Cielo recusaria a cobrança inteira; abaixo de 1 s não faz sentido. Inteiro, como o campo exige.
      QrCode: { Expiration: expiracaoPixEfetivaSegundos(pedido.expiresInSeconds) },
    },
  }
}

/**
 * A Cielo devolve o objeto de pagamento de duas formas diferentes dependendo
 * do endpoint: `POST /1/sales` devolve `{ MerchantOrderId, Payment: {...} }`
 * (aninhado); `PUT .../capture` e `PUT .../void` devolvem o objeto de
 * pagamento DIRETO (achatado). `extrairCamposPagamento` aceita as duas
 * formas para o resto do adaptador não precisar saber qual endpoint gerou a
 * resposta.
 */
export interface CamposPagamentoCielo extends RespostaPagamentoCielo {
  paymentId: string | null
  merchantOrderId: string | null
  amountAuthorizedCents: number | null
  amountCapturedCents: number | null
}

export function extrairCamposPagamento(body: unknown): CamposPagamentoCielo {
  const raw = body as Record<string, unknown> | null | undefined
  const payment = (raw?.Payment as Record<string, unknown> | undefined) ?? raw ?? {}

  const status = typeof payment.Status === 'number' ? payment.Status : -1
  const returnCode = typeof payment.ReturnCode === 'string' ? payment.ReturnCode : payment.ReturnCode != null ? String(payment.ReturnCode) : null
  const paymentId = typeof payment.PaymentId === 'string' ? payment.PaymentId : null
  const merchantOrderId = typeof raw?.MerchantOrderId === 'string' ? (raw!.MerchantOrderId as string) : null
  const amountAuthorizedCents = typeof payment.Amount === 'number' ? payment.Amount : null
  const amountCapturedCents = typeof payment.CapturedAmount === 'number' ? payment.CapturedAmount : null

  return { status, returnCode, paymentId, merchantOrderId, amountAuthorizedCents, amountCapturedCents }
}

/** `GET /1/sales?merchantOrderId=` devolve `{ MerchantOrderId, Payments: [...] }` — pega o pagamento mais recente. */
export function extrairPagamentoMaisRecenteDaConsulta(body: unknown): CamposPagamentoCielo | null {
  const raw = body as { MerchantOrderId?: unknown; Payments?: unknown[] } | null | undefined
  const payments = raw?.Payments
  if (!Array.isArray(payments) || payments.length === 0) return null
  const ultimo = payments[payments.length - 1] as Record<string, unknown>
  return extrairCamposPagamento({ MerchantOrderId: raw?.MerchantOrderId, Payment: ultimo })
}
