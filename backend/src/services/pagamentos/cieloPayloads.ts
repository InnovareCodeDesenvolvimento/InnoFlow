import type { PedidoAutorizacaoCartao, PedidoPix } from '../../core/pagamentos/tipos'
import type { RespostaPagamentoCielo } from '../../core/pagamentos/normalizarStatusCielo'
import { expiracaoPixEfetivaSegundos } from '../../core/pagamentos/expiracaoPix'
import { normalizarIdentificadorAdquirente, type IdentificadoresAdquirente } from '../../core/pagamentos/identificadoresAdquirente'
import { higienizarSoftDescriptor } from '../../core/pagamentos/softDescriptor'

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
      // F21: só A-Z0-9, até 13 — um caractere especial faz a Cielo recusar a transação inteira. Vazio depois de higienizar = o campo não vai.
      ...(higienizarSoftDescriptor(pedido.softDescriptor) ? { SoftDescriptor: higienizarSoftDescriptor(pedido.softDescriptor)! } : {}),
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
  /** `Tid`/`AuthorizationCode`/`ProofOfSale` já normalizados (vazio -> null; > 64 -> truncado). */
  identificadores: IdentificadoresAdquirente
  /** Nomes (nunca valores) dos identificadores que passaram de 64 caracteres e foram truncados — o adaptador avisa no log. */
  identificadoresTruncados: string[]
  /** `ReceivedDate` da venda (ms desde a época; `null` se ausente/ilegível). Serve para escolher entre vendas do mesmo `MerchantOrderId`. */
  receivedDateMs: number | null
}

/**
 * A Cielo escreve `ReceveidDate` (sic) na lista de `GET /1/sales?merchantOrderId=` e `ReceivedDate` na venda. Aceita os dois. O formato é `YYYY-MM-DD HH:mm:ss`
 * sem fuso: serve para COMPARAR entre vendas da mesma resposta (mesmo formato/fuso), não como instante absoluto.
 */
export function lerDataCielo(bruto: unknown): number | null {
  if (typeof bruto !== 'string' || bruto.trim() === '') return null
  const ms = Date.parse(bruto.trim().replace(' ', 'T'))
  return Number.isFinite(ms) ? ms : null
}

/**
 * `Status` da Cielo como inteiro: aceita número inteiro OU texto numérico ("1", " 2 ") como o Parque (`statusComoNumero`); qualquer outra coisa (ausente, decimal, texto, NaN) é -1 = "sem Status"
 * (não conclusivo, nunca aprovação). Antes só `number` valia e `"1"` virava CREATED.
 */
export function lerStatusCielo(bruto: unknown): number {
  if (typeof bruto === 'number') return Number.isInteger(bruto) && bruto >= 0 ? bruto : -1
  if (typeof bruto === 'string' && /^[0-9]{1,3}$/.test(bruto.trim())) return Number(bruto.trim())
  return -1
}

export function extrairCamposPagamento(body: unknown): CamposPagamentoCielo {
  const raw = body as Record<string, unknown> | null | undefined
  const payment = (raw?.Payment as Record<string, unknown> | undefined) ?? raw ?? {}

  const status = lerStatusCielo(payment.Status)
  const returnCode = typeof payment.ReturnCode === 'string' ? payment.ReturnCode : payment.ReturnCode != null ? String(payment.ReturnCode) : null
  const paymentId = typeof payment.PaymentId === 'string' ? payment.PaymentId : null
  const merchantOrderId = typeof raw?.MerchantOrderId === 'string' ? (raw!.MerchantOrderId as string) : null
  const amountAuthorizedCents = typeof payment.Amount === 'number' ? payment.Amount : null
  const amountCapturedCents = typeof payment.CapturedAmount === 'number' ? payment.CapturedAmount : null

  const tid = normalizarIdentificadorAdquirente(payment.Tid)
  const authorizationCode = normalizarIdentificadorAdquirente(payment.AuthorizationCode)
  const proofOfSale = normalizarIdentificadorAdquirente(payment.ProofOfSale)
  const identificadoresTruncados = [tid.truncado ? 'Tid' : null, authorizationCode.truncado ? 'AuthorizationCode' : null, proofOfSale.truncado ? 'ProofOfSale' : null].filter((n): n is string => n !== null)

  return {
    status,
    returnCode,
    paymentId,
    merchantOrderId,
    amountAuthorizedCents,
    amountCapturedCents,
    identificadores: { tid: tid.valor, authorizationCode: authorizationCode.valor, proofOfSale: proofOfSale.valor },
    identificadoresTruncados,
    receivedDateMs: lerDataCielo(payment.ReceivedDate ?? payment.ReceveidDate),
  }
}

/** Uma venda listada por `GET /1/sales?merchantOrderId=`. */
export interface EntradaDaListaPorPedido {
  paymentId: string | null
  receivedDateMs: number | null
  /** Só quando a entrada JÁ traz `Status` (formato antigo/tolerado): então não precisa do `GET /1/sales/{id}`. */
  inline: CamposPagamentoCielo | null
}

/**
 * `GET /1/sales?merchantOrderId=` — o corpo real da Cielo (doc, ainda NÃO visto em sandbox: I-1 da auditoria) lista só `PaymentId` e a data de cada venda
 * (`ReceveidDate`, sic) e NÃO traz `Status`/`ReturnCode`/`Amount`. O formato antigo que o código assumia (`Payments[]` com tudo dentro) continua TOLERADO:
 * a entrada com `Status` numérico é lida direto. O estado de uma entrada só-com-id exige `GET /1/sales/{PaymentId}` (feito pelo adaptador).
 */
export function lerListaDaConsultaPorPedido(body: unknown): { merchantOrderIdTopo: string | null; entradas: EntradaDaListaPorPedido[] } {
  const raw = body as { MerchantOrderId?: unknown; Payments?: unknown } | null | undefined
  const topo = typeof raw?.MerchantOrderId === 'string' ? raw.MerchantOrderId : null
  const payments = Array.isArray(raw?.Payments) ? raw.Payments : []
  const entradas = payments.flatMap((p): EntradaDaListaPorPedido[] => {
    if (p === null || typeof p !== 'object') return []
    const e = p as Record<string, unknown>
    const paymentId = typeof e.PaymentId === 'string' && e.PaymentId.trim() !== '' ? e.PaymentId.trim() : null
    const traz = lerStatusCielo(e.Status) !== -1
    const inline = traz ? extrairCamposPagamento({ MerchantOrderId: topo ?? undefined, Payment: e }) : null
    if (!paymentId && !inline) return []
    return [{ paymentId, receivedDateMs: lerDataCielo(e.ReceivedDate ?? e.ReceveidDate), inline }]
  })
  return { merchantOrderIdTopo: topo, entradas }
}
