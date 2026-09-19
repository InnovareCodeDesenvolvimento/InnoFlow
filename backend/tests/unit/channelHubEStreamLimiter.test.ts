import { describe, expect, it, vi } from 'vitest'
import { createChannelHub, type SubscriberLike } from '../../src/core/realtime/channelHub'
import { createStreamLimiter } from '../../src/core/realtime/streamLimiter'

function fakeSubscriber() {
  let handler: ((channel: string, message: string) => void) | undefined
  const subscribed: string[] = []
  const unsubscribed: string[] = []
  const subscriber: SubscriberLike = {
    subscribe: (c) => void subscribed.push(c),
    unsubscribe: (c) => void unsubscribed.push(c),
    on: (_event, listener) => {
      handler = listener
    },
  }
  return { subscriber, subscribed, unsubscribed, emit: (channel: string, message: string) => handler?.(channel, message) }
}

describe('createChannelHub (assinante Redis compartilhado — Órion A2)', () => {
  it('SUBSCRIBE no Redis só quando entra o PRIMEIRO ouvinte do canal; UNSUBSCRIBE só quando sai o ÚLTIMO (1000 abas = 1 assinatura, não 1000)', () => {
    const f = fakeSubscriber()
    const hub = createChannelHub<{ type: string }>(f.subscriber)

    const cancels = Array.from({ length: 1000 }, () => hub.subscribe(['ui:ev:stations'], () => {}))
    expect(f.subscribed).toEqual(['ui:ev:stations']) // UMA assinatura para 1000 ouvintes
    expect(hub.stats()).toEqual({ channels: 1, listeners: 1000 })

    for (const cancel of cancels.slice(0, 999)) cancel()
    expect(f.unsubscribed).toEqual([]) // ainda resta 1

    cancels[999]()
    expect(f.unsubscribed).toEqual(['ui:ev:stations'])
    expect(hub.stats()).toEqual({ channels: 0, listeners: 0 })
  })

  it('entrega cada mensagem só aos ouvintes DAQUELE canal (fronteira multi-tenant na assinatura)', () => {
    const f = fakeSubscriber()
    const hub = createChannelHub<{ type: string }>(f.subscriber)
    const opA = vi.fn()
    const opB = vi.fn()
    hub.subscribe(['ui:ev:op:A'], opA)
    hub.subscribe(['ui:ev:op:B'], opB)

    f.emit('ui:ev:op:A', JSON.stringify({ type: 'session.started' }))

    expect(opA).toHaveBeenCalledTimes(1)
    expect(opB).not.toHaveBeenCalled()
  })

  it('parseia a mensagem UMA vez e entrega evento + texto cru a todos', () => {
    const f = fakeSubscriber()
    const hub = createChannelHub<{ type: string }>(f.subscriber)
    const seen: unknown[] = []
    hub.subscribe(['c'], (event) => seen.push(event))
    hub.subscribe(['c'], (event) => seen.push(event))

    const raw = JSON.stringify({ type: 'x' })
    f.emit('c', raw)

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1]) // mesma referência: parseado uma vez
  })

  it('o texto cru chega ao ouvinte (o SSE não re-serializa por conexão)', () => {
    const f = fakeSubscriber()
    const hub = createChannelHub<{ type: string }>(f.subscriber)
    let received = ''
    hub.subscribe(['c'], (_e, raw) => {
      received = raw
    })
    f.emit('c', '{"type":"x"}')
    expect(received).toBe('{"type":"x"}')
  })

  it('mensagem malformada é descartada (e reportada) sem derrubar ninguém', () => {
    const f = fakeSubscriber()
    const errors: string[] = []
    const hub = createChannelHub<{ type: string }>(f.subscriber, { onError: (_e, ctx) => errors.push(ctx) })
    const listener = vi.fn()
    hub.subscribe(['c'], listener)

    f.emit('c', '{isto não é json')

    expect(listener).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
  })

  it('um ouvinte que LANÇA não impede os outros de receber', () => {
    const f = fakeSubscriber()
    const hub = createChannelHub<{ type: string }>(f.subscriber, { onError: () => {} })
    const bom = vi.fn()
    hub.subscribe(['c'], () => {
      throw new Error('boom')
    })
    hub.subscribe(['c'], bom)

    f.emit('c', JSON.stringify({ type: 'x' }))

    expect(bom).toHaveBeenCalledTimes(1)
  })

  it('ouvinte que se CANCELA durante a entrega (backpressure fecha o stream) não corrompe a iteração', () => {
    const f = fakeSubscriber()
    const hub = createChannelHub<{ type: string }>(f.subscriber)
    const depois = vi.fn()
    let cancelPrimeiro: () => void = () => {}
    cancelPrimeiro = hub.subscribe(['c'], () => cancelPrimeiro())
    hub.subscribe(['c'], depois)

    f.emit('c', JSON.stringify({ type: 'x' }))

    expect(depois).toHaveBeenCalledTimes(1)
    expect(hub.stats().listeners).toBe(1)
  })

  it('cancelar é idempotente (chamar 2x não desassina o canal de outro ouvinte)', () => {
    const f = fakeSubscriber()
    const hub = createChannelHub<{ type: string }>(f.subscriber)
    const cancelA = hub.subscribe(['c'], () => {})
    hub.subscribe(['c'], () => {})
    cancelA()
    cancelA()
    expect(f.unsubscribed).toEqual([])
    expect(hub.stats().listeners).toBe(1)
  })

  it('falha do Redis ao (des)assinar é reportada e não lança', () => {
    const errors: string[] = []
    const hub = createChannelHub<{ type: string }>(
      {
        subscribe: () => {
          throw new Error('redis fora')
        },
        unsubscribe: () => Promise.reject(new Error('redis fora')),
        on: () => {},
      },
      { onError: (_e, ctx) => errors.push(ctx) },
    )
    const cancel = hub.subscribe(['c'], () => {})
    cancel()
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })
})

