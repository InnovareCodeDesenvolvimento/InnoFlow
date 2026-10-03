import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import type { Queue } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Íris (02/10/2026) — `reenfileirarCapturasPendentes` olha só as 50 intents `CAPTURE_PENDING` MAIS ANTIGAS (`orderBy updatedAt asc, take 50`) e o
 * intent que atingiu o TETO de reenfileiramentos (o "envenenado": a Cielo diz "pendente" para sempre, cartão cancelado no emissor...) NUNCA muda de
 * `updatedAt` nem sai de `CAPTURE_PENDING` — fica no começo da fila para sempre, ocupando uma das 50 vagas da rodada. Com 50 envenenados o varredor
 * só enxerga eles e NENHUM intent novo é reenfileirado: a rede de segurança do ALTO-1 morre em silêncio (só os alertas `payment_capture_retry_exhausted`,
 * 1x/h por envenenado, continuam). Cada envenenado é um caso que um HUMANO tinha de resolver (apagar a chave do contador) — se não resolve, acumula.
 *
 * BANCO PRÓPRIO (`pgw_*`, mesmo padrão de `paymentGatewayConfig.test.ts`): o varredor olha o banco inteiro e as suítes rodam em paralelo — 50 intents
 * envenenadas num banco compartilhado fariam as OUTRAS suítes de captura passarem fome. Sem Cielo, sem worker: só o que o varredor DECIDE.
 * CAUSA RAIZ: a seleção do lote não exclui o que já é inacionável (teto atingido / em cooldown) e não pagina. CORREÇÃO sugerida: marcar o envenenado no
 * banco (ex.: coluna/estado) ou paginar (cursor por `updatedAt, id`) até juntar 50 intents ACIONÁVEIS; manter o alerta.
 */

