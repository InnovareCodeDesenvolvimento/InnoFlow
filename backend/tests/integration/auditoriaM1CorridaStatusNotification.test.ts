import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { handleStatusNotification } from '../../src/ocpp/handlers/statusNotification'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { encerrarSessaoPeloServidor } from '../../src/services/sessao/encerrarSessaoPeloServidor'
import { finalizarSessao } from '../../src/services/carteira/finalizarSessao'
import { chamarHandler, criarCenario, criarSessao, debitosDaSessao, minutosAtras, saldo, type Cenario } from './helpers/sessaoTravadaFixture'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * Órion, M1 — re-abertura de sessão por corrida com StatusNotification. O handler lia a sessão aberta (`findFirst`) e depois fazia `update({ status })`
 * SEM condição, fora do lock. Entre os dois o Stop/watchdog commitava STOPPED; o update RESSUSCITAVA a sessão, o watchdog a fechava de novo e
 * `finalizarSessao` (que só checava `status === 'STOPPED'`) recalculava e SOBRESCREVIA `totalCostCents` com débito/captura já gravados.
 */
describe('M1 — StatusNotification não ressuscita sessão encerrada (Postgres + Redis reais)', () => {
  const suffix = uniqueSuffix()
  let cen: Cenario

  beforeAll(async () => {
    cen = await criarCenario(suffix, 'm1')
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const status = (connectorId: number, st: string) => ({ connectorId, errorCode: 'NoError', status: st })

  it('JANELA FORÇADA: o Stop commita STOPPED entre o findFirst e o update do StatusNotification — a sessão continua STOPPED e os totais não mudam', async () => {
    const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [3_000] })
    // Reproduz a janela de forma determinística: o `findFirst` do handler devolve a linha (aberta) e, ANTES de o handler seguir, o Stop fecha a sessão.
    const original = prisma.chargingSession.findFirst.bind(prisma.chargingSession)
    let disparou = false
    vi.spyOn(prisma.chargingSession, 'findFirst').mockImplementation(((args: Parameters<typeof original>[0]) => {
      const promessa = original(args)
      if (disparou || (args as { where?: { connectorId?: string } })?.where?.connectorId !== s.connector.id) return promessa
      disparou = true
      return promessa.then(async (linha) => {
        await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 3_000, timestamp: minutosAtras(1).toISOString() })
        return linha // devolve a linha VELHA (ainda aberta) para o handler
      })
    }) as never)

    await chamarHandler(handleStatusNotification, cen.ctx, status(s.connector.connectorId, 'Charging'))

    const linha = await sessao(s.session.id)
    expect(linha.status).toBe('STOPPED') // antes: voltava a CHARGING
    expect(linha.totalCostCents).toBe(300)
    expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
    expect(await saldo(s.wallet.id)).toBe(9_700)
  })

  it('o MESMO para Finishing, SuspendedEV, SuspendedEVSE e Faulted (todos os ramos do handler são condicionais)', async () => {
    for (const st of ['Finishing', 'SuspendedEV', 'SuspendedEVSE', 'Faulted']) {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [1_000] })
      const original = prisma.chargingSession.findFirst.bind(prisma.chargingSession)
      let disparou = false
      const spy = vi.spyOn(prisma.chargingSession, 'findFirst').mockImplementation(((args: Parameters<typeof original>[0]) => {
        const promessa = original(args)
        if (disparou || (args as { where?: { connectorId?: string } })?.where?.connectorId !== s.connector.id) return promessa
        disparou = true
        return promessa.then(async (linha) => {
          await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 1_000, timestamp: minutosAtras(1).toISOString() })
          return linha
        })
      }) as never)
      await chamarHandler(handleStatusNotification, cen.ctx, status(s.connector.connectorId, st))
      spy.mockRestore()
      expect((await sessao(s.session.id)).status, st).toBe('STOPPED')
    }
  })

  it('finalizarSessao RECUSA refechar sessão que já tem stoppedAt gravado fora de STOPPED (zumbi): totais intactos, volta a STOPPED, nenhum débito novo', async () => {
    const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [3_000] })
    await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 3_000, timestamp: minutosAtras(1).toISOString() })
    const fechada = await sessao(s.session.id)
    // ressuscita À FORÇA (o que o update incondicional antigo fazia)
    await prisma.chargingSession.update({ where: { id: s.session.id }, data: { status: 'CHARGING' } })

    const r = await finalizarSessao(s.session.id, { meterStopWh: 99_999, timestamp: new Date(), stopReason: 'OTHER' })
    expect(r).toEqual({ finalizada: false, motivo: 'JA_ENCERRADA' })

    const depois = await sessao(s.session.id)
    expect(depois.status).toBe('STOPPED')
    expect(depois.totalCostCents).toBe(fechada.totalCostCents)
    expect(depois.meterStopWh).toBe(fechada.meterStopWh)
    expect(depois.stoppedAt?.getTime()).toBe(fechada.stoppedAt?.getTime())
    expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
    expect(await saldo(s.wallet.id)).toBe(9_700)
  })

  it('corrida REAL (probabilística): StatusNotification x Stop do carregador x encerramento do servidor, 10 rodadas — sempre STOPPED, um débito, totais do vencedor', async () => {
    for (let rodada = 0; rodada < 10; rodada++) {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [3_000], naoConfirmada: { motivo: 'CHARGER_UNREACHABLE', haMin: 30 } })
      await Promise.all([
        chamarHandler(handleStatusNotification, cen.ctx, status(s.connector.connectorId, 'Charging')),
        chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 3_000, timestamp: minutosAtras(1).toISOString() }),
        encerrarSessaoPeloServidor({ sessionId: s.session.id }),
      ])
      const linha = await sessao(s.session.id)
      expect(linha.status, `rodada ${rodada}`).toBe('STOPPED')
      expect(await debitosDaSessao(s.session.id), `rodada ${rodada}`).toHaveLength(1)
      expect(linha.totalCostCents).toBe(300)
    }
  })
})
