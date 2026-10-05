/** Pedido MANUAL que a API enfileira e o worker executa (a API não tem `pg_dump`). Em arquivo próprio para a API e o job não dependerem um do outro. */
export type TipoDePedido = 'manual-run' | 'manual-verify'

export interface PedidoNaFila {
  tipo: TipoDePedido
  /** Linha `BackupRun` já criada pela API (QUEUED). */
  runId: string
  criadoPorId: string
}
