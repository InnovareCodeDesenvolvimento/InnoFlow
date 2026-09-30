/**
 * Núcleo puro da quitação automática de dívida pelo crédito Pix (F5.2 — ver
 * `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md`, item 6: "não
 * existe caminho nenhum para quitar Debt"). Decide QUANTO alocar para cada
 * dívida, dado um crédito e a lista de dívidas já ordenada (mais antiga
 * primeiro) — quem chama (`services/pagamentos/creditarTopupPix.ts`) é dono
 * da escrita no banco.
 *
 * Regra: só quita uma dívida INTEIRA — nunca parcial (uma dívida "meio
 * quitada" marcada como SETTLED mentiria sobre o estado real). Para na
 * primeira dívida que o crédito restante não cobre por completo; dívidas
 * mais novas atrás dela continuam OPEN mesmo que o crédito desse para
 * cobrir uma delas isoladamente — sempre mais antiga primeiro (FIFO), nunca
 * "pula" para a próxima que caiba.
 */

export interface DividaAlocavel {
  id: string
  amountCents: number
}

export interface AlocacaoQuitacao {
  debtId: string
  amountCents: number
}

export interface ResultadoAlocacaoQuitacao {
  alocacoes: AlocacaoQuitacao[]
  /** Crédito que sobrou depois de quitar o que deu — vai para o saldo livre da carteira. */
  restanteCents: number
  /** Soma de `alocacoes[].amountCents` — conveniência para quem grava o `WalletEntry` de crédito consolidado. */
  totalAlocadoCents: number
}

export function alocarQuitacaoDividas(creditoCents: number, dividasOrdenadas: readonly DividaAlocavel[]): ResultadoAlocacaoQuitacao {
  let restanteCents = creditoCents
  const alocacoes: AlocacaoQuitacao[] = []

  for (const divida of dividasOrdenadas) {
    if (restanteCents < divida.amountCents) break
    alocacoes.push({ debtId: divida.id, amountCents: divida.amountCents })
    restanteCents -= divida.amountCents
  }

  const totalAlocadoCents = alocacoes.reduce((sum, a) => sum + a.amountCents, 0)
  return { alocacoes, restanteCents, totalAlocadoCents }
}
