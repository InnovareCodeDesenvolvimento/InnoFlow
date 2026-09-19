import { afterAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import Redis from 'ioredis'
import type { Prisma } from '@prisma/client'

// Mesmo recurso de `loginThrottleRedis.test.ts`: a API fala com o Redis por um proxy TCP desta suíte,
// então "Redis fora do ar" é derrubar o proxy — o Redis compartilhado nunca é tocado. Hoisted: tem que
// valer antes de `lib/env` ser importado.
const { proxy, realRedisUrl } = await vi.hoisted(async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  process.env.REDIS_URL = proxy.url
  return { proxy, realRedisUrl }
})

import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { publishToUser, publisherStatus, PUBLISH_CIRCUIT_OPEN_MS, PUBLISH_TIMEOUT_MS, userChannel } from '../../src/realtime/bus'
import { finalizarSessao } from '../../src/services/carteira/finalizarSessao'
import { liquidarSessao } from '../../src/services/carteira/liquidarSessao'
import { createTenant, createUser, makeIdTag, uniqueSuffix, waitFor } from './helpers/fixtures'

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
 * Corrigido (Vega, 2026-09-19): `publish` agora NÃO enfileira com a conexão sabidamente fora, dá prazo
 * (500ms) ao comando e tem disjuntor + teto de pendentes — evento de UI é opcional: o fluxo de negócio
 * responde mesmo sem Redis, e responde logo.
 */

const app = createApp()
const suffix = uniqueSuffix()
const PRAZO_MS = 3_000
const direct = new Redis(realRedisUrl) // inspeção do Redis real, FORA do proxy

afterAll(async () => {
  await proxy.up()
  await direct.quit().catch(() => {})
  redis.disconnect()
  await proxy.stop()
})

/** `true` se a promessa liquidou dentro do prazo; nunca lança. */
async function liquidaEm<T>(p: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))])
}

/** Espera as conexões do processo (a geral e a de PUBLICAÇÃO) voltarem a `ready` (o ioredis reconecta com backoff de até 2s). */
const aguardarRedisPronto = () => waitFor(async () => redis.status === 'ready' && publisherStatus() === 'ready', { timeoutMs: 15_000, what: 'conexões com o Redis prontas' })

const evento = (userId: string, n: number) => ({ type: 'wallet.updated' as const, occurredAt: new Date().toISOString(), userId, balanceCents: n })

describe('Redis fora do ar — fluxos de negócio que só precisam de Postgres', () => {
  it('publishToUser (best-effort, "nunca lança") volta em poucos segundos com o Redis MORTO (antes nunca voltava — ficava na fila do ioredis)', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'outage-publish', suffix })
    expect(await liquidaEm(publishToUser(u.id, evento(u.id, 1)), PRAZO_MS)).toBe(true) // linha de base: com Redis, volta
    await proxy.down()
    try {
      const voltou = await liquidaEm(publishToUser(u.id, evento(u.id, 2)), PRAZO_MS)
      expect(voltou).toBe(true)
    } finally {
      await proxy.up()
    }
  }, 20_000)

  it('ajuste manual de saldo responde 201 em poucos segundos com o Redis MORTO (antes o dinheiro era gravado, mas a resposta HTTP pendurava esperando o wallet.updated)', async () => {
    const admin = await createUser({ role: 'ADMIN', label: 'outage-admin', suffix })
    const driver = await createUser({ role: 'DRIVER', label: 'outage-driver', suffix })
    const descricao = `Ajuste com Redis fora ${suffix}`

    await proxy.down()
    let resposta: Promise<request.Response> | undefined
    try {
      resposta = Promise.resolve(request(app).post(`/api/admin/drivers/${driver.id}/wallet/entries`).set('Authorization', `Bearer ${admin.token}`).send({ amountCents: 5000, description: descricao }))
      const voltou = await liquidaEm(resposta, PRAZO_MS)

      // O razão foi gravado no Postgres.
      const gravado = await waitFor(() => prisma.walletEntry.findFirst({ where: { description: descricao } }), { what: 'WalletEntry gravado apesar do Redis fora' })
      expect(gravado.amountCents).toBe(5000)

      expect(voltou).toBe(true)
      expect((await resposta).status).toBe(201)
    } finally {
      await proxy.up()
      if (resposta) await resposta.catch(() => {})
    }
  }, 30_000)
})

