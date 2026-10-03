import { describe, expect, it, vi } from 'vitest'
import { createLoginThrottle, DEFAULT_LOGIN_THROTTLE, type LoginGate, type LoginThrottle, type ThrottleStore } from '../../src/core/auth/loginThrottle'
import { executarStepUp, type PortasStepUp } from '../../src/core/auth/stepUp'

/** Armazenamento em memória do throttle (mesma semântica atômica do Lua, em JS síncrono) — sem Redis. */
function storeEmMemoria(): ThrottleStore {
  const valores = new Map<string, number>()
  return {
    async reserve(keys, maxFailures) {
      if ((valores.get(keys.lock) ?? 0) > 0) return { status: 'locked', retryAfterSeconds: 60 }
      const atual = valores.get(keys.failures) ?? 0
      if (atual >= maxFailures) return { status: 'full' }
      valores.set(keys.failures, atual + 1)
      return { status: 'ok', count: atual + 1 }
    },
    async release(key) {
      const v = valores.get(key)
      if (v && v > 0) valores.set(key, v - 1)
    },
    async incrWithTtl(key) {
      const v = (valores.get(key) ?? 0) + 1
      valores.set(key, v)
      return v
    },
    async setWithTtl(key, value) {
      valores.set(key, value)
    },
    async del(keys) {
      for (const k of keys) valores.delete(k)
    },
  }
}

const HASH = 'hash-do-admin'
const CERTA = 'senha-certa'

function portas(sobrescritas: Partial<PortasStepUp> = {}) {
  const alertas: Array<{ alerta: string; campos: Record<string, unknown> }> = []
  const compare = vi.fn(async (senha: string, hash: string) => hash === HASH && senha === CERTA)
  const p: PortasStepUp = {
    throttle: createLoginThrottle(storeEmMemoria(), { ...DEFAULT_LOGIN_THROTTLE, maxFailures: 5 }),
    buscarPasswordHash: async () => HASH,
    compare,
    comTimeout: (acao, fallback) => acao().catch(() => fallback),
    alertar: (alerta, campos) => alertas.push({ alerta, campos }),
    ...sobrescritas,
  }
  return { p, alertas, compare }
}

