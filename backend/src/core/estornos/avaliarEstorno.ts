/**
 * Regra PURA do estorno de uma sessão (L1.8) — quanto dá para devolver e por que um pedido é recusado. Sem Prisma/Redis/relógio:
 * quem chama (`services/estornos/registrarEstornoSessao.ts`) lê os números sob o lock da sessão e passa aqui.
 *
 * O BANCO também impõe um teto (trigger BEFORE INSERT de PaymentReversal: Σ estornos <= `totalCostCents` da sessão e, no cartão, Σ <= capturado). Este
 * módulo é a regra MAIS FINA por cima dele: "o que de fato foi cobrado" (uma sessão que virou dívida não foi paga, então não há o que devolver).
 */

export interface FotoCobrancaSessao {
  /** `ChargingSession.totalCostCents` (null = a sessão ainda não foi precificada/encerrada). */
  totalCostCents: number | null
  /** Σ -WalletEntry CHARGE_DEBIT da sessão. */
  walletDebitCents: number
  /** Σ PaymentIntent.amountCapturedCents (status CAPTURED) da sessão. */
  cardCapturedCents: number
  /** Σ Debt SETTLED da sessão (dívida quitada por crédito posterior: o dinheiro entrou, só mais tarde). */
  debtSettledCents: number
  /** Σ estornos da sessão que NÃO foram cancelados (carteira + cartão, confirmados ou pendentes) — o que já está "reservado" do reembolsável. */
  estornadoCents: number
}

/** O que a sessão efetivamente cobrou (nunca acima do total da sessão — o teto do banco). */
export function calcularCobradoCents(foto: FotoCobrancaSessao): number {
  const total = foto.totalCostCents
  if (total === null || total <= 0) return 0
  const pago = Math.max(0, foto.walletDebitCents) + Math.max(0, foto.cardCapturedCents) + Math.max(0, foto.debtSettledCents)
  return Math.min(total, pago)
}

export type RecusaEstorno =
  | { codigo: 'SESSION_NOT_BILLED' }
  | { codigo: 'AMOUNT_EXCEEDS_REFUNDABLE'; reembolsavelCents: number }

export type AvaliacaoEstorno = { ok: true; reembolsavelCents: number } | ({ ok: false } & RecusaEstorno)

/** Quanto ainda dá para estornar nesta sessão (>= 0). */
export function calcularReembolsavelCents(foto: FotoCobrancaSessao): number {
  return Math.max(0, calcularCobradoCents(foto) - Math.max(0, foto.estornadoCents))
}

/**
 * `SESSION_NOT_BILLED` quando a sessão não cobrou nada (sem custo, ou só dívida em aberto); `AMOUNT_EXCEEDS_REFUNDABLE` quando o valor passa do que resta
 * (descontados os estornos já registrados, inclusive os pendentes no portal — eles seguram o teto até serem confirmados ou cancelados).
 */
export function avaliarPedidoDeEstorno(foto: FotoCobrancaSessao, amountCents: number): AvaliacaoEstorno {
  if (calcularCobradoCents(foto) <= 0) return { ok: false, codigo: 'SESSION_NOT_BILLED' }
  const reembolsavelCents = calcularReembolsavelCents(foto)
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > reembolsavelCents) return { ok: false, codigo: 'AMOUNT_EXCEEDS_REFUNDABLE', reembolsavelCents }
  return { ok: true, reembolsavelCents }
}

/** Σ das devoluções PELO PORTAL (não canceladas) já registradas na venda de cartão + o novo pedido não pode passar do capturado (espelho do trigger do banco, com detalhe para a tela). */
export function avaliarTetoDoCartao(params: { capturadoCents: number; devolucoesNoPortalCents: number; amountCents: number }): { ok: true } | { ok: false; disponivelCents: number } {
  const disponivelCents = Math.max(0, params.capturadoCents - params.devolucoesNoPortalCents)
  return params.amountCents <= disponivelCents ? { ok: true } : { ok: false, disponivelCents }
}

/** "Estorno da recarga de dd/mm" — texto do extrato do motorista. Sem motivo e sem nome (o motivo é texto livre do ADMIN e fica só no registro do estorno). */
export function descricaoDoEstornoNoExtrato(diaMes: string): string {
  return `Estorno da recarga de ${diaMes}`
}

/** `dd/mm` de uma data no fuso do local da sessão (o motorista vê a data do carregador, não a do servidor). Fuso inválido cai em UTC. */
export function formatarDiaMes(data: Date, timeZone: string): string {
  const formatar = (tz: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(data)
  try {
    return formatar(timeZone)
  } catch {
    return formatar('UTC')
  }
}