async function motoristaComCarteira(label: string, saldoCents: number) {
  const driver = await createUser({ role: 'DRIVER', label, suffix })
  const token = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driver.id } })
  const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
  await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: saldoCents, balanceAfterCents: saldoCents, referenceType: 'MANUAL', description: 'Saldo inicial de teste' } })
  return { driver, tokenId: token.id, walletId: wallet.id }
}

describe('Redis fora do ar — o fechamento da sessão (StopTransaction / retry do worker) grava o dinheiro e RESPONDE', () => {
  const tariffSnapshot: Prisma.InputJsonValue = { id: 'snap', model: 'PER_KWH', pricePerKwh: '1.00', pricePerMinute: null, sessionFeeCents: null, minChargeCents: null, idleFeePerMinute: 0, idleGracePeriodSeconds: 0, windows: [] }

  it('finalizarSessao (o caminho do StopTransaction) com o Redis MORTO: debita a carteira e volta em poucos segundos (antes: pendurava no publish de session.stopped/wallet.updated com o dinheiro já gravado)', async () => {
    await aguardarRedisPronto()
    const t = await createTenant({ suffix, label: 'outage-fin' })
    const d = await motoristaComCarteira('outage-fin-driver', 10_000)
    const sessao = await prisma.chargingSession.create({
      data: {
        operatorId: t.operatorId, siteId: t.siteId, chargePointId: t.chargePointId, connectorId: t.connectorId, authTokenId: d.tokenId, userId: d.driver.id,
        status: 'STARTED', meterStartWh: 0, startedAt: new Date(Date.now() - 60 * 60_000), tariffId: t.tariffId, tariffSnapshot,
      },
    })

    await proxy.down()
    const t0 = Date.now()
    try {
      const voltou = await liquidaEm(finalizarSessao(sessao.id, { meterStopWh: 10_000, timestamp: new Date(), stopReason: 'LOCAL' }), PRAZO_MS)
      expect(voltou).toBe(true)
      expect(Date.now() - t0).toBeLessThan(PRAZO_MS)
    } finally {
      await proxy.up()
    }
    const fechada = await prisma.chargingSession.findUniqueOrThrow({ where: { id: sessao.id } })
    expect(fechada).toMatchObject({ status: 'STOPPED', energyDeliveredWh: 10_000, totalCostCents: 1000 })
    const debitos = await prisma.walletEntry.findMany({ where: { walletId: d.walletId, type: 'CHARGE_DEBIT' } })
    expect(debitos).toHaveLength(1)
    expect(debitos[0].amountCents).toBe(-1000)
  }, 30_000)

  it('liquidarSessao sem transação do chamador (o retry do worker) com o Redis MORTO: debita e volta em poucos segundos', async () => {
    await aguardarRedisPronto()
    const t = await createTenant({ suffix, label: 'outage-liq' })
    const d = await motoristaComCarteira('outage-liq-driver', 5_000)
    const sessao = await prisma.chargingSession.create({
      data: {
        operatorId: t.operatorId, siteId: t.siteId, chargePointId: t.chargePointId, connectorId: t.connectorId, authTokenId: d.tokenId, userId: d.driver.id,
        status: 'STOPPED', meterStartWh: 0, meterStopWh: 1, energyDeliveredWh: 1, startedAt: new Date(Date.now() - 50 * 60_000), stoppedAt: new Date(Date.now() - 20 * 60_000),
        tariffId: t.tariffId, tariffSnapshot: {} as Prisma.InputJsonValue, totalCostCents: 700,
      },
    })

    await proxy.down()
    try {
      const voltou = await liquidaEm(liquidarSessao(sessao.id), PRAZO_MS)
      expect(voltou).toBe(true)
    } finally {
      await proxy.up()
    }
    const debitos = await prisma.walletEntry.findMany({ where: { walletId: d.walletId, type: 'CHARGE_DEBIT' } })
    expect(debitos).toHaveLength(1)
    expect(debitos[0].amountCents).toBe(-700)
  }, 30_000)
})

