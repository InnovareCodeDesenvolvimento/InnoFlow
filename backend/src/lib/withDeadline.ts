/**
 * Dá PRAZO a uma promessa que pode nunca liquidar. Com o Redis fora do ar o ioredis (configurado com
 * `maxRetriesPerRequest: null`, exigência do BullMQ) NÃO rejeita o comando: enfileira e espera
 * reconectar — um `await`/`.catch` sobre ele nunca retorna. Rejeita com `Error(label)` no prazo e
 * limpa o timer quando a promessa liquida antes (sem timer pendurado). A promessa original NÃO é
 * cancelada: o comando abandonado segue na fila do cliente (quem chama deve limitar quantos ficam).
 */
/** O prazo estourou (diferente de a própria operação ter falhado). */
export class DeadlineExceededError extends Error {}

export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceededError(`${label}: sem resposta em ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}
