import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Mesmo recurso de `redisOutageFilaDePublish.test.ts`: o processo fala com o Redis por um proxy TCP DESTA suíte.
const { proxy } = await vi.hoisted(async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const proxy = RedisProxy.fromUrl(process.env.REDIS_URL as string)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy }
})

// `finalizarSessao` é a ÚNICA coisa substituída: o cenário é "a transação de finalização falhou" (deadlock, constraint, bug) e o handler cai no
// `enqueueLiquidarSessaoRetry`. Tudo o mais (handler OCPP, banco, fila BullMQ, Redis via proxy) é real.
const { finalizarMock } = vi.hoisted(() => ({ finalizarMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined) }))
vi.mock('../../src/services/carteira/finalizarSessao', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/services/carteira/finalizarSessao')>()), finalizarSessao: finalizarMock }))

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { enqueueLiquidarSessaoRetry } from '../../src/services/carteira/liquidarSessao'
import { uniqueSuffix } from './helpers/fixtures'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'

/**
 * Íris (02/10/2026) — `enqueueLiquidarSessaoRetry` (chamado por `stopTransaction.ts` quando `finalizarSessao` LANÇA) não tem prazo. O Vega admitiu e
 * deixou assim; aqui se MEDE o que acontece com o Redis fora: o `queue.add` do BullMQ nunca devolve (ioredis com `maxRetriesPerRequest: null`
 * enfileira e espera reconectar) e o handler do StopTransaction — que existe para "responder Accepted de qualquer jeito" — nunca responde.
 * O carregador fica sem resposta até estourar o timeout dele e reenvia o StopTransaction (a sessão segue RUNNING no banco nesse meio-tempo).
 *
 * É a composição de duas falhas (finalização falhando + Redis fora), por isso severidade BAIXA/MÉDIA — mas é exatamente o caso em que o handler
 * promete não pendurar. O mesmo padrão já foi corrigido onde o prazo existe (`finalizarSessao` -> `enqueueCapturarSessaoCartao`, 5 s; `bus.publish`, 500 ms).
 * CAUSA RAIZ: falta `withDeadline` ao redor do `enqueueLiquidarSessaoRetry` em `stopTransaction.ts` (e `createQueue` abre uma conexão por chamada,
 * que também fica pendurada). `it.fails`: ao corrigir, vira `it`.
 */

const PRAZO_ESPERADO_MS = 8_000

/** Resolve com `'respondeu'` ou `'pendurado'` (nunca rejeita): o teste mede se o handler DEVOLVE dentro do prazo. */
const comPrazo = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => 'respondeu' as const, () => 'respondeu' as const), new Promise<'pendurado'>((r) => setTimeout(() => r('pendurado'), ms))])

describe('StopTransaction com a finalização FALHANDO e o Redis fora — o handler tem que responder', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let fx: FixtureCartao

  beforeAll(async () => {
    fx = await criarFixtureCartao(app, suffix, 'stop-liq-redis')
  })

  afterAll(async () => {
    await proxy.up() // solta o que ficou pendurado (o `add` conclui quando o Redis volta) antes de fechar
    await new Promise((r) => setTimeout(r, 500))
    await prisma.$disconnect()
    redis.disconnect()
    await proxy.stop()
  })

  it('CONTROLE: com o Redis saudável, `enqueueLiquidarSessaoRetry` enfileira e devolve na hora', async () => {
    const t0 = Date.now()
    expect(await comPrazo(enqueueLiquidarSessaoRetry(`sessao-inexistente-${suffix}`), PRAZO_ESPERADO_MS)).toBe('respondeu')
    expect(Date.now() - t0).toBeLessThan(PRAZO_ESPERADO_MS)
  })

  it.fails('(BUG) `enqueueLiquidarSessaoRetry` com o Redis FORA devolve dentro do prazo (hoje pendura até o Redis voltar)', async () => {
    await proxy.down()
    try {
      expect(await comPrazo(enqueueLiquidarSessaoRetry(`sessao-inexistente-${suffix}`), PRAZO_ESPERADO_MS)).toBe('respondeu')
    } finally {
      await proxy.up()
    }
  }, 30_000)

  it.fails('(BUG) o handler do StopTransaction responde `Accepted` dentro do prazo quando `finalizarSessao` lança E o Redis está fora (hoje pendura)', async () => {
    finalizarMock.mockRejectedValueOnce(new Error('simulado: a transação de finalização falhou (deadlock)'))
    const parada = fx.sessaoParada('liq-redis-fora', async () => {
      await proxy.down()
      await new Promise((r) => setTimeout(r, 100))
    })
    try {
      expect(await comPrazo(parada, PRAZO_ESPERADO_MS)).toBe('respondeu')
    } finally {
      await proxy.up()
      await parada.catch(() => {}) // quando o Redis volta o `add` pendurado conclui e o handler responde: nada fica solto
    }
  }, 60_000)
})
