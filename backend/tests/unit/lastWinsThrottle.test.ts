import { describe, expect, it } from 'vitest'
import { createLastWinsThrottle, type ThrottleClock } from '../../src/core/estacoes/lastWinsThrottle'

/** Relógio/agendador manuais — nenhum timer real, o teste controla o tempo. */
function fakeClock() {
  let nowMs = 1_000_000
  const timers: { at: number; fn: () => void }[] = []
  const clock: ThrottleClock = {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      timers.push({ at: nowMs + ms, fn })
      return timers.length
    },
  }
  return {
    clock,
    advance(ms: number) {
      nowMs += ms
      for (const t of timers.filter((t) => t.at <= nowMs).sort((a, b) => a.at - b.at)) {
        timers.splice(timers.indexOf(t), 1)
        t.fn()
      }
    },
    pendingTimers: () => timers.length,
  }
}

describe('createLastWinsThrottle', () => {
  it('a 1ª chamada de uma chave envia NA HORA (latência zero quando não há rajada)', () => {
    const sent: [string, string][] = []
    const t = fakeClock()
    const throttle = createLastWinsThrottle<string>(2_000, (k, v) => void sent.push([k, v]), { clock: t.clock })

    throttle.push('cp1:1', 'AVAILABLE')

    expect(sent).toEqual([['cp1:1', 'AVAILABLE']])
  })

  it('rajada dentro da janela: só o ÚLTIMO valor sai, uma vez, no fim da janela', () => {
    const sent: [string, string][] = []
    const t = fakeClock()
    const throttle = createLastWinsThrottle<string>(2_000, (k, v) => void sent.push([k, v]), { clock: t.clock })

    throttle.push('cp1:1', 'AVAILABLE') // sai já
    t.advance(300)
    throttle.push('cp1:1', 'PREPARING')
    t.advance(300)
    throttle.push('cp1:1', 'CHARGING')
    t.advance(300)
    throttle.push('cp1:1', 'FINISHING') // o estado final da rajada

    expect(sent).toEqual([['cp1:1', 'AVAILABLE']]) // nada dos intermediários vazou ainda

    t.advance(1_100) // completa os 2s desde o 1º envio
    expect(sent).toEqual([
      ['cp1:1', 'AVAILABLE'],
      ['cp1:1', 'FINISHING'],
    ])
  })

  it('o último estado NUNCA se perde — mesmo que a rajada acabe no meio da janela', () => {
    const sent: string[] = []
    const t = fakeClock()
    const throttle = createLastWinsThrottle<string>(2_000, (_k, v) => void sent.push(v), { clock: t.clock })

    throttle.push('k', 'A')
    t.advance(100)
    throttle.push('k', 'B') // ninguém mais chama depois disto

    t.advance(5_000)
    expect(sent).toEqual(['A', 'B'])
    expect(t.pendingTimers()).toBe(0) // não sobrou timer pendurado
  })

  it('no máximo 1 envio por janela por chave, mesmo com N pushes', () => {
    const sent: string[] = []
    const t = fakeClock()
    const throttle = createLastWinsThrottle<number>(2_000, (_k, v) => void sent.push(String(v)), { clock: t.clock })

    for (let i = 0; i < 50; i++) {
      throttle.push('k', i)
      t.advance(10)
    }
    t.advance(2_000)

    expect(sent.length).toBe(2) // 1º (leading) + 1 trailing com o valor 49
    expect(sent[1]).toBe('49')
  })

  it('depois que a janela vence sem nada pendente, a próxima chamada volta a sair na hora', () => {
    const sent: string[] = []
    const t = fakeClock()
    const throttle = createLastWinsThrottle<string>(2_000, (_k, v) => void sent.push(v), { clock: t.clock })

    throttle.push('k', 'A')
    t.advance(2_500)
    throttle.push('k', 'B')

    expect(sent).toEqual(['A', 'B'])
  })

  it('chaves são independentes: conector 1 em rajada não segura o conector 2', () => {
    const sent: string[] = []
    const t = fakeClock()
    const throttle = createLastWinsThrottle<string>(2_000, (k, v) => void sent.push(`${k}=${v}`), { clock: t.clock })

    throttle.push('cp1:1', 'A')
    throttle.push('cp1:1', 'B') // segurado
    throttle.push('cp1:2', 'X') // outra chave: sai na hora

    expect(sent).toEqual(['cp1:1=A', 'cp1:2=X'])
  })

  it('erro no envio (síncrono ou assíncrono) não derruba quem chama nem trava a chave', async () => {
    const errors: string[] = []
    const t = fakeClock()
    let calls = 0
    const throttle = createLastWinsThrottle<string>(
      2_000,
      async () => {
        calls++
        throw new Error('redis fora')
      },
      { clock: t.clock, onError: (err) => void errors.push((err as Error).message) },
    )

    expect(() => throttle.push('k', 'A')).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    t.advance(2_500)
    throttle.push('k', 'B')
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toBe(2)
    expect(errors).toEqual(['redis fora', 'redis fora'])
  })
})
