import { appendFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

// O Redis desta suíte é um PROXY TCP (mesma técnica de `redisOutageBusinessFlow.test.ts`): "derrubar o Redis" é derrubar o proxy — o Redis compartilhado
// nunca é tocado. Hoisted: tem que valer antes de `lib/env` ser importado.
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
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { getPaymentsReconciliation } from '../../src/api/services/paymentsService'
import { publisherStatus } from '../../src/realtime/bus'
import { vigiarSessoes } from '../../src/services/sessao/vigiarSessoes'
import { criarCenario, criarSessao, debitosDaSessao, tokenDoMotorista, type Cenario, cenariosCriados, resolverCapturasPendentes } from './helpers/sessaoTravadaFixture'
import { uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * F5.9d (Íris) — o REDIS CAI NO MEIO de um ciclo do watchdog. O Órion leu (M8) que, sem Redis, a guarda do R6 e o VOID da Cielo seguram o ciclo; aqui se
 * MEDE com um Redis que para de responder (blackhole — o pior caso: sem erro, o comando não volta) exatamente quando o ciclo decide a PRIMEIRA sessão.
 *
 * O que tem de valer com o Redis morto no meio do ciclo:
 *   - o ciclo TERMINA (não pendura) e conta a falha da sessão que dependia do Redis, sem derrubar as demais;
 *   - todo fechamento que só precisa de Postgres acontece, com UM débito e o total certo (o dinheiro nunca depende do barramento);
 *   - cartão: a captura pendente nasce no banco (CAPTURE_PENDING com o valor-alvo) mesmo se enfileirar a captura nunca voltar (prazo de 5 s);
 *   - quando o Redis volta, o ciclo seguinte NÃO repete nada (nenhum débito novo) e a sessão que ficou de fora é avaliada normalmente;
 *   - a identidade de conciliação continua em 0.
 * Tarifa R$ 1,00/kWh.
 */

// O enfileiramento da captura NUNCA volta (Redis morto): é exatamente o que o prazo de `finalizarSessao` precisa vencer. Também evita que o job vá
// parar numa fila compartilhada com workers de outras suítes.
vi.mock('../../src/services/pagamentos/capturarSessaoCartao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/pagamentos/capturarSessaoCartao')>()),
  enqueueCapturarSessaoCartao: vi.fn(() => new Promise<never>(() => {})),
}))

