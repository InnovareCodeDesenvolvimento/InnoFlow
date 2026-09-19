/**
 * Coalescência "o último estado vence" por chave — no máximo UM envio por
 * `windowMs` para cada chave, e o último valor recebido dentro da janela
 * nunca se perde (sai no fim dela). Puro: relógio e agendador injetáveis,
 * testável sem timer real.
 *
 * Uso: (1) `chargepoint.status` no canal público `ui:ev:stations` (~2s por
 * conector — evita todo motorista logado refazer fetch a cada oscilação de
 * status de qualquer carregador da plataforma); (2) atualização de
 * `lastSeenAt` a cada mensagem OCPP (evita um UPDATE por MeterValues).
 *
 * Comportamento: a 1ª chamada de uma chave (ou a 1ª depois de a janela
 * vencer) envia NA HORA; chamadas seguintes dentro da janela só guardam o
 * valor mais novo e agendam UM envio para o fim da janela.
 */

export interface ThrottleClock {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.() // um envio pendente nunca deve segurar o processo vivo no shutdown
    return handle
  },
}

interface KeyState<V> {
  lastSentAt: number
  pending?: { value: V }
}

export interface LastWinsThrottle<V> {
  push(key: string, value: V): void
}

export function createLastWinsThrottle<V>(
  windowMs: number,
  send: (key: string, value: V) => void | Promise<void>,
  options: { clock?: ThrottleClock; onError?: (err: unknown, key: string) => void } = {},
): LastWinsThrottle<V> {
  const clock = options.clock ?? realClock
  const states = new Map<string, KeyState<V>>()

  const dispatch = (key: string, value: V): void => {
    try {
      const result = send(key, value)
      if (result && typeof (result as Promise<void>).catch === 'function') {
        ;(result as Promise<void>).catch((err) => options.onError?.(err, key))
      }
    } catch (err) {
      options.onError?.(err, key)
    }
  }

  return {
    push(key, value) {
      const now = clock.now()
      const state = states.get(key)

      if (!state) {
        states.set(key, { lastSentAt: now })
        dispatch(key, value)
        return
      }

      if (state.pending) {
        state.pending.value = value // já há envio agendado — só troca pelo valor mais novo
        return
      }

      const elapsed = now - state.lastSentAt
      if (elapsed >= windowMs) {
        state.lastSentAt = now
        dispatch(key, value)
        return
      }

      const pending = { value }
      state.pending = pending
      clock.setTimer(() => {
        state.pending = undefined
        state.lastSentAt = clock.now()
        dispatch(key, pending.value)
      }, windowMs - elapsed)
    },
  }
}