describe('executarStepUp (núcleo puro do step-up de senha, M2)', () => {
  it('senha certa => OK, sem alerta', async () => {
    const { p, alertas } = portas()
    expect(await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).toEqual({ resultado: 'OK' })
    expect(alertas).toEqual([])
  })

  it('senha errada => SENHA_INCORRETA e alerta payment_gateway_stepup_failed só com o id do ator (a senha nunca vai ao alerta)', async () => {
    const { p, alertas } = portas()
    expect(await executarStepUp({ userId: 'u1', senhaInformada: 'errada-marcador-unico' }, p)).toEqual({ resultado: 'SENHA_INCORRETA' })
    expect(alertas).toEqual([{ alerta: 'payment_gateway_stepup_failed', campos: { actorUserId: 'u1' } }])
    expect(JSON.stringify(alertas)).not.toContain('errada-marcador-unico')
  })

  it('conta SEM senha (hash nulo) => SENHA_INCORRETA sem sequer chamar o compare; conta falha', async () => {
    const { p, alertas, compare } = portas({ buscarPasswordHash: async () => null })
    expect(await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).toEqual({ resultado: 'SENHA_INCORRETA' })
    expect(compare).not.toHaveBeenCalled()
    expect(alertas.map((a) => a.alerta)).toEqual(['payment_gateway_stepup_failed'])
  })

  it('usuário inexistente => USUARIO_INEXISTENTE e a vaga reservada é devolvida (não conta falha)', async () => {
    const { p } = portas({ buscarPasswordHash: async () => undefined })
    for (let i = 0; i < 10; i += 1) expect(await executarStepUp({ userId: 'fantasma', senhaInformada: 'x' }, p)).toEqual({ resultado: 'USUARIO_INEXISTENTE' })
  })

  it('5 erradas trancam: a 6ª, MESMO com a senha certa, é LIMITE_DE_TENTATIVAS e não avalia a senha (compare não roda)', async () => {
    const { p, alertas, compare } = portas()
    for (let i = 0; i < 5; i += 1) expect((await executarStepUp({ userId: 'u1', senhaInformada: `errada-${i}` }, p)).resultado).toBe('SENHA_INCORRETA')
    expect(compare).toHaveBeenCalledTimes(5)
    const r = await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)
    expect(r).toMatchObject({ resultado: 'LIMITE_DE_TENTATIVAS' })
    expect(compare).toHaveBeenCalledTimes(5)
    expect(alertas.map((a) => a.alerta)).toContain('payment_gateway_stepup_locked')
  })

  it('o balde é por usuário: u1 trancado não afeta u2', async () => {
    const { p } = portas()
    for (let i = 0; i < 5; i += 1) await executarStepUp({ userId: 'u1', senhaInformada: `errada-${i}` }, p)
    expect((await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).resultado).toBe('LIMITE_DE_TENTATIVAS')
    expect((await executarStepUp({ userId: 'u2', senhaInformada: CERTA }, p)).resultado).toBe('OK')
  })

  it('RAJADA paralela de 12 senhas erradas: só 5 chegam ao compare (reserva ANTES do trabalho caro)', async () => {
    const lento = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return false })
    const { p } = portas({ compare: lento })
    const resultados = await Promise.all(Array.from({ length: 12 }, (_, i) => executarStepUp({ userId: 'u1', senhaInformada: `e${i}` }, p)))
    expect(resultados.filter((r) => r.resultado === 'SENHA_INCORRETA')).toHaveLength(5)
    expect(resultados.filter((r) => r.resultado === 'LIMITE_DE_TENTATIVAS')).toHaveLength(7)
    expect(lento).toHaveBeenCalledTimes(5)
  })

  it('senha certa zera as falhas', async () => {
    const { p } = portas()
    for (let i = 0; i < 4; i += 1) await executarStepUp({ userId: 'u1', senhaInformada: `e${i}` }, p)
    expect((await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).resultado).toBe('OK')
    for (let i = 0; i < 4; i += 1) expect((await executarStepUp({ userId: 'u1', senhaInformada: `f${i}` }, p)).resultado).toBe('SENHA_INCORRETA')
  })

  it('erro NOSSO (banco fora) propaga e DEVOLVE a vaga — não é falha do usuário', async () => {
    let falhar = true
    const { p } = portas({ buscarPasswordHash: async () => { if (falhar) throw new Error('banco fora'); return HASH } })
    for (let i = 0; i < 10; i += 1) await expect(executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).rejects.toThrow('banco fora')
    falhar = false
    expect((await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).resultado).toBe('OK') // 10 erros nossos não trancaram ninguém
  })

  // MUDANÇA DELIBERADA (Vega, decisão do Atlas, F5.8): este teste documentava o FAIL-OPEN da reserva (Redis fora => a senha continuava sendo avaliada, limitada só pela rota:
  // 10 erradas/min). Agora a RESERVA é fail-closed: Redis fora => THROTTLE_INDISPONIVEL, SEM buscar a senha nem rodar o compare, e com alerta. Os passos DEPOIS da reserva seguem fail-open.
  it('Redis fora na RESERVA (fail-closed): THROTTLE_INDISPONIVEL, sem buscar a senha nem rodar o compare, com alerta payment_gateway_stepup_unavailable', async () => {
    const buscar = vi.fn(async () => HASH)
    const { p, alertas, compare } = portas({ comTimeout: async (_acao, fallback) => fallback, buscarPasswordHash: buscar })
    expect(await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).toEqual({ resultado: 'THROTTLE_INDISPONIVEL' })
    expect(await executarStepUp({ userId: 'u1', senhaInformada: 'errada' }, p)).toEqual({ resultado: 'THROTTLE_INDISPONIVEL' })
    expect(buscar).not.toHaveBeenCalled()
    expect(compare).not.toHaveBeenCalled()
    expect(alertas).toEqual([
      { alerta: 'payment_gateway_stepup_unavailable', campos: { actorUserId: 'u1' } },
      { alerta: 'payment_gateway_stepup_unavailable', campos: { actorUserId: 'u1' } },
    ])
  })

  it('Redis cai DEPOIS da reserva (registrar/zerar a falha): fail-open — o veredito da senha não muda', async () => {
    let chamadas = 0
    const { p } = portas({ comTimeout: async (acao, fallback) => (++chamadas === 1 ? acao() : fallback) })
    expect((await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).resultado).toBe('OK')
    chamadas = 0
    expect((await executarStepUp({ userId: 'u2', senhaInformada: 'errada' }, p)).resultado).toBe('SENHA_INCORRETA')
  })
})

