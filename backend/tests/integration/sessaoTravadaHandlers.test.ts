import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { handleBootNotification, marcarSessoesAbertasAposBoot } from '../../src/ocpp/handlers/bootNotification'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { handleMeterValues } from '../../src/ocpp/handlers/meterValues'
import { handleStatusNotification } from '../../src/ocpp/handlers/statusNotification'
import { marcarSessaoNaoConfirmada } from '../../src/services/sessao/marcarSessaoNaoConfirmada'
import { encerrarSessaoPeloServidor } from '../../src/services/sessao/encerrarSessaoPeloServidor'
import { chamarHandler, comFakeGateway, criarCenario, criarSessao, debitosDaSessao, minutosAtras, saldo, type Cenario } from './helpers/sessaoTravadaFixture'
import { settle, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * F5.9b1 — os HANDLERS OCPP reescritos, contra Postgres + Redis reais. O coração é o D-A do desenho: pelo OCPP 1.6, depois de uma queda de
 * energia o carregador manda o BootNotification e SÓ ENTÃO o StopTransaction que guardou (com o meterStop verdadeiro). Antes, o Boot
 * encerrava a sessão com a última amostra (cobrando a menos) e o Stop caía em "já STOPPED, ignorando".
 *
 * Tarifa R$ 1,00/kWh: 1.000 Wh = 100 centavos.
 */

type AlertaCapturado = { nivel: 'info' | 'warn' | 'error'; alert: string; campos: Record<string, unknown> }

function espiarAlertas(): AlertaCapturado[] {
  const capturados: AlertaCapturado[] = []
  for (const nivel of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, nivel).mockImplementation(((obj: unknown) => {
      if (obj && typeof obj === 'object' && 'alert' in obj) capturados.push({ nivel, alert: String((obj as Record<string, unknown>).alert), campos: obj as Record<string, unknown> })
    }) as never)
  }
  return capturados
}