describe('Redis fora do ar — o publish tem prazo, disjuntor e NÃO acumula fila', () => {
  it('Redis MORTO: 300 publishes em sequência terminam rápido (não pagam o prazo um a um) e nunca lançam', async () => {
    await aguardarRedisPronto()
    const u = await createUser({ role: 'DRIVER', label: 'outage-seq', suffix })
    await proxy.down()
    const t0 = Date.now()
    try {
      for (let i = 0; i < 300; i++) await publishToUser(u.id, evento(u.id, i))
    } finally {
      await proxy.up()
    }
    expect(Date.now() - t0).toBeLessThan(PRAZO_MS)
  }, 30_000)

  it('Redis TRAVADO (a conexão parece de pé, mas não responde): o 1º publish volta no prazo (~500ms) e os seguintes não pagam o prazo de novo (disjuntor)', async () => {
    await aguardarRedisPronto()
    const u = await createUser({ role: 'DRIVER', label: 'outage-buraco', suffix })
    await new Promise((r) => setTimeout(r, PUBLISH_CIRCUIT_OPEN_MS + 100)) // o teste anterior pode ter deixado o disjuntor aberto
    await proxy.blackhole()
    try {
      const t1 = Date.now()
      await publishToUser(u.id, evento(u.id, 1))
      const primeiro = Date.now() - t1
      expect(primeiro).toBeGreaterThanOrEqual(PUBLISH_TIMEOUT_MS - 50)
      expect(primeiro).toBeLessThan(PRAZO_MS)

      const t2 = Date.now()
      for (let i = 0; i < 20; i++) await publishToUser(u.id, evento(u.id, i))
      expect(Date.now() - t2).toBeLessThan(PUBLISH_TIMEOUT_MS) // 20 seguidos dentro da janela do disjuntor: todos descartados na hora
    } finally {
      await proxy.up()
    }
  }, 30_000)

  it('eventos publicados com o Redis MORTO são DESCARTADOS, não enfileirados: quando o Redis volta, nenhum evento velho é entregue (a fila offline não acumula)', async () => {
    await aguardarRedisPronto()
    const u = await createUser({ role: 'DRIVER', label: 'outage-fila', suffix })
    const assinante = new Redis(realRedisUrl)
    const recebidos: string[] = []
    assinante.on('message', (_canal, msg) => recebidos.push(msg))
    await assinante.subscribe(userChannel(u.id))
    try {
      await proxy.down()
      // Espera o cliente do processo perceber a queda (senão o 1º comando entraria na fila antes de ele saber).
      await waitFor(async () => publisherStatus() !== 'ready', { timeoutMs: 5_000, what: 'cliente perceber a queda' })
      for (let i = 0; i < 50; i++) await publishToUser(u.id, evento(u.id, i))
      await proxy.up()
      await aguardarRedisPronto()
      await new Promise((r) => setTimeout(r, 1_500)) // tempo de sobra para uma fila offline (se existisse) ser despejada
      expect(recebidos).toEqual([])
    } finally {
      await proxy.up()
      await assinante.quit().catch(() => {})
    }
  }, 40_000)

  it('RECUPERAÇÃO: com o Redis de volta o publish volta a ser entregue de verdade ao assinante', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'outage-volta', suffix })
    const assinante = new Redis(realRedisUrl)
    const recebidos: string[] = []
    assinante.on('message', (_canal, msg) => recebidos.push(msg))
    await assinante.subscribe(userChannel(u.id))
    try {
      await proxy.down()
      await publishToUser(u.id, evento(u.id, 1))
      await proxy.up()
      let n = 100
      // O disjuntor fica aberto por ~1s depois de um estouro de prazo e o cliente reconecta com backoff: tenta até chegar.
      await waitFor(
        async () => {
          await publishToUser(u.id, evento(u.id, n++))
          return recebidos.length > 0
        },
        { timeoutMs: 15_000, intervalMs: 300, what: 'publish voltar a ser entregue' },
      )
      expect(JSON.parse(recebidos[0]).userId).toBe(u.id)
    } finally {
      await proxy.up()
      await assinante.quit().catch(() => {})
    }
  }, 40_000)
})
