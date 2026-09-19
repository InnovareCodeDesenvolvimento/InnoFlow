/**
 * Porteiro de log: deixa passar no máximo UMA chamada por `intervalMs` e conta as suprimidas
 * (entregues na próxima que passar). Para eventos que se repetem em rajada durante uma falha —
 * o ioredis emite `error` a cada tentativa de reconexão, e cada publish/login com o Redis fora do
 * ar falharia com a mesma mensagem: sem isto o log vira centenas de linhas idênticas por segundo
 * e esconde o resto.
 */
export function createLogGate(intervalMs: number, now: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY
  let suppressed = 0
  return (log: (suppressedSinceLast: number) => void): void => {
    const t = now()
    if (t - last < intervalMs) {
      suppressed++
      return
    }
    last = t
    const s = suppressed
    suppressed = 0
    log(s)
  }
}
