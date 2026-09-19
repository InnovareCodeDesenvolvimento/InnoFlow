/**
 * Fan-out em memória de UM assinante Redis compartilhado por processo (Órion A2, 2026-09-19).
 *
 * Antes: `subscribeChannels` abria UMA conexão Redis por conexão SSE — 1000 abas = 1000 conexões
 * Redis (e o limite de clientes do Redis / descritores do processo virava o teto de exaustão,
 * alcançável por qualquer conta cadastrada). Agora: um único assinante por processo e um mapa
 * `canal -> ouvintes`; o Redis só vê `SUBSCRIBE`/`UNSUBSCRIBE` quando o PRIMEIRO ouvinte de um
 * canal entra / o ÚLTIMO sai. Cada mensagem é parseada UMA vez e entregue a todos os ouvintes
 * (e o texto cru vai junto, para o SSE não re-serializar por conexão).
 *
 * Fronteira multi-tenant continua na ASSINATURA: quem chama passa só os canais que o `req.user`
 * autoriza (ver `events.routes.ts`); o hub não decide audiência.
 *
 * Puro em relação a I/O: o assinante entra por injeção (`SubscriberLike`) — testável sem Redis.
 */

export interface SubscriberLike {
  subscribe(channel: string): Promise<unknown> | unknown
  unsubscribe(channel: string): Promise<unknown> | unknown
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
}

export type HubListener<TEvent> = (event: TEvent, raw: string) => void

export interface ChannelHub<TEvent> {
  /** Assina os canais; devolve o "cancelar" (idempotente). Um ouvinte que lança NÃO afeta os demais. */
  subscribe(channels: readonly string[], listener: HubListener<TEvent>): () => void
  stats(): { channels: number; listeners: number }
}

export function createChannelHub<TEvent>(subscriber: SubscriberLike, options: { onError?: (err: unknown, context: string) => void } = {}): ChannelHub<TEvent> {
  const listenersByChannel = new Map<string, Set<HubListener<TEvent>>>()
  const onError = options.onError ?? (() => {})

  subscriber.on('message', (channel, message) => {
    const listeners = listenersByChannel.get(channel)
    if (!listeners || listeners.size === 0) return

    let event: TEvent
    try {
      event = JSON.parse(message) as TEvent
    } catch (err) {
      onError(err, `evento malformado em ${channel} — ignorado`)
      return
    }

    // Copia: um ouvinte que se cancela durante a entrega (fecha o stream por backpressure) não pode mexer no Set em iteração.
    for (const listener of [...listeners]) {
      try {
        listener(event, message)
      } catch (err) {
        onError(err, `ouvinte de ${channel} lançou`)
      }
    }
  })

  function run(action: () => Promise<unknown> | unknown, context: string): void {
    try {
      const result = action()
      if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch((err) => onError(err, context))
    } catch (err) {
      onError(err, context)
    }
  }

  return {
    subscribe(channels, listener) {
      const unique = [...new Set(channels)]
      for (const channel of unique) {
        let set = listenersByChannel.get(channel)
        if (!set) {
          set = new Set()
          listenersByChannel.set(channel, set)
          run(() => subscriber.subscribe(channel), `subscribe ${channel}`)
        }
        set.add(listener)
      }

      let cancelled = false
      return () => {
        if (cancelled) return
        cancelled = true
        for (const channel of unique) {
          const set = listenersByChannel.get(channel)
          if (!set) continue
          set.delete(listener)
          if (set.size === 0) {
            listenersByChannel.delete(channel)
            run(() => subscriber.unsubscribe(channel), `unsubscribe ${channel}`)
          }
        }
      }
    },

    stats() {
      let listeners = 0
      for (const set of listenersByChannel.values()) listeners += set.size
      return { channels: listenersByChannel.size, listeners }
    },
  }
}
