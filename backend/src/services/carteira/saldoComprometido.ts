import { prisma } from '../../lib/prisma'

/**
 * Saldo COMPROMETIDO por sessões em `STOP_UNCONFIRMED` (F5.9, decisão D7). Uma sessão em confirmação ainda NÃO debitou a carteira, mas vai
 * debitar o que o servidor calculou com a melhor leitura (`provisionalCostCents`). Se o motorista puder iniciar OUTRA recarga durante a
 * janela, o saldo que a sessão pendente já consome não pode ser usado de novo — senão as duas estouram a mesma carteira (vira dívida).
 *
 * Só conta sessões WALLET: uma sessão CARD pendente é coberta pela PRÓPRIA pré-autorização do cartão (que fica AUTHORIZED até encerrar),
 * não pela carteira — descontar dela seria bloquear o motorista à toa. Uma pré-autorização NOVA de cartão é independente de tudo isto.
 */
export interface SessoesNaoConfirmadasDoMotorista {
  /** Quantas sessões STOP_UNCONFIRMED o motorista tem (qualquer modo de pagamento). */
  total: number
  /** Soma do custo provisório das de modo WALLET — o que a carteira ainda vai pagar. Nunca negativo. */
  comprometidoCents: number
  /** Primeira sessão em confirmação (para o 409 apontar). */
  sessionId: string | null
}

export async function carregarSessoesNaoConfirmadas(userId: string, opcoes: { excetoSessionId?: string } = {}): Promise<SessoesNaoConfirmadasDoMotorista> {
  const sessoes = await prisma.chargingSession.findMany({
    where: { userId, status: 'STOP_UNCONFIRMED', ...(opcoes.excetoSessionId ? { id: { not: opcoes.excetoSessionId } } : {}) },
    select: { id: true, paymentMode: true, provisionalCostCents: true },
    orderBy: { createdAt: 'asc' },
  })
  const comprometidoCents = sessoes.filter((s) => s.paymentMode === 'WALLET').reduce((acc, s) => acc + Math.max(0, s.provisionalCostCents ?? 0), 0)
  return { total: sessoes.length, comprometidoCents, sessionId: sessoes[0]?.id ?? null }
}
