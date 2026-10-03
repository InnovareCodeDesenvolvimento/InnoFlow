import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { registrarConexao } from '../../src/services/estacoes/presencaCarregador'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { vigiarSessoes } from '../../src/services/sessao/vigiarSessoes'
import { chamarHandler, criarCenario, criarSessao, debitosDaSessao, minutosAtras, tokenDoMotorista } from './helpers/sessaoTravadaFixture'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * Órion, M2 — reconexão após queda longa encerrava no 1º ciclo, ANTES do Stop enfileirado. A janela online contava desde a marcação (`unconfirmedAt`): com a
 * sessão em confirmação há 30 min e o carregador visto há 6 s, G1 (10 min) já "venceu". Agora conta desde a RECONEXÃO (`ChargePoint.connectedAt`, relógio do servidor,
 * gravado no handshake).
 */
describe('M2 — a janela online conta desde a reconexão (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const killSwitchOriginal = env.SESSION_WATCHDOG_ENABLED

  beforeAll(() => {
    ;(env as { SESSION_WATCHDOG_ENABLED: boolean }).SESSION_WATCHDOG_ENABLED = true
  })
  afterAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED: boolean }).SESSION_WATCHDOG_ENABLED = killSwitchOriginal
    await prisma.$disconnect()
    redis.disconnect()
  })

  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const naoConf = { motivo: 'CHARGER_UNREACHABLE' as const, haMin: 30 }

  it('o handshake grava ChargePoint.connectedAt com o relógio do SERVIDOR (e a coluna começa nula)', async () => {
    const c = await criarCenario(suffix, 'm2a')
    await prisma.chargePoint.update({ where: { id: c.tenant.chargePointId }, data: { connectedAt: null } })
    const antes = Date.now()
    await registrarConexao(c.ctx)
    const cp = await prisma.chargePoint.findUniqueOrThrow({ where: { id: c.tenant.chargePointId } })
    expect(cp.connectedAt!.getTime()).toBeGreaterThanOrEqual(antes - 5)
    expect(cp.connectedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 5)
  })

  it('D-A para queda longa: carregador volta (connectedAt agora) com a sessão em confirmação há 30 min — o watchdog NÃO encerra no 1º ciclo e o Stop enfileirado fecha COMO CARREGADOR com a leitura real', async () => {
    const c = await criarCenario(suffix, 'm2b')
    await registrarConexao(c.ctx)
    const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], naoConfirmada: naoConf })

    const r = await vigiarSessoes({ chargePointIds: [c.tenant.chargePointId], aguardarComandos: true })
    expect(r.porAcao.ENCERRAR_PELO_SERVIDOR).toBeUndefined()
    expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')

    // o Stop que o carregador guardou chega logo depois da reconexão, com o meterStop verdadeiro
    await chamarHandler(handleStopTransaction, c.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: minutosAtras(25).toISOString() })
    expect(await sessao(s.session.id)).toMatchObject({ status: 'STOPPED', closureSource: 'CHARGER', meterStopSource: 'STOP_TRANSACTION', meterStopWh: 6_000, totalCostCents: 500 })
    expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
  })

  it('sem connectedAt (legado): comportamento antigo — encerra pelo servidor no 1º ciclo; e com G1 contada desde a reconexão, passada ela encerra', async () => {
    const legado = await criarCenario(suffix, 'm2c')
    await prisma.chargePoint.update({ where: { id: legado.tenant.chargePointId }, data: { connectedAt: null } })
    const a = await criarSessao(legado, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [1_000], naoConfirmada: naoConf })
    await vigiarSessoes({ chargePointIds: [legado.tenant.chargePointId], aguardarComandos: true })
    expect((await sessao(a.session.id)).status).toBe('STOPPED')

    const novo = await criarCenario(suffix, 'm2d')
    await prisma.chargePoint.update({ where: { id: novo.tenant.chargePointId }, data: { connectedAt: minutosAtras(11) } })
    const b = await criarSessao(novo, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [1_000], naoConfirmada: naoConf })
    await vigiarSessoes({ chargePointIds: [novo.tenant.chargePointId], aguardarComandos: true })
    expect((await sessao(b.session.id)).status).toBe('STOPPED') // 11 min depois da reconexão: G1 inteira já passou sem Stop
  })

  it('o confirmDeadline do detalhe usa a MESMA conta: connectedAt + 10 min', async () => {
    const c = await criarCenario(suffix, 'm2e')
    const conectouEm = minutosAtras(2)
    await prisma.chargePoint.update({ where: { id: c.tenant.chargePointId }, data: { connectedAt: conectouEm, lastSeenAt: new Date() } })
    const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, naoConfirmada: naoConf })
    const r = await request(app).get(`/api/me/sessions/${s.session.id}`).set({ Authorization: `Bearer ${tokenDoMotorista(s.driver.id)}` })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.closure.confirmDeadline).toBe(new Date(conectouEm.getTime() + 10 * 60_000).toISOString())
  })
})