const BASE_URL = process.env.DATABASE_URL!
const NOME_BANCO = `pgw_${Math.random().toString(36).slice(2, 10)}`
const URL_BANCO = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${NOME_BANCO}$1`)
const BATCH_SIZE = 50 // `BATCH_SIZE` de reenfileirarCapturasPendentes.ts (não exportado)
const TETO = 100 // CARD_CAPTURE_MAX_SWEEP_RETRIES (default)
const minutosAtras = (m: number) => new Date(Date.now() - m * 60_000)

describe('varredor da captura — intents com o teto atingido não podem fazer os novos passarem fome', () => {
  let adminPrisma: PrismaClient
  let prisma: typeof import('../../src/lib/prisma').prisma
  let redis: typeof import('../../src/lib/redis').redis
  let queue: Queue
  let reenfileirar: typeof import('../../src/services/pagamentos/reenfileirarCapturasPendentes').reenfileirarCapturasPendentes
  let chaveTentativas: typeof import('../../src/services/pagamentos/reenfileirarCapturasPendentes').chaveTentativasCaptura
  let capturaJobId: typeof import('../../src/services/pagamentos/capturarSessaoCartao').capturaJobId
  let userId = ''
  let molde: Prisma.ChargingSessionUncheckedCreateInput // a CHECK exige chargingSessionId (UNIQUE) em CAPTURE_PENDING: uma sessão parada por intent; o varredor nem as lê

  beforeAll(async () => {
    adminPrisma = new PrismaClient({ datasources: { db: { url: BASE_URL } } })
    await adminPrisma.$executeRawUnsafe(`CREATE DATABASE "${NOME_BANCO}"`)
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: URL_BANCO }, stdio: 'pipe', cwd: process.cwd() })
    process.env.DATABASE_URL = URL_BANCO

    const [prismaMod, redisMod, sweepMod, capMod, queuesMod, loggerMod] = await Promise.all([
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/services/pagamentos/reenfileirarCapturasPendentes'),
      import('../../src/services/pagamentos/capturarSessaoCartao'),
      import('../../src/worker/queues'),
      import('../../src/lib/logger'),
    ])
    prisma = prismaMod.prisma
    redis = redisMod.redis
    reenfileirar = sweepMod.reenfileirarCapturasPendentes
    chaveTentativas = sweepMod.chaveTentativasCaptura
    capturaJobId = capMod.capturaJobId
    queue = queuesMod.createQueue(`capturar-sessao-cartao-iris-lote-${Math.random().toString(36).slice(2, 8)}`)
    vi.spyOn(loggerMod.logger, 'error').mockImplementation(() => undefined) // 50 alertas de "teto atingido" não poluem a saída
    vi.spyOn(loggerMod.logger, 'warn').mockImplementation(() => undefined)

    userId = (await prisma.user.create({ data: { role: 'DRIVER', name: 'Motorista lote', email: `lote-${randomUUID()}@example.com` } })).id
    const { createTenant } = await import('./helpers/fixtures') // import DINÂMICO: tem que carregar o `prisma` DEPOIS de trocar a DATABASE_URL
    const t = await createTenant({ suffix: randomUUID().slice(0, 8), label: 'lote-captura' })
    const token = await prisma.authToken.create({ data: { idTag: randomUUID().replace(/-/g, '').slice(0, 20), type: 'VIRTUAL', userId } })
    molde = {
      operatorId: t.operatorId,
      siteId: t.siteId,
      chargePointId: t.chargePointId,
      connectorId: t.connectorId,
      authTokenId: token.id,
      userId,
      status: 'STOPPED',
      meterStartWh: 0,
      meterStopWh: 1000,
      energyDeliveredWh: 1000,
      startedAt: minutosAtras(60),
      stoppedAt: minutosAtras(30),
      tariffId: t.tariffId,
      tariffSnapshot: {},
      totalCostCents: 300,
    }
  }, 120_000)

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => {})
    await queue?.close().catch(() => {})
    await prisma?.$disconnect()
    redis?.disconnect()
    await adminPrisma?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${NOME_BANCO}" WITH (FORCE)`).catch(() => {})
    await adminPrisma?.$disconnect()
  })

  /** Intent parado em CAPTURE_PENDING (`updatedAt` = há `minutos`); `envenenado` = o contador do varredor já está no teto. */
  async function intentParado(minutos: number, envenenado: boolean): Promise<string> {
    const sessao = await prisma.chargingSession.create({ data: molde })
    const intent = await prisma.paymentIntent.create({
      data: {
        userId,
        chargingSessionId: sessao.id,
        purpose: 'SESSION_CARD_CAPTURE',
        provider: 'CIELO_CARD',
        status: 'CAPTURE_PENDING',
        cieloPaymentId: `lote-${randomUUID()}`,
        amountRequestedCents: 1000,
        captureAmountCents: 300,
        updatedAt: minutosAtras(minutos),
      },
    })
    if (envenenado) await redis.set(chaveTentativas(intent.id), String(TETO))
    return intent.id
  }

  it('CONTROLE: com 49 envenenados e 1 novo (cabem no lote de 50), o novo é reenfileirado', async () => {
    for (let i = 0; i < BATCH_SIZE - 1; i++) await intentParado(3 * 24 * 60 + i, true)
    const novo = await intentParado(10, false)

    const r = await reenfileirar({ queue })

    expect(r.tetoAtingido).toBe(BATCH_SIZE - 1)
    expect(await redis.get(chaveTentativas(novo))).toBe('1')
    expect(await queue.getJob(capturaJobId(novo))).toBeDefined()
  }, 60_000)

  it('(BUG corrigido — F5.8) com 50 envenenados à frente, um intent NOVO e acionável ainda é reenfileirado (a seleção pagina e não gasta vaga do lote com o teto atingido)', async () => {
    await intentParado(3 * 24 * 60 + 100, true) // o 50º envenenado: agora há 50 no começo da fila
    const novo2 = await intentParado(12, false)

    const r = await reenfileirar({ queue })

    expect(r.tetoAtingido).toBe(BATCH_SIZE) // o lote inteiro foi gasto com os envenenados...
    expect(await redis.get(chaveTentativas(novo2))).toBe('1') // ...e o novo NUNCA foi visto (null)
    expect(await queue.getJob(capturaJobId(novo2))).toBeDefined()
  }, 60_000)

  it('intents em COOLDOWN (reenfileirados há pouco) também não gastam vaga do lote: 50 deles à frente não escondem um intent novo', async () => {
    const chaveCooldown = (await import('../../src/services/pagamentos/reenfileirarCapturasPendentes')).chaveCooldownCaptura
    for (let i = 0; i < BATCH_SIZE; i++) {
      const id = await intentParado(2 * 24 * 60 + i, false)
      await redis.set(chaveCooldown(id), '1', 'EX', 300)
    }
    const novo3 = await intentParado(15, false)

    const r = await reenfileirar({ queue })

    expect(r.reenfileiradas).toBeGreaterThanOrEqual(1)
    expect(await redis.get(chaveTentativas(novo3))).toBe('1')
    expect(await queue.getJob(capturaJobId(novo3))).toBeDefined()
  }, 60_000)
})
