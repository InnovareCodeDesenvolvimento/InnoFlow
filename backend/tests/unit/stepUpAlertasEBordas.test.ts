import { describe, expect, it, vi } from 'vitest'
import { createLoginThrottle, DEFAULT_LOGIN_THROTTLE, type ThrottleStore } from '../../src/core/auth/loginThrottle'
import { executarStepUp, type PortasStepUp } from '../../src/core/auth/stepUp'

/**
 * QA da Íris sobre o step-up (F5.8, rodada Vega-2) — fecha dois mutantes que SOBREVIVERAM às suítes do Vega:
 *  - hash vazio ('') aceito como "confere" (a guarda `hash.length > 0` podia sair sem nenhum teste vermelho);
 *  - os dois alertas `payment_gateway_stepup_locked` (o do INSTANTE em que a 5ª falha tranca, com `lockSeconds`, e o das tentativas
 *    seguintes, já recusadas) nunca eram distinguidos: o teste de integração só exige "ao menos um", então apagar qualquer um dos dois
 *    passava. Os dois têm leitores diferentes: o 1º é o aviso "alguém está adivinhando a senha do admin AGORA", o 2º é "continuam tentando".
 */

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

describe('executarStepUp — bordas e alertas (QA Íris, F5.8)', () => {
  it('hash VAZIO ("") nunca confere: SENHA_INCORRETA, sem chamar o compare (mesmo que o compare dissesse "sim")', async () => {
    const compare = vi.fn(async () => true) // se a guarda `hash.length > 0` sair, este "sim" vira acesso
    const { p, alertas } = portas({ buscarPasswordHash: async () => '', compare })
    expect(await executarStepUp({ userId: 'u1', senhaInformada: 'qualquer' }, p)).toEqual({ resultado: 'SENHA_INCORRETA' })
    expect(compare).not.toHaveBeenCalled()
    expect(alertas.map((a) => a.alerta)).toEqual(['payment_gateway_stepup_failed'])
  })

  it('a 5ª falha emite o alerta de TRANCAMENTO com lockSeconds; a 6ª tentativa (já recusada) emite outro, sem lockSeconds', async () => {
    const { p, alertas } = portas()
    for (let i = 1; i <= 4; i += 1) await executarStepUp({ userId: 'u1', senhaInformada: `errada-${i}` }, p)
    expect(alertas.filter((a) => a.alerta === 'payment_gateway_stepup_locked')).toHaveLength(0) // 4 falhas: ainda não trancou

    await executarStepUp({ userId: 'u1', senhaInformada: 'errada-5' }, p)
    const trancou = alertas.filter((a) => a.alerta === 'payment_gateway_stepup_locked')
    expect(trancou, 'o INSTANTE do trancamento precisa de alerta próprio (é quando o dono é avisado)').toEqual([{ alerta: 'payment_gateway_stepup_locked', campos: { actorUserId: 'u1', lockSeconds: 60 } }])

    // 6ª, com a senha CERTA: recusada pelo trancamento, e isso também é alertado (insistência durante o trancamento).
    expect(await executarStepUp({ userId: 'u1', senhaInformada: CERTA }, p)).toMatchObject({ resultado: 'LIMITE_DE_TENTATIVAS' })
    const todos = alertas.filter((a) => a.alerta === 'payment_gateway_stepup_locked')
    expect(todos).toHaveLength(2)
    expect(todos[1]).toEqual({ alerta: 'payment_gateway_stepup_locked', campos: { actorUserId: 'u1' } })
    expect(alertas.filter((a) => a.alerta === 'payment_gateway_stepup_failed')).toHaveLength(5) // a tentativa trancada NÃO conta como falha nova
  })
})
