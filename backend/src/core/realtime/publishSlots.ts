/**
 * Vagas de publish "em voo" do barramento de eventos de UI (`realtime/bus.ts`) — PURO (relógio injetável).
 *
 * Era um contador solto (`publishesInFlight++`/`--` no `then` da promessa). Furo medido pela Íris (B1, 02/10/2026): um comando
 * que o ioredis NUNCA liquida (nem resolve nem rejeita — o publish escrito na conexão em `connect`, antes do `ready`, e o socket
 * morre: o ioredis só preserva os comandos já enviados se o status ANTERIOR era `ready`) deixava a vaga ocupada PARA SEMPRE; com
 * `max` órfãos o `publish()` descartava TODO evento até reiniciar o processo, em silêncio.
 *
 * Duas defesas, esta é a de PROFUNDIDADE:
 *  1. (causa raiz, em `bus.ts`) não escrever na conexão em `connect` — não nasce o órfão conhecido;
 *  2. (aqui) a vaga tem IDADE MÁXIMA: ao encontrar o teto cheio, vagas mais velhas que `maxAgeMs` são recuperadas (quem as ocupava é
 *     órfão por definição — um publish de verdade liquida em milissegundos, ou em segundos com o Redis lento). Liberar é IDEMPOTENTE:
 *     a promessa que liquida DEPOIS de a vaga ter sido recuperada não devolve uma segunda vez (o contador nunca fica negativo nem
 *     "abre" vaga que não existe).
 * Sem timer: a recuperação é preguiçosa (só quando o teto enche), então não há nada pendurado para limpar.
 */
export interface PublishSlots {
  /** Reserva uma vaga; `id: null` = teto cheio (mesmo depois de recuperar as vagas velhas). `reclaimed` = quantas órfãs foram recuperadas nesta chamada. */
  tryAcquire(): { id: number | null; reclaimed: number }
  /** Devolve a vaga. `false` se ela já não existia (já devolvida, ou recuperada por idade) — nunca devolve duas vezes. */
  release(id: number): boolean
  readonly size: number
}

export function createPublishSlots(options: { max: number; maxAgeMs: number; now?: () => number }): PublishSlots {
  const now = options.now ?? Date.now
  const held = new Map<number, number>() // id -> quando foi reservada

  let nextId = 1

  function reclaimStale(): number {
    const limit = now() - options.maxAgeMs
    let reclaimed = 0
    for (const [id, startedAt] of held) {
      if (startedAt > limit) break // Map preserva a ordem de inserção = ordem de idade; o resto é mais novo
      held.delete(id)
      reclaimed++
    }
    return reclaimed
  }

  return {
    tryAcquire() {
      let reclaimed = 0
      if (held.size >= options.max) reclaimed = reclaimStale()
      if (held.size >= options.max) return { id: null, reclaimed }
      const id = nextId++
      held.set(id, now())
      return { id, reclaimed }
    },
    release(id) {
      return held.delete(id)
    },
    get size() {
      return held.size
    },
  }
}
