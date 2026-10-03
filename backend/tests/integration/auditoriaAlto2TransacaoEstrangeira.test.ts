import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { handleMeterValues } from '../../src/ocpp/handlers/meterValues'
import { encerrarSessaoPeloServidor } from '../../src/services/sessao/encerrarSessaoPeloServidor'
import { vigiarSessoes } from '../../src/services/sessao/vigiarSessoes'
import { chamarHandler, criarCenario, criarSessao, debitosDaSessao, minutosAtras, saldo, type Cenario } from './helpers/sessaoTravadaFixture'
import { uniqueSuffix, waitFor, settle } from './helpers/fixtures'

/**
 * Órion, ALTO-2 — StopTransaction e MeterValues localizavam a sessão só por `ocppTransactionId` (Int sequencial e GLOBAL). Um carregador autenticado de
 * OUTRO operador podia fechar a sessão alheia com `meterStop` arbitrário e forjar MeterValues. Agora o lookup é `{ ocppTransactionId, chargePointId }`.
 */
describe('ALTO-2 — transactionId de OUTRO carregador não mexe na sessão alheia (Postgres + Redis reais)', () => {
  const suffix = uniqueSuffix()
  let A: Cenario
  let B: Cenario

  beforeAll(async () => {
    A = await criarCenario(suffix, 'alto2a')
    B = await criarCenario(suffix, 'alto2b') // OUTRO operador, OUTRO carregador
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  function espiarAlertas() {
    const alertas: Array<{ nivel: string; alert: string; campos: Record<string, unknown> }> = []
    for (const nivel of ['info', 'warn', 'error'] as const) {
      vi.spyOn(logger, nivel).mockImplementation(((obj: unknown) => {
        if (obj && typeof obj === 'object' && 'alert' in obj) alertas.push({ nivel, alert: String((obj as Record<string, unknown>).alert), campos: obj as Record<string, unknown> })
      }) as never)
    }
    return alertas
  }
  const mv = (connectorId: number, transactionId: number | undefined, wh: number) => ({
    connectorId,
    ...(transactionId !== undefined ? { transactionId } : {}),
    meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [{ value: String(wh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
  })

  it('carregador B manda StopTransaction com o transactionId do A: Accepted (o B não fica refém), alerta de ERRO, e a sessão do A NÃO muda (nem fecha, nem debita)', async () => {
    const alertas = espiarAlertas()
    const s = await criarSessao(A, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000] })
    const antes = await sessao(s.session.id)

    const r = await chamarHandler(handleStopTransaction, B.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 1_000_000, timestamp: minutosAtras(1).toISOString() })
    expect(r.idTagInfo.status).toBe('Accepted')

    const depois = await sessao(s.session.id)
    expect(depois).toEqual(antes) // linha INTEIRA idêntica
    expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
    expect(await saldo(s.wallet.id)).toBe(10_000)
    const a = alertas.find((x) => x.alert === 'ocpp_foreign_transaction')
    expect(a?.nivel).toBe('error')
    expect(a?.campos).toMatchObject({ chargePointId: B.tenant.chargePointId, transactionId: s.session.ocppTransactionId, action: 'StopTransaction' })
    for (const k of Object.keys(a!.campos)) expect(['alert', 'chargePointId', 'transactionId', 'action']).toContain(k) // só ids técnicos
  })

  it('o MESMO Stop vindo do carregador DONO continua fechando normalmente (o filtro não quebrou o caminho legítimo)', async () => {
    const s = await criarSessao(A, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000] })
    await chamarHandler(handleStopTransaction, A.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: minutosAtras(1).toISOString() })
    expect(await sessao(s.session.id)).toMatchObject({ status: 'STOPPED', totalCostCents: 500, closureSource: 'CHARGER' })
  })

  it('carregador B forja MeterValues com o transactionId do A: nenhum relógio/amostra da sessão do A se move, nenhuma amostra é ligada à sessão', async () => {
    const alertas = espiarAlertas()
    const s = await criarSessao(A, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000], atividadeHaMin: 10, lastMeterValuesHaMin: 10 })
    const antes = await sessao(s.session.id)
    const amostrasAntes = await prisma.meterSample.count({ where: { sessionId: s.session.id } })

    await chamarHandler(handleMeterValues, B.ctx, mv(1, s.session.ocppTransactionId, 9_999_999))

    expect(await sessao(s.session.id)).toEqual(antes)
    expect(await prisma.meterSample.count({ where: { sessionId: s.session.id } })).toBe(amostrasAntes)
    await waitFor(async () => alertas.some((x) => x.alert === 'ocpp_foreign_transaction' && x.campos.action === 'MeterValues'), { what: 'alerta de MeterValues estrangeiro' })
  })

  it('transactionId que NÃO existe em lugar nenhum: desconhecido, SEM alerta de transação estrangeira', async () => {
    const alertas = espiarAlertas()
    const r = await chamarHandler(handleStopTransaction, B.ctx, { transactionId: 2_000_000_000, meterStop: 1, timestamp: new Date().toISOString() })
    expect(r.idTagInfo.status).toBe('Accepted')
    await settle(200)
    expect(alertas.filter((x) => x.alert === 'ocpp_foreign_transaction')).toHaveLength(0)
  })

  it('amostra FORJADA (sessionId da vítima, chargePointId do atacante) NÃO vira prova: o encerramento pelo servidor usa a leitura legítima', async () => {
    const s = await criarSessao(A, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: { motivo: 'CHARGER_UNREACHABLE', haMin: 30 }, saldoCents: 10_000, meterStartWh: 0, amostrasWh: [2_000] })
    await prisma.meterSample.create({
      data: { sessionId: s.session.id, chargePointId: B.tenant.chargePointId, operatorId: B.tenant.operatorId, ts: new Date(), measurand: 'Energy.Active.Import.Register', value: 50_000, unit: 'Wh' },
    })
    expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id })).toMatchObject({ encerrada: true, prova: 'LAST_METER_SAMPLE' })
    expect(await sessao(s.session.id)).toMatchObject({ meterStopWh: 2_000, totalCostCents: 200 }) // não 50.000 Wh = 5.000 centavos
  })

  it('MeterValues forjado não reanima sessão alheia em STOP_UNCONFIRMED (U1)', async () => {
    const s = await criarSessao(A, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 3 }, saldoCents: 5_000, amostrasWh: [2_000], stopRequestedHaMin: 4 })
    await chamarHandler(handleMeterValues, B.ctx, mv(1, s.session.ocppTransactionId, 3_000))
    await vigiarSessoes({ chargePointIds: [A.tenant.chargePointId], aguardarComandos: true })
    expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')
  })

  it('MeterValues SEM transactionId: grava as amostras sem sessão e alerta (aviso) — BAIXO-3', async () => {
    const alertas = espiarAlertas()
    await chamarHandler(handleMeterValues, A.ctx, mv(1, undefined, 123))
    await waitFor(async () => alertas.some((x) => x.alert === 'ocpp_meter_values_without_transaction' && x.nivel === 'warn'), { what: 'alerta sem transactionId' })
  })
})