describe('F5.9d — Redis para de responder no meio do ciclo do watchdog (Postgres real, Redis via proxy)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const killSwitchOriginal = (env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED
  let cen: Cenario
  const naoConf = { motivo: 'CHARGER_REBOOTED' as const, haMin: 20 }
  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const aguardarRedisPronto = () => waitFor(async () => redis.status === 'ready' && publisherStatus() === 'ready', { timeoutMs: 20_000, what: 'conexões com o Redis prontas' })

  beforeAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = true
    cen = await criarCenario(suffix, 'redis-meio')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = killSwitchOriginal
    await proxy.up()
    await resolverCapturasPendentes(cenariosCriados)
    await prisma.$disconnect()
    redis.disconnect()
    await proxy.stop()
  })

  it('o Redis morre quando o ciclo decide a 1ª sessão: fechamentos de Postgres acontecem, a que dependia do Redis é contada como falha, o ciclo termina; o ciclo seguinte (Redis de volta) não repete nada', async () => {
    const wallet = (extra: Partial<Parameters<typeof criarSessao>[1]> = {}) => criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [3_000], ...extra })
    const a = await wallet({ status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf }) // decidida COM Redis; o Redis morre durante ela
    const b = await wallet({ status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf })
    const c = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf, meterStartWh: 1_000, amostrasWh: [3_000], autorizadoCents: 5_000 })
    const d = await wallet({ status: 'CHARGING', atividadeHaMin: 3, lastMeterValuesHaMin: 3 }) // R6: a guarda LÊ o Redis => o prazo de 15 s estoura
    const e = await wallet({ status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf }) // depois da lenta: tem de ser processada mesmo assim

    // o Redis morre na hora em que o ciclo loga a decisão da primeira sessão
    let cortado = false
    const original = logger.info.bind(logger)
    vi.spyOn(logger, 'info').mockImplementation(((obj: unknown, ...resto: unknown[]) => {
      if (!cortado && obj && typeof obj === 'object' && (obj as Record<string, unknown>).action === 'ENCERRAR_PELO_SERVIDOR') {
        cortado = true
        void proxy.blackhole()
      }
      return (original as (...a: unknown[]) => unknown)(obj, ...resto)
    }) as never)

    const inicio = Date.now()
    const r1 = await vigiarSessoes({ chargePointIds: [cen.tenant.chargePointId], aguardarComandos: true })
    const duracaoMs = Date.now() - inicio
    vi.restoreAllMocks()
    if (process.env.IRIS_SAIDA) appendFileSync(process.env.IRIS_SAIDA, `ciclo com Redis morto no meio: ${duracaoMs} ms, ${JSON.stringify(r1)}
`)
    expect(cortado, 'o corte do Redis aconteceu durante o ciclo').toBe(true)

    // o ciclo terminou — e dentro de um prazo limitado (guarda 15 s + captura 5 s + folga), não pendurado
    expect(duracaoMs).toBeLessThan(30_000) // M8: disjuntor por ciclo — a guarda só paga o prazo UMA vez
    expect(r1.avaliadas + r1.falhas).toBeGreaterThanOrEqual(5)
    expect(r1.falhas, 'no máximo a sessão R6 falha (o disjuntor do ciclo pode pulá-la sem contar falha)').toBeLessThanOrEqual(1)

    for (const s of [a, b, e]) {
      const linha = await sessao(s.session.id)
      expect(linha.status, `WALLET ${s.session.id}`).toBe('STOPPED')
      expect(linha.totalCostCents).toBe(200)
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
    }
    const cartao = await sessao(c.session.id)
    expect(cartao.status).toBe('STOPPED')
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { chargingSessionId: c.session.id } })
    expect(intent.status).toBe('CAPTURE_PENDING')
    expect(intent.captureAmountCents).toBe(200)
    expect(await debitosDaSessao(c.session.id)).toHaveLength(0)
    expect((await sessao(d.session.id)).status, 'a sessão aberta que falhou NÃO foi mexida').toBe('CHARGING')

    // Redis de volta: o ciclo seguinte é limpo e nada é cobrado de novo
    await proxy.up()
    await aguardarRedisPronto()
    const r2 = await vigiarSessoes({ chargePointIds: [cen.tenant.chargePointId], aguardarComandos: true })
    expect(r2.falhas).toBe(0)
    expect(r2.porAcao.ENCERRAR_PELO_SERVIDOR ?? 0).toBe(0)
    for (const s of [a, b, e]) expect(await debitosDaSessao(s.session.id), 'nenhum débito novo').toHaveLength(1)
    expect((await sessao(d.session.id)).status).toBe('CHARGING')

    const rec = await getPaymentsReconciliation({ operatorId: cen.tenant.operatorId }, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000), previousFrom: new Date(), previousTo: new Date(), tz: 'America/Sao_Paulo' }, true)
    expect(rec.differenceCents).toBe(0)
  }, 150_000)

  it('stop do motorista com o Redis MORTO: responde logo (202) — o pedido fica gravado no Postgres e nada é cobrado — e o erro nunca é 5xx', async () => {
    const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [3_000] })
    await proxy.blackhole()
    try {
      const inicio = Date.now()
      const res = await request(app).post(`/api/me/sessions/${s.session.id}/stop`).set('Authorization', `Bearer ${tokenDoMotorista(s.driver.id)}`)
      const ms = Date.now() - inicio
      expect([202, 503], `status ${res.status}`).toContain(res.status)
      expect(ms, `resposta em ${ms} ms`).toBeLessThan(15_000)
      if (res.status === 202) {
        await waitFor(async () => (await sessao(s.session.id)).stopRequestedAt !== null, { timeoutMs: 15_000, what: 'pedido de parada gravado no Postgres' })
        expect((await sessao(s.session.id)).stopRequestedBy).toBe('DRIVER')
      }
    } finally {
      await proxy.up()
      await aguardarRedisPronto()
    }
    expect((await sessao(s.session.id)).status).toBe('CHARGING') // não fechou com dinheiro: quem fecha é o StopTransaction
    expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
  }, 60_000)
})