describe('Handlers OCPP da F5.9 (Postgres + Redis reais)', () => {
  const suffix = uniqueSuffix()
  let cen: Cenario

  beforeAll(async () => {
    cen = await criarCenario(suffix, 'hand')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })

  describe('D-A — BootNotification não fecha mais com dinheiro; o Stop enfileirado depois do Boot fecha de verdade', () => {
    it('Boot com sessão aberta: STOP_UNCONFIRMED(CHARGER_REBOOTED), unconfirmedAt+reason no mesmo UPDATE, custo provisório com a última leitura, NENHUM dinheiro movido', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000] })

      await chamarHandler(handleBootNotification, cen.ctx, { chargePointVendor: 'V', chargePointModel: 'M' })
      await waitFor(async () => (await sessao(s.session.id)).status === 'STOP_UNCONFIRMED', { what: 'marcação pós-boot' })

      const depois = await sessao(s.session.id)
      expect(depois.unconfirmedReason).toBe('CHARGER_REBOOTED')
      expect(depois.unconfirmedAt).not.toBeNull()
      expect(depois.provisionalCostCents).toBe(200) // (3000 - 1000) Wh = 2 kWh = 200 centavos — informativo
      expect(depois.stoppedAt).toBeNull()
      expect(depois.totalCostCents).toBeNull()
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
      expect(await saldo(s.wallet.id)).toBe(10_000)
      expect(alertas.map((a) => a.alert)).toContain('session_stop_unconfirmed')
    })

    it('o StopTransaction que chega DEPOIS do Boot fecha NORMALMENTE: meterStop verdadeiro, closureSource=CHARGER, meterStopSource=STOP_TRANSACTION, cobra o consumo REAL (500, não os 200 da última amostra)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000] })
      await marcarSessoesAbertasAposBoot(cen.ctx) // a mesma função que o Boot dispara em segundo plano
      expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')

      const stopTs = minutosAtras(1).toISOString()
      const resposta = await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: stopTs, reason: 'PowerLoss' })
      expect(resposta.idTagInfo.status).toBe('Accepted')

      const fechada = await sessao(s.session.id)
      expect(fechada.status).toBe('STOPPED')
      expect(fechada.closureSource).toBe('CHARGER')
      expect(fechada.meterStopSource).toBe('STOP_TRANSACTION')
      expect(fechada.meterStopWh).toBe(6_000)
      expect(fechada.energyDeliveredWh).toBe(5_000)
      expect(fechada.totalCostCents).toBe(500)
      expect(fechada.stopReason).toBe('POWER_LOSS')
      expect(fechada.stoppedAt?.toISOString()).toBe(stopTs)
      expect(fechada.lateStopReceivedAt).toBeNull() // fechou normalmente — não é stop tardio

      const debitos = await debitosDaSessao(s.session.id)
      expect(debitos).toHaveLength(1)
      expect(debitos[0]!.amountCents).toBe(-500)
      expect(await saldo(s.wallet.id)).toBe(9_500)
    })

    it('corrida: o Stop fechou a sessão ANTES de a marcação pós-boot rodar — marcar vira NAO_ABERTA, não reabre nem mexe em nada', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [3_000] })
      await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 4_000, timestamp: minutosAtras(1).toISOString() })

      expect(await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CHARGER_REBOOTED' })).toBe('NAO_ABERTA')
      const depois = await sessao(s.session.id)
      expect(depois.status).toBe('STOPPED')
      expect(depois.unconfirmedAt).toBeNull()
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
    })

    it('sessão FAULTED também é marcada no Boot (constante única de estado aberto); STOPPED e STOP_UNCONFIRMED ficam como estavam', async () => {
      const faulted = await criarSessao(cen, { mode: 'WALLET', status: 'FAULTED', saldoCents: 1_000, amostrasWh: [1_500] })
      const jaNaoConfirmada = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 3 } })
      const parada = await criarSessao(cen, { mode: 'WALLET', status: 'STOPPED', saldoCents: 1_000 })

      await marcarSessoesAbertasAposBoot(cen.ctx)

      expect((await sessao(faulted.session.id)).status).toBe('STOP_UNCONFIRMED')
      expect((await sessao(faulted.session.id)).unconfirmedReason).toBe('CHARGER_REBOOTED')
      const nao = await sessao(jaNaoConfirmada.session.id)
      expect(nao.unconfirmedReason).toBe('STOP_REJECTED') // o motivo original NÃO é sobrescrito
      expect((await sessao(parada.session.id)).status).toBe('STOPPED')
    })
  })

  describe('StopTransaction TARDIO (a sessão já foi encerrada pelo servidor)', () => {
    async function sessaoEncerradaPeloServidor(opts: { amostrasWh: number[] }) {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: opts.amostrasWh, status: 'STOP_UNCONFIRMED', naoConfirmada: { motivo: 'CHARGER_UNREACHABLE', haMin: 200 } })
      const r = await encerrarSessaoPeloServidor({ sessionId: s.session.id })
      expect(r).toMatchObject({ encerrada: true, prova: 'LAST_METER_SAMPLE' })
      return s
    }

    it('grava lateStop*/unbilledCostCents, responde Accepted, alerta de ERRO e NÃO mexe em totalCostCents/meterStopWh/carteira (D3: absorve)', async () => {
      const alertas = espiarAlertas()
      const s = await sessaoEncerradaPeloServidor({ amostrasWh: [2_000, 3_000] }) // cobrou 200
      const antes = await sessao(s.session.id)
      expect(antes.totalCostCents).toBe(200)
      expect(antes.closureSource).toBe('SERVER')

      const tsDoStop = minutosAtras(5).toISOString()
      const r = await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: tsDoStop, reason: 'PowerLoss' })
      expect(r.idTagInfo.status).toBe('Accepted')

      const depois = await sessao(s.session.id)
      expect(depois.lateStopMeterWh).toBe(6_000)
      expect(depois.lateStopAt?.toISOString()).toBe(tsDoStop)
      expect(depois.lateStopReceivedAt).not.toBeNull()
      expect(depois.unbilledCostCents).toBe(300) // 500 (o que o Stop diz) - 200 (o que cobramos)
      // nada do que é dinheiro mudou:
      expect(depois.totalCostCents).toBe(200)
      expect(depois.meterStopWh).toBe(antes.meterStopWh)
      expect(depois.energyDeliveredWh).toBe(antes.energyDeliveredWh)
      expect(depois.status).toBe('STOPPED')
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
      expect(await saldo(s.wallet.id)).toBe(9_800)

      const tardio = alertas.find((a) => a.alert === 'session_late_stop_transaction')
      expect(tardio?.nivel).toBe('error') // diferença > 0
      expect(tardio?.campos).toMatchObject({ unbilledCostCents: 300 })
    })

    it('Stop tardio que CONFERE com o cobrado (diferença 0): registra e o alerta é só INFO', async () => {
      const alertas = espiarAlertas()
      const s = await sessaoEncerradaPeloServidor({ amostrasWh: [2_000, 3_000] }) // meterStop cobrado = 3000
      await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 3_000, timestamp: minutosAtras(5).toISOString() })

      const depois = await sessao(s.session.id)
      expect(depois.unbilledCostCents).toBe(0)
      expect(depois.lateStopMeterWh).toBe(3_000)
      expect(alertas.find((a) => a.alert === 'session_late_stop_transaction')?.nivel).toBe('info')
    })

    it('idempotente: um segundo Stop tardio (messageId novo) não sobrescreve o primeiro registro', async () => {
      const s = await sessaoEncerradaPeloServidor({ amostrasWh: [2_000, 3_000] })
      await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: minutosAtras(5).toISOString() })
      const primeiro = await sessao(s.session.id)

      await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 9_999, timestamp: minutosAtras(1).toISOString() })
      const segundo = await sessao(s.session.id)
      expect(segundo.lateStopMeterWh).toBe(6_000)
      expect(segundo.lateStopReceivedAt?.toISOString()).toBe(primeiro.lateStopReceivedAt?.toISOString())
      expect(segundo.unbilledCostCents).toBe(300)
    })

    it('Stop repetido sobre sessão que o PRÓPRIO CARREGADOR fechou é só duplicata: nada de lateStop*', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000] })
      const params = { transactionId: s.session.ocppTransactionId, meterStop: 3_000, timestamp: minutosAtras(2).toISOString() }
      await chamarHandler(handleStopTransaction, cen.ctx, params)
      await chamarHandler(handleStopTransaction, cen.ctx, params) // messageId novo (reconexão)

      const depois = await sessao(s.session.id)
      expect(depois.closureSource).toBe('CHARGER')
      expect(depois.lateStopReceivedAt).toBeNull()
      expect(depois.unbilledCostCents).toBeNull()
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
    })

    it('Stop tardio com leitura MENOR que a cobrada: unbilledCostCents = 0 (nunca negativo; o CHECK >= 0 do banco não estoura)', async () => {
      const s = await sessaoEncerradaPeloServidor({ amostrasWh: [2_000, 3_000] })
      await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 2_500, timestamp: minutosAtras(5).toISOString() })
      expect((await sessao(s.session.id)).unbilledCostCents).toBe(0)
    })
  })

  describe('MeterValues — relógio do SERVIDOR, FAULTED/STOP_UNCONFIRMED e energia depois do fechamento', () => {
    const meterValues = (connectorId: number, transactionId: number, energyWh: number, ts: Date) => ({
      connectorId,
      transactionId,
      meterValue: [{ timestamp: ts.toISOString(), sampledValue: [{ value: String(energyWh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
    })

    it('grava lastActivityAt e lastMeterValuesAt com o relógio do SERVIDOR (new Date()), mesmo com o carregador 3 h atrasado; lastSampleAt segue sendo o do payload', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, atividadeHaMin: 30, lastMeterValuesHaMin: 30 })
      const tsDoCarregador = minutosAtras(180)
      const antes = Date.now()
      await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, 2_000, tsDoCarregador))
      const depois = Date.now()

      const linha = await sessao(s.session.id)
      expect(linha.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(antes - 5)
      expect(linha.lastActivityAt!.getTime()).toBeLessThanOrEqual(depois + 5)
      expect(linha.lastMeterValuesAt!.getTime()).toBeGreaterThanOrEqual(antes - 5)
      expect(linha.lastSampleAt!.toISOString()).toBe(tsDoCarregador.toISOString())
    })

    it('em STOP_UNCONFIRMED também move os relógios (é o que o U1 lê para reanimar) e NÃO muda o status; em STOPPED não mexe neles', async () => {
      const naoConfirmada = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 5 }, atividadeHaMin: 10, lastMeterValuesHaMin: 10 })
      const parada = await criarSessao(cen, { mode: 'WALLET', status: 'STOPPED', atividadeHaMin: null })

      await chamarHandler(handleMeterValues, cen.ctx, meterValues(naoConfirmada.connector.connectorId, naoConfirmada.session.ocppTransactionId, 2_000, new Date()))
      await chamarHandler(handleMeterValues, cen.ctx, meterValues(parada.connector.connectorId, parada.session.ocppTransactionId, 2_000, new Date()))

      const n = await sessao(naoConfirmada.session.id)
      expect(n.status).toBe('STOP_UNCONFIRMED')
      expect(n.lastMeterValuesAt!.getTime()).toBeGreaterThan(n.unconfirmedAt!.getTime())
      const p = await sessao(parada.session.id)
      expect(p.lastActivityAt).toBeNull()
      expect(p.lastMeterValuesAt).toBeNull()
    })

    it('energia MAIOR que o meterStopWh cobrado numa sessão STOPPED: alerta session_metering_after_close (erro) UMA vez por hora; energia igual ou menor: nenhum', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOPPED', saldoCents: 1_000 })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { meterStopWh: 5_000, stoppedAt: new Date(), totalCostCents: 0 } })
      const deAlerta = () => alertas.filter((x) => x.alert === 'session_metering_after_close')

      await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, 5_000, new Date())) // igual
      await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, 4_000, new Date())) // menor
      await settle(300)
      expect(deAlerta()).toHaveLength(0)

      await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, 5_001, new Date()))
      await waitFor(async () => deAlerta().length === 1, { what: 'alerta de energia depois do fechamento' })
      expect(deAlerta()[0]!.nivel).toBe('error')
      expect(deAlerta()[0]!.campos).toMatchObject({ billedMeterStopWh: 5_000, reportedMeterWh: 5_001 })

      // o carregador segue mandando energia a cada amostra: o alerta NÃO se repete (medido no simulador: 42 alertas em 3 min sem este limite)
      await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, 5_050, new Date()))
      await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, 5_100, new Date()))
      await settle(300)
      expect(deAlerta()).toHaveLength(1)
    })

    it('a guarda de saldo agora olha sessão FAULTED: saldo estourado => pede a parada com stopRequestedBy=GUARD', async () => {
      // Saldo de 500 centavos; 6 kWh entregues = 600 centavos >= limite => dispara. FAULTED não estava na lista antiga.
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'FAULTED', saldoCents: 500, meterStartWh: 1_000 })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, 7_000, new Date()))
        const linha = await waitFor(async () => {
          const l = await sessao(s.session.id)
          return l.stopRequestedBy ? l : null
        }, { what: 'pedido de parada da guarda' })
        expect(linha.stopRequestedBy).toBe('GUARD')
        expect(linha.stopAttempts).toBe(1)
        await waitFor(async () => recebidos.some((c) => c.method === 'RemoteStopTransaction' && c.params.transactionId === s.session.ocppTransactionId), { what: 'RemoteStopTransaction enviado' })
      })
    })
  })

  describe('StatusNotification — relógio do servidor no conector, atividade da sessão e FAULTED -> CHARGING', () => {
    const status = (connectorId: number, st: string, timestamp?: Date) => ({ connectorId, errorCode: 'NoError', status: st, ...(timestamp ? { timestamp: timestamp.toISOString() } : {}) })

    it('Connector.statusReceivedAt = new Date() do servidor, e statusUpdatedAt continua sendo o timestamp do payload (relógio do carregador)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 1_000 })
      const tsDoCarregador = minutosAtras(180)
      const antes = Date.now()
      await chamarHandler(handleStatusNotification, cen.ctx, status(s.connector.connectorId, 'Preparing', tsDoCarregador))
      const c = await prisma.connector.findUniqueOrThrow({ where: { id: s.connector.id } })
      expect(c.statusUpdatedAt!.toISOString()).toBe(tsDoCarregador.toISOString())
      expect(c.statusReceivedAt!.getTime()).toBeGreaterThanOrEqual(antes - 5)
      expect(c.status).toBe('PREPARING')
    })

    it('FAULTED volta a CHARGING quando o carregador avisa Charging (antes ficava FAULTED para sempre)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'FAULTED', saldoCents: 1_000 })
      await chamarHandler(handleStatusNotification, cen.ctx, status(s.connector.connectorId, 'Charging'))
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('CHARGING')
      expect(linha.chargingEndedAt).toBeNull()
    })

    it.each([
      ['Charging', 'CHARGING'],
      ['SuspendedEV', 'FINISHING'],
      ['SuspendedEVSE', 'CHARGING'], // não mexe no status da sessão (decisão do dono), mas é atividade
      ['Finishing', 'FINISHING'],
    ])('%s num conector com sessão aberta move lastActivityAt (relógio do servidor); status da sessão => %s', async (ocpp, esperado) => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'CHARGING', saldoCents: 1_000, atividadeHaMin: 30 })
      const antes = Date.now()
      await chamarHandler(handleStatusNotification, cen.ctx, status(s.connector.connectorId, ocpp, minutosAtras(180)))
      const linha = await sessao(s.session.id)
      expect(linha.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(antes - 5)
      expect(linha.status).toBe(esperado)
    })

    it.each(['Available', 'Preparing', 'Unavailable'])('%s NÃO é atividade da transação: lastActivityAt não se move', async (ocpp) => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'CHARGING', saldoCents: 1_000, atividadeHaMin: 30 })
      const antesDoStatus = (await sessao(s.session.id)).lastActivityAt!.getTime()
      await chamarHandler(handleStatusNotification, cen.ctx, status(s.connector.connectorId, ocpp))
      expect((await sessao(s.session.id)).lastActivityAt!.getTime()).toBe(antesDoStatus)
    })

    it('Faulted marca a sessão FAULTED; sessão STOP_UNCONFIRMED NÃO é tocada por StatusNotification (só MeterValues a reanima)', async () => {
      const aberta = await criarSessao(cen, { mode: 'WALLET', status: 'CHARGING', saldoCents: 1_000 })
      await chamarHandler(handleStatusNotification, cen.ctx, status(aberta.connector.connectorId, 'Faulted'))
      expect((await sessao(aberta.session.id)).status).toBe('FAULTED')

      const naoConf = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: { motivo: 'CONNECTOR_IDLE', haMin: 5 }, atividadeHaMin: 10 })
      const antes = (await sessao(naoConf.session.id)).lastActivityAt!.getTime()
      await chamarHandler(handleStatusNotification, cen.ctx, status(naoConf.connector.connectorId, 'Charging'))
      const depois = await sessao(naoConf.session.id)
      expect(depois.status).toBe('STOP_UNCONFIRMED')
      expect(depois.lastActivityAt!.getTime()).toBe(antes)
    })
  })
})