describe('createStreamLimiter (teto de streams — Órion A2)', () => {
  const limits = { perUser: 2, perIp: 3, total: 4 }

  it('dentro dos tetos: aceita', () => {
    const l = createStreamLimiter(limits)
    expect(l.acquire('u1', '1.1.1.1', () => {}).ok).toBe(true)
    expect(l.acquire('u1', '1.1.1.1', () => {}).ok).toBe(true)
  })

  it('por USUÁRIO: o 3º stream EXPULSA o mais antigo (não tranca quem trocou de rede) e aceita o novo', () => {
    const l = createStreamLimiter(limits)
    const closed: string[] = []
    l.acquire('u1', '1.1.1.1', () => closed.push('s1'))
    l.acquire('u1', '1.1.1.1', () => closed.push('s2'))

    const terceiro = l.acquire('u1', '1.1.1.1', () => closed.push('s3'))

    expect(terceiro.ok).toBe(true)
    expect(closed).toEqual(['s1']) // o mais antigo saiu; s2 e s3 seguem
  })

  it('a expulsão é só entre streams do MESMO usuário', () => {
    const l = createStreamLimiter(limits)
    const closed: string[] = []
    l.acquire('u1', '1.1.1.1', () => closed.push('u1-a'))
    l.acquire('u1', '1.1.1.1', () => closed.push('u1-b'))
    l.acquire('u2', '2.2.2.2', () => closed.push('u2-a'))
    l.acquire('u2', '2.2.2.2', () => closed.push('u2-b'))
    expect(closed).toEqual([])
  })

  it('por IP: REJEITA o novo (expulsar derrubaria OUTROS usuários atrás do mesmo NAT)', () => {
    const l = createStreamLimiter({ perUser: 5, perIp: 3, total: 100 })
    for (const u of ['a', 'b', 'c']) expect(l.acquire(u, '9.9.9.9', () => {}).ok).toBe(true)
    expect(l.acquire('d', '9.9.9.9', () => {})).toEqual({ ok: false, reason: 'IP_LIMIT' })
    expect(l.acquire('d', '8.8.8.8', () => {}).ok).toBe(true) // outro IP não é afetado
  })

  it('total do processo: REJEITA o novo (trava de sanidade)', () => {
    const l = createStreamLimiter({ perUser: 5, perIp: 100, total: 2 })
    l.acquire('a', '1.1.1.1', () => {})
    l.acquire('b', '2.2.2.2', () => {})
    expect(l.acquire('c', '3.3.3.3', () => {})).toEqual({ ok: false, reason: 'TOTAL_LIMIT' })
  })

  it('release libera a vaga (stream fechou) e é idempotente', () => {
    const l = createStreamLimiter({ perUser: 5, perIp: 1, total: 100 })
    const a = l.acquire('a', '1.1.1.1', () => {})
    expect(l.acquire('b', '1.1.1.1', () => {}).ok).toBe(false)
    if (a.ok) {
      a.release()
      a.release()
    }
    expect(l.acquire('b', '1.1.1.1', () => {}).ok).toBe(true)
    expect(l.stats().total).toBe(1)
  })

  it('um close() que lança não impede o novo stream de entrar', () => {
    const l = createStreamLimiter({ perUser: 1, perIp: 100, total: 100 })
    l.acquire('u', '1.1.1.1', () => {
      throw new Error('socket já morto')
    })
    expect(l.acquire('u', '1.1.1.1', () => {}).ok).toBe(true)
  })
})
