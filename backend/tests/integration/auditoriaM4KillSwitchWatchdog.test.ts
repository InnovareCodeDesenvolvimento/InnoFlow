import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { createQueue, VIGIAR_SESSOES_QUEUE_NAME } from '../../src/worker/queues'
import { scheduleVigiarSessoesScan } from '../../src/worker/jobs/vigiarSessoesJob'
import { vigiarSessoes } from '../../src/services/sessao/vigiarSessoes'
import { criarCenario, criarSessao, type Cenario } from './helpers/sessaoTravadaFixture'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * Órion, M4 — sem kill-switch do watchdog e rollout sem ordem. `SESSION_WATCHDOG_ENABLED` (default FALSE): desligado, o job NÃO é agendado (e um agendador
 * deixado por um boot anterior é REMOVIDO), e `vigiarSessoes()` não age.
 */
describe('M4 — kill-switch do watchdog (SESSION_WATCHDOG_ENABLED)', () => {
  const suffix = uniqueSuffix()
  let cen: Cenario
  const original = env.SESSION_WATCHDOG_ENABLED
  const ligar = (v: boolean) => {
    ;(env as { SESSION_WATCHDOG_ENABLED: boolean }).SESSION_WATCHDOG_ENABLED = v
  }

  beforeAll(async () => {
    cen = await criarCenario(suffix, 'm4')
  })
  afterEach(() => ligar(original))
  afterAll(async () => {
    const q = createQueue(VIGIAR_SESSOES_QUEUE_NAME)
    await q.removeJobScheduler('vigiar-sessoes-scan').catch(() => undefined)
    await q.close()
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('o DEFAULT do ambiente de teste é desligado (a chave nasce false)', () => {
    expect(original).toBe(false)
  })

  it('desligado: vigiarSessoes() não faz NADA, nem com uma sessão vencida esperando (nenhum efeito, resultado.desligado)', async () => {
    const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, meterStartWh: 0, amostrasWh: [1_000], naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: 60 } })
    ligar(false)
    const r = await vigiarSessoes({ chargePointIds: [cen.tenant.chargePointId], aguardarComandos: true })
    expect(r).toMatchObject({ desligado: true, avaliadas: 0 })
    expect((await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.session.id } })).status).toBe('STOP_UNCONFIRMED')

    ligar(true)
    expect(await vigiarSessoes({ chargePointIds: [cen.tenant.chargePointId], aguardarComandos: true })).toMatchObject({ avaliadas: 1 })
    expect((await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.session.id } })).status).toBe('STOPPED')
  })

  it('desligado: o agendamento NÃO é criado, e um agendador que um boot anterior (ligado) deixou no Redis é REMOVIDO', async () => {
    const q = createQueue(VIGIAR_SESSOES_QUEUE_NAME)
    try {
      ligar(true)
      await scheduleVigiarSessoesScan()
      expect(await q.getJobScheduler('vigiar-sessoes-scan')).toBeTruthy()

      ligar(false)
      await scheduleVigiarSessoesScan()
      expect(await q.getJobScheduler('vigiar-sessoes-scan')).toBeFalsy()
    } finally {
      await q.close()
    }
  })
})
