import { afterAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

// Mesmo recurso de `loginThrottleRedis.test.ts`: a API fala com o Redis por um proxy TCP desta suíte,
// então "Redis fora do ar" é derrubar o proxy — o Redis compartilhado nunca é tocado. Hoisted: tem que
// valer antes de `lib/env` ser importado.
const { proxy } = await vi.hoisted(async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const proxy = RedisProxy.fromUrl(process.env.REDIS_URL as string)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy }
})

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { publishToUser } from '../../src/realtime/bus'
import { createUser, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * O que acontece nos FLUXOS DE NEGÓCIO quando o Redis cai (o login já foi coberto em
 * `loginThrottleRedis.test.ts`). Achado da Íris em 2026-09-19 ao classificar as 10 falhas da suíte
 * sem Redis: TODAS eram timeout, e 3 delas eram o ajuste manual de saldo — uma rota que, em princípio,
 * só precisa de Postgres. Causa: `walletLedger.ts` faz `await emitWalletUpdated(...).catch(...)` DEPOIS
 * de gravar; o `publish` (`realtime/bus.ts`) é documentado como "best-effort, NUNCA lança", mas com o
 * Redis fora do ar o ioredis (`maxRetriesPerRequest: null`, exigência do BullMQ) NÃO rejeita: enfileira o
 * comando e espera reconectar. O `.catch` nunca dispara e o `await` nunca volta — a resposta HTTP fica
 * pendurada, com o dinheiro JÁ gravado. Mesmo padrão em `finalizarSessao`/`liquidarSessao` (StopTransaction).
 *
 * `it.fails` = comportamento DESEJADO (evento de UI é opcional: o fluxo de negócio responde mesmo sem
 * Redis). Vire `it` quando o Vega dar prazo ao publish (como `throttleSafely` já faz no login).
 */

const app = createApp()
const suffix = uniqueSuffix()
const PRAZO_MS = 3_000

afterAll(async () => {
  await proxy.up()
  redis.disconnect()
  await proxy.stop()
})

/** `true` se a promessa liquidou dentro do prazo; nunca lança. */
async function liquidaEm<T>(p: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))])
}

describe('Redis fora do ar — fluxos de negócio que só precisam de Postgres', () => {
  it.fails('publishToUser (best-effort, "nunca lança") volta em poucos segundos com o Redis MORTO (FURO: hoje nunca volta — fica na fila do ioredis)', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'outage-publish', suffix })
    expect((await liquidaEm(publishToUser(u.id, { type: 'wallet.updated', occurredAt: new Date().toISOString(), userId: u.id, balanceCents: 1 }), PRAZO_MS))).toBe(true) // linha de base: com Redis, volta
    await proxy.down()
    try {
      const voltou = await liquidaEm(publishToUser(u.id, { type: 'wallet.updated', occurredAt: new Date().toISOString(), userId: u.id, balanceCents: 2 }), PRAZO_MS)
      expect(voltou).toBe(true)
    } finally {
      await proxy.up()
    }
  }, 20_000)

  it.fails('ajuste manual de saldo responde 201 em poucos segundos com o Redis MORTO (FURO: o dinheiro é gravado, mas a resposta HTTP pendura esperando o wallet.updated)', async () => {
    const admin = await createUser({ role: 'ADMIN', label: 'outage-admin', suffix })
    const driver = await createUser({ role: 'DRIVER', label: 'outage-driver', suffix })
    const descricao = `Ajuste com Redis fora ${suffix}`

    await proxy.down()
    let resposta: Promise<request.Response> | undefined
    try {
      resposta = Promise.resolve(request(app).post(`/api/admin/drivers/${driver.id}/wallet/entries`).set('Authorization', `Bearer ${admin.token}`).send({ amountCents: 5000, description: descricao }))
      const voltou = await liquidaEm(resposta, PRAZO_MS)

      // Parte que vale HOJE e prova que é só a resposta que pendura: o razão foi gravado no Postgres.
      const gravado = await waitFor(() => prisma.walletEntry.findFirst({ where: { description: descricao } }), { what: 'WalletEntry gravado apesar do Redis fora' })
      expect(gravado.amountCents).toBe(5000)

      expect(voltou).toBe(true)
    } finally {
      await proxy.up() // o ioredis reconecta e esvazia a fila: a resposta pendurada completa e o teste não deixa nada vivo
      if (resposta) await resposta.catch(() => {})
    }
  }, 30_000)
})
