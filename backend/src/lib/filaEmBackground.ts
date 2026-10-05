/**
 * Fila LOCAL limitada para trabalho que NÃO pode estar no caminho da resposta (ex.: e-mail de redefinição de senha — `POST .../forgot` responde 202 igual para qualquer
 * e-mail, e o tempo da resposta não pode revelar se a conta existe: o trabalho que difere entre os casos roda aqui, depois).
 *
 * Garantias:
 *  - `agendar` é SÍNCRONO, barato e nunca lança nem espera I/O: só enfileira (ou recusa, se cheia) e agenda o processamento para o próximo ciclo do event loop;
 *  - poucas tarefas em paralelo (`concorrencia`) e fila com teto (`tamanhoMaximo`): uma enxurrada não acumula memória/conexões — o excesso é DESCARTADO e contado (`agendar`
 *    devolve `false`; quem chama decide se loga);
 *  - uma tarefa que lança não derruba as outras nem o processo: o erro vai para `aoFalhar` (que NÃO deve logar segredo).
 * Trade-off assumido (diferente de uma fila BullMQ): vive no processo da API — um restart no meio perde o que estava na fila (o usuário pede de novo) e não há retry. Para o
 * e-mail de redefinição isso é aceitável (o pedido é repetível, o limite por e-mail deixa 3/h) e evita guardar o e-mail em claro no Redis.
 */
export interface OpcoesDaFila {
  concorrencia?: number
  tamanhoMaximo?: number
  aoFalhar?: (err: unknown) => void
}

export class FilaEmBackground {
  private readonly fila: Array<() => Promise<void>> = []
  private ativas = 0
  private readonly concorrencia: number
  private readonly tamanhoMaximo: number
  private readonly aoFalhar: (err: unknown) => void
  private ociosos: Array<() => void> = []

  constructor(opcoes: OpcoesDaFila = {}) {
    this.concorrencia = opcoes.concorrencia ?? 3
    this.tamanhoMaximo = opcoes.tamanhoMaximo ?? 100
    this.aoFalhar = opcoes.aoFalhar ?? (() => undefined)
  }

  /** `false` = fila cheia, tarefa descartada. */
  agendar(tarefa: () => Promise<void>): boolean {
    if (this.fila.length >= this.tamanhoMaximo) return false
    this.fila.push(tarefa)
    setImmediate(() => this.bombear())
    return true
  }

  private bombear(): void {
    while (this.ativas < this.concorrencia && this.fila.length > 0) {
      const tarefa = this.fila.shift()!
      this.ativas++
      void Promise.resolve()
        .then(tarefa)
        .catch((err: unknown) => {
          try {
            this.aoFalhar(err)
          } catch {
            /* o tratador de falha nunca derruba a fila */
          }
        })
        .finally(() => {
          this.ativas--
          this.bombear()
          this.avisarSeOciosa()
        })
    }
  }

  private avisarSeOciosa(): void {
    if (this.ativas > 0 || this.fila.length > 0) return
    const esperando = this.ociosos
    this.ociosos = []
    for (const resolver of esperando) resolver()
  }

  /** Resolve quando não há nada rodando nem esperando (testes e encerramento ordenado). */
  aguardarOciosa(): Promise<void> {
    if (this.ativas === 0 && this.fila.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.ociosos.push(resolve))
  }
}
