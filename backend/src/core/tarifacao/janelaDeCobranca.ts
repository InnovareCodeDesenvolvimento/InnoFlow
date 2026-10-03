/**
 * Normalização PURA da janela de cobrança de uma sessão (F5.9, ALTO-1 do Órion).
 *
 * `calcularCustoSessao` LANÇA quando `stoppedAt < startedAt` ou `chargingEndedAt` cai fora de `[startedAt, stoppedAt]` (bug do chamador, em tese). Na
 * prática os instantes vêm de DOIS relógios do carregador que não precisam concordar: o carro termina de carregar (`chargingEndedAt = T2`), a última
 * amostra é `T1 < T2`, o carregador some e o servidor fecha com `stoppedAt = T1`; ou um Stop com o RTC resetado (`stoppedAt < startedAt`). Antes, a
 * exceção virava custo ZERO em silêncio (receita perdida; no cartão a pré-autorização era cancelada). Agora a janela é normalizada ANTES da conta:
 *   - `stoppedAt' = max(stoppedAt, startedAt)`;
 *   - `chargingEndedAt'` é limitado a `[startedAt, stoppedAt']`.
 * Nunca inventa energia: só garante a ordem dos instantes. `ajustada = true` quando algo foi corrigido (o chamador loga).
 */
export interface JanelaDeCobranca {
  startedAt: Date
  chargingEndedAt: Date | null
  stoppedAt: Date
}

export interface JanelaNormalizada extends JanelaDeCobranca {
  ajustada: boolean
}

export function normalizarJanelaDeCobranca(janela: JanelaDeCobranca): JanelaNormalizada {
  const inicio = janela.startedAt.getTime()
  const fim = Math.max(janela.stoppedAt.getTime(), inicio)
  let ajustada = fim !== janela.stoppedAt.getTime()

  let fimDaCarga: Date | null = janela.chargingEndedAt
  if (fimDaCarga) {
    const t = Math.min(Math.max(fimDaCarga.getTime(), inicio), fim)
    if (t !== fimDaCarga.getTime()) {
      ajustada = true
      fimDaCarga = new Date(t)
    }
  }
  return { startedAt: janela.startedAt, chargingEndedAt: fimDaCarga, stoppedAt: fim === janela.stoppedAt.getTime() ? janela.stoppedAt : new Date(fim), ajustada }
}
