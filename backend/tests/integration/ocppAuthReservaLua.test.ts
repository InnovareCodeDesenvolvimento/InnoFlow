import { afterAll, describe, expect, it } from 'vitest'
import { redis } from '../../src/lib/redis'
import { reserveAttempt, settleAttemptFailure, releaseReservations } from '../../src/lib/redisCounter'
import { uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * Os scripts Lua da reserva de tentativa do gateway OCPP (`lib/redisCounter.ts`) contra Redis REAL, direto —
 * sem handshake WebSocket, para provar o que só o Redis prova: atomicidade sob concorrência, TTL de cada
 * contador (o de "em andamento" é CURTO de propósito) e que a recusa não escreve. O caminho completo pelo
 * gateway (handshake -> reserva -> bcrypt -> sucesso/falha) é de `ocppAuthLockoutRedis.test.ts` e de
 * `lockoutReservaConcorrenciaLegitima.test.ts`.
 *
 * Chaves próprias por execução (`test:ocppres:*`): não colidem com as `ocpp:auth:*` das outras suítes.
 */

const suffix = uniqueSuffix()
const created = new Set<string>()
const key = (name: string): string => {
  const k = `test:ocppres:${suffix}:${name}`
  created.add(k)
  return k
}

const WINDOW = 300
const LIMITS = { maxPair: 5, maxIpFailures: 30, maxIpInflight: 100 }
const TTLS = { windowSeconds: WINDOW, inflightSeconds: 60 }

afterAll(async () => {
  if (created.size > 0) await redis.del(...created)
  redis.disconnect()
})

describe('reserveAttempt (Lua) — três contadores: par, falhas do IP, em andamento do IP', () => {
  it('150 reservas PARALELAS de pares diferentes do mesmo IP, teto de concorrência 100: EXATAMENTE 100 entram; as 50 barradas (scope ip) não escrevem nada; as falhas do IP ficam em zero', async () => {
    const ipFailures = key('c-fail')
    const ipInflight = key('c-inflight')
    const resultados = await Promise.all(Array.from({ length: 150 }, (_, i) => reserveAttempt(redis, { pair: key(`c-pair-${i}`), ipFailures, ipInflight }, LIMITS, TTLS)))

    expect(resultados.filter((r) => r.ok)).toHaveLength(100)
    for (const r of resultados.filter((r) => !r.ok)) expect(r).toEqual({ ok: false, scope: 'ip' })
    expect(await redis.get(ipInflight)).toBe('100') // as barradas não incrementaram
    expect(await redis.get(ipFailures)).toBeNull() // tentativa em andamento NÃO é falha
    const pares = await Promise.all(Array.from({ length: 150 }, (_, i) => redis.exists(key(`c-pair-${i}`))))
    expect(pares.filter((n) => n === 1)).toHaveLength(100) // só os 100 admitidos têm chave de par
  })

  it('40 reservas paralelas de um IP com limite de falhas 30: TODAS entram (tentativa em andamento não ocupa vaga de falha) — o caso do site com 40 carregadores atrás do NAT', async () => {
    const ipFailures = key('n-fail')
    const ipInflight = key('n-inflight')
    const resultados = await Promise.all(Array.from({ length: 40 }, (_, i) => reserveAttempt(redis, { pair: key(`n-pair-${i}`), ipFailures, ipInflight }, LIMITS, TTLS)))
    expect(resultados.every((r) => r.ok)).toBe(true)
    // ...e todas terminam com sucesso: nada sobra além das chaves de par que o `del` do sucesso apagaria
    await Promise.all(Array.from({ length: 40 }, () => releaseReservations(redis, [ipInflight])))
    expect(await redis.exists(ipInflight)).toBe(0)
    expect(await redis.exists(ipFailures)).toBe(0)
  })

  it('o contador de "em andamento" nasce com TTL CURTO (o da janela é de 300s): tentativa que morreu no meio não ocupa capacidade por minutos', async () => {
    const ipInflight = key('ttl-inflight')
    const ipFailures = key('ttl-fail')
    await reserveAttempt(redis, { pair: key('ttl-pair'), ipFailures, ipInflight }, LIMITS, TTLS)
    const ttlAndamento = await redis.ttl(ipInflight)
    const ttlPar = await redis.ttl(key('ttl-pair'))
    expect(ttlAndamento).toBeGreaterThan(0)
    expect(ttlAndamento).toBeLessThanOrEqual(60)
    expect(ttlPar).toBeGreaterThan(60) // o par usa a janela
    expect(ttlPar).toBeLessThanOrEqual(WINDOW)
  })

  it('vaga vazada (o processo morreu no meio) se libera sozinha: depois do TTL curto o IP volta a ser admitido, com o par e as falhas intactos', async () => {
    const ipInflight = key('leak-inflight')
    const ipFailures = key('leak-fail')
    const limits = { maxPair: 5, maxIpFailures: 30, maxIpInflight: 2 }
    const ttls = { windowSeconds: WINDOW, inflightSeconds: 1 }
    await reserveAttempt(redis, { pair: key('leak-pair-a'), ipFailures, ipInflight }, limits, ttls)
    await reserveAttempt(redis, { pair: key('leak-pair-b'), ipFailures, ipInflight }, limits, ttls)
    expect(await reserveAttempt(redis, { pair: key('leak-pair-c'), ipFailures, ipInflight }, limits, ttls)).toEqual({ ok: false, scope: 'ip' }) // cheio
    await waitFor(async () => (await redis.exists(ipInflight)) === 0, { timeoutMs: 4_000, what: 'contador em andamento expirar' })
    expect((await reserveAttempt(redis, { pair: key('leak-pair-c'), ipFailures, ipInflight }, limits, ttls)).ok).toBe(true)
    expect(await redis.get(key('leak-pair-a'))).toBe('1') // o par de quem vazou segue contado (janela longa)
  })

  it('falhas do IP no limite: barra com scope ip e NÃO escreve chave (nem par, nem em andamento) — o flood não incha o Redis nem estende o bloqueio', async () => {
    const ipFailures = key('f-fail')
    const ipInflight = key('f-inflight')
    await redis.set(ipFailures, '30', 'EX', WINDOW)
    const r = await reserveAttempt(redis, { pair: key('f-pair'), ipFailures, ipInflight }, LIMITS, TTLS)
    expect(r).toEqual({ ok: false, scope: 'ip' })
    expect(await redis.exists(key('f-pair'), ipInflight)).toBe(0)
    expect(await redis.get(ipFailures)).toBe('30')
  })

  it('par no limite: barra com scope identity_ip (o IP tem precedência, mas aqui o IP está livre) e não escreve', async () => {
    const ipFailures = key('p-fail')
    const ipInflight = key('p-inflight')
    const pair = key('p-pair')
    await redis.set(pair, '5', 'EX', WINDOW)
    const r = await reserveAttempt(redis, { pair, ipFailures, ipInflight }, LIMITS, TTLS)
    expect(r).toEqual({ ok: false, scope: 'identity_ip' })
    expect(await redis.exists(ipInflight, ipFailures)).toBe(0)
    expect(await redis.get(pair)).toBe('5')
  })

  it('a reserva devolve as falhas do IP ANTES desta tentativa (para o alerta) e o par já com ela', async () => {
    const ipFailures = key('r-fail')
    await redis.set(ipFailures, '7', 'EX', WINDOW)
    const r = await reserveAttempt(redis, { pair: key('r-pair'), ipFailures, ipInflight: key('r-inflight') }, LIMITS, TTLS)
    expect(r).toEqual({ ok: true, pairCount: 1, ipFailures: 7 })
  })
})

describe('settleAttemptFailure (Lua) — conta a falha no IP e devolve a vaga de "em andamento" num passo só', () => {
  it('100 falhas PARALELAS: cada uma recebe uma contagem distinta (1..100, sem perda nem duplicata), o TTL da janela nasce com a chave e o "em andamento" volta a zero', async () => {
    const ipFailures = key('s-fail')
    const ipInflight = key('s-inflight')
    await Promise.all(Array.from({ length: 100 }, (_, i) => reserveAttempt(redis, { pair: key(`s-pair-${i}`), ipFailures, ipInflight }, { ...LIMITS, maxIpFailures: 1_000 }, TTLS)))
    expect(await redis.get(ipInflight)).toBe('100')

    const contagens = await Promise.all(Array.from({ length: 100 }, () => settleAttemptFailure(redis, { ipFailures, ipInflight }, WINDOW)))
    expect([...contagens].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(await redis.get(ipFailures)).toBe('100')
    const ttl = await redis.ttl(ipFailures)
    expect(ttl).toBeGreaterThan(0) // nunca sem TTL (bloqueio permanente)
    expect(ttl).toBeLessThanOrEqual(WINDOW)
    expect(await redis.exists(ipInflight)).toBe(0) // a última devolução apaga a chave (0 = ausente)
  })

  it('o TTL das falhas é definido só na criação: a falha seguinte NÃO renova a janela (o atacante não a estende)', async () => {
    const ipFailures = key('t-fail')
    const ipInflight = key('t-inflight')
    await settleAttemptFailure(redis, { ipFailures, ipInflight }, 100)
    await redis.pexpire(ipFailures, 20_000)
    await settleAttemptFailure(redis, { ipFailures, ipInflight }, 100)
    const restante = await redis.pttl(ipFailures)
    expect(restante).toBeGreaterThan(0)
    expect(restante).toBeLessThanOrEqual(20_000)
  })

  it('falha confirmada quando o "em andamento" já expirou (janela do TTL curto): conta a falha e NÃO cria "em andamento" negativo nem sem TTL', async () => {
    const ipFailures = key('e-fail')
    const ipInflight = key('e-inflight') // não existe: expirou
    expect(await settleAttemptFailure(redis, { ipFailures, ipInflight }, WINDOW)).toBe(1)
    expect(await redis.exists(ipInflight)).toBe(0)
  })
})