// A1 da Íris (F5.8): a reserva abandonada por timeout pode executar DEPOIS no Redis; se resolver tarde como allowed, a vaga tem de ser devolvida (senão o 503 tranca o admin).
describe('executarStepUp — reserva abandonada por timeout que resolve TARDE (A1: vaga vazada)', () => {
  /** throttle cuja reserva só resolve quando o teste manda; `release` é um espião. */
  function throttleComReservaControlada() {
    let resolver!: (g: LoginGate) => void
    let rejeitar!: (e: Error) => void
    const reserveAttempt = vi.fn(() => new Promise<LoginGate>((res, rej) => { resolver = res; rejeitar = rej }))
    const release = vi.fn(async () => {})
    const throttle = { reserveAttempt, release, registerFailure: vi.fn(async () => ({ lockedNow: false, lockSeconds: 0, failures: 0 })), registerSuccess: vi.fn(async () => {}) } as unknown as LoginThrottle
    return { throttle, release, resolver: (g: LoginGate) => resolver(g), rejeitar: (e: Error) => rejeitar(e) }
  }
  /** `comTimeout` que DESISTE na hora (timeout de 500 ms simulado): dispara a ação, ignora o resultado e devolve o fallback — mas só para a reserva; o release devolve o que a ação fizer. */
  const comTimeoutQueDesiste = (): PortasStepUp['comTimeout'] => {
    let primeira = true
    return async (acao, fallback) => {
      if (primeira) {
        primeira = false
        void acao().catch(() => {}) // o comando já foi enviado ao Redis; o app só para de esperar
        return fallback
      }
      return acao().catch(() => fallback)
    }
  }
  const esvaziarMicrotarefas = () => new Promise((r) => setTimeout(r, 0))

  it('reserva tardia ALLOWED (com vaga): 503 sem tentar a senha E release chamado UMA vez, com a chave do usuário', async () => {
    const c = throttleComReservaControlada()
    const buscar = vi.fn(async () => HASH)
    const { p, alertas, compare } = portas({ throttle: c.throttle, comTimeout: comTimeoutQueDesiste(), buscarPasswordHash: buscar })
    expect(await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).toEqual({ resultado: 'THROTTLE_INDISPONIVEL' }) // fail-closed intacto
    expect(c.release).not.toHaveBeenCalled() // ainda não chegou ao Redis
    c.resolver({ allowed: true, failures: 3 })
    await esvaziarMicrotarefas()
    expect(c.release).toHaveBeenCalledTimes(1)
    expect(c.release).toHaveBeenCalledWith('stepup:u1')
    expect(buscar).not.toHaveBeenCalled()
    expect(compare).not.toHaveBeenCalled()
    expect(alertas.map((a) => a.alerta)).toEqual(['payment_gateway_stepup_unavailable', 'payment_gateway_stepup_late_reservation_released'])
    expect(JSON.stringify(alertas)).not.toContain(CERTA)
  })

  it('reserva tardia ALLOWED sem `failures` (não houve reserva): nada a devolver', async () => {
    const c = throttleComReservaControlada()
    const { p } = portas({ throttle: c.throttle, comTimeout: comTimeoutQueDesiste() })
    await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)
    c.resolver({ allowed: true })
    await esvaziarMicrotarefas()
    expect(c.release).not.toHaveBeenCalled()
  })

  it('reserva tardia NEGADA (locked/full — não escreveu nada no Redis): release NÃO é chamado', async () => {
    const c = throttleComReservaControlada()
    const { p, alertas } = portas({ throttle: c.throttle, comTimeout: comTimeoutQueDesiste() })
    expect((await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).resultado).toBe('THROTTLE_INDISPONIVEL')
    c.resolver({ allowed: false, retryAfterSeconds: 60 })
    await esvaziarMicrotarefas()
    expect(c.release).not.toHaveBeenCalled()
    expect(alertas.map((a) => a.alerta)).toEqual(['payment_gateway_stepup_unavailable'])
  })

  it('reserva tardia com ERRO (rejeita): release NÃO é chamado e não vira unhandled rejection', async () => {
    const naoTratadas: unknown[] = []
    const ouvinte = (motivo: unknown) => naoTratadas.push(motivo)
    process.on('unhandledRejection', ouvinte)
    try {
      const c = throttleComReservaControlada()
      const { p } = portas({ throttle: c.throttle, comTimeout: comTimeoutQueDesiste() })
      expect((await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).resultado).toBe('THROTTLE_INDISPONIVEL')
      c.rejeitar(new Error('ECONNRESET'))
      await new Promise((r) => setTimeout(r, 20))
      expect(c.release).not.toHaveBeenCalled()
      expect(naoTratadas).toEqual([])
    } finally {
      process.off('unhandledRejection', ouvinte)
    }
  })

  it('release que FALHA no caminho tardio é engolido (best-effort): sem unhandled rejection', async () => {
    const naoTratadas: unknown[] = []
    const ouvinte = (motivo: unknown) => naoTratadas.push(motivo)
    process.on('unhandledRejection', ouvinte)
    try {
      const c = throttleComReservaControlada()
      c.release.mockRejectedValue(new Error('redis caiu de novo'))
      let primeiraFeita = false
      const comTimeoutQuePropagaNoRelease: PortasStepUp['comTimeout'] = async (acao, fallback) => {
        if (!primeiraFeita) { primeiraFeita = true; void acao().catch(() => {}); return fallback }
        return acao() // propaga a rejeição do release: o pior caso para o `.catch` do núcleo
      }
      const { p } = portas({ throttle: c.throttle, comTimeout: comTimeoutQuePropagaNoRelease })
      await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)
      c.resolver({ allowed: true, failures: 1 })
      await new Promise((r) => setTimeout(r, 20))
      expect(c.release).toHaveBeenCalledTimes(1)
      expect(naoTratadas).toEqual([])
    } finally {
      process.off('unhandledRejection', ouvinte)
    }
  })

  it('CAMINHO NORMAL (a reserva responde dentro do prazo): nenhum release extra — a vaga usada de verdade não é devolvida (senha certa, errada e usuário inexistente)', async () => {
    const store = storeEmMemoria()
    const release = vi.spyOn(store, 'release')
    const throttle = createLoginThrottle(store, { ...DEFAULT_LOGIN_THROTTLE, maxFailures: 5 })
    const { p, alertas } = portas({ throttle })
    expect((await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).resultado).toBe('OK')
    expect((await executarStepUp({ userId: 'u1', senhaInformada: 'errada' }, p)).resultado).toBe('SENHA_INCORRETA')
    await esvaziarMicrotarefas()
    expect(release).not.toHaveBeenCalled()
    expect(alertas.map((a) => a.alerta)).not.toContain('payment_gateway_stepup_late_reservation_released')
  })
})
