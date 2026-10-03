import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { handleMeterValues } from '../../src/ocpp/handlers/meterValues'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { vigiarSessoes } from '../../src/services/sessao/vigiarSessoes'
import { marcarSessaoNaoConfirmada, chaveEnergiaNaMarcacao } from '../../src/services/sessao/marcarSessaoNaoConfirmada'
import { chaveCooldownParada, chaveToquesHumanos, LIMITE_TOQUES_HUMANOS, pedirParadaSessao } from '../../src/services/sessao/pedirParadaSessao'
import { chaveReanimacoes, MAX_REANIMACOES_POR_SESSAO } from '../../src/services/sessao/reanimarSessao'
import { chaveTriggerMeterValues } from '../../src/services/sessao/triggerMeterValues'
import { chamarHandler, comFakeGateway, criarCenario, criarSessao, minutosAtras, type Cenario, cenariosCriados, resolverCapturasPendentes } from './helpers/sessaoTravadaFixture'
import { settle, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * F5.9d (Íris) — verificação INDEPENDENTE de M2, M5, M6 e M7 do Órion, pelos caminhos reais. Tarifa R$ 1,00/kWh.
 *  M2: a janela ONLINE conta desde a RECONEXÃO (`connectedAt`): o Stop enfileirado que chega depois da reconexão fecha como CHARGER; reconectar em loop não
 *      segura a sessão para sempre (teto unconfirmedAt + G2).
 *  M5: marcar STOP_UNCONFIRMED com o carregador ONLINE pede TriggerMessage(MeterValues) na hora; a janela G1 respeita o intervalo de amostragem observado.
 *  M6: toque humano NÃO esgota o teto de tentativas do servidor; humanos têm limite próprio por janela.
 *  M7: MeterValues em buffer (sem energia nova) não reanima; energia nova reanima; teto de reanimações por sessão.
 */

vi.mock('../../src/services/pagamentos/capturarSessaoCartao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/pagamentos/capturarSessaoCartao')>()),
  enqueueCapturarSessaoCartao: vi.fn().mockResolvedValue('ENFILEIRADO'),
}))

const meterValues = (connectorId: number, transactionId: number, energyWh: number, ts: Date) => ({
  connectorId,
  transactionId,
  meterValue: [{ timestamp: ts.toISOString(), sampledValue: [{ value: String(energyWh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
})

describe('F5.9d — M2/M5/M6/M7 do Órion verificados pelos fluxos reais (Postgres + Redis reais)', () => {
  const suffix = uniqueSuffix()
  const killSwitchOriginal = (env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED
  let cen: Cenario
  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const ciclo = () => vigiarSessoes({ chargePointIds: [cen.tenant.chargePointId], aguardarComandos: true })
  const presenca = (data: { connectedAt: Date | null; disconnectedAt?: Date | null }) => prisma.chargePoint.update({ where: { id: cen.tenant.chargePointId }, data: { lastSeenAt: new Date(), disconnectedAt: null, ...data } })

  beforeAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = true
    cen = await criarCenario(suffix, 'm2567')
  })
  afterAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = killSwitchOriginal
    await resolverCapturasPendentes(cenariosCriados)
    await prisma.$disconnect()
    redis.disconnect()
  })

  describe('M2 — a janela online conta desde a reconexão', () => {
    const emConfirmacao = (haMin = 30) =>
      criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], naoConfirmada: { motivo: 'CHARGER_UNREACHABLE', haMin }, iniciouHaMin: 240 })

    it('reconectou agora, sessão em confirmação há 30 min: o 1º ciclo NÃO encerra; o Stop enfileirado chega e fecha como CHARGER com o consumo real (500)', async () => {
      await presenca({ connectedAt: new Date() })
      const s = await emConfirmacao()
      await ciclo()
      expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')
      await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: minutosAtras(25).toISOString(), reason: 'PowerLoss' })
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOPPED')
      expect(linha.closureSource).toBe('CHARGER')
      expect(linha.totalCostCents).toBe(500)
      expect(linha.lateStopReceivedAt).toBeNull()
    })

    it('depois de G1 inteira desde a reconexão, o watchdog encerra (a espera é finita)', async () => {
      await presenca({ connectedAt: minutosAtras(11) })
      const s = await emConfirmacao()
      await ciclo()
      expect((await sessao(s.session.id)).status).toBe('STOPPED')
    })

    it('carregador que reconecta em loop não segura a sessão para sempre: unconfirmedAt há 3 h (> G2 de 120 min) e connectedAt = agora ENCERRA mesmo assim', async () => {
      await presenca({ connectedAt: new Date() })
      const s = await emConfirmacao(180)
      await ciclo()
      expect((await sessao(s.session.id)).status).toBe('STOPPED')
    })
  })

  describe('M5 — TriggerMessage na marcação e janela x intervalo de amostragem', () => {
    it('marcar com o carregador ONLINE pede TriggerMessage(MeterValues) com o número OCPP do conector; OFFLINE não pede', async () => {
      await presenca({ connectedAt: minutosAtras(60) })
      const online = await criarSessao(cen, { mode: 'WALLET', status: 'CHARGING', saldoCents: 5_000, amostrasWh: [2_000] })
      const comandos = await comFakeGateway(cen.tenant.chargePointId, { TriggerMessage: 'Accepted' }, async (recebidos) => {
        expect(await marcarSessaoNaoConfirmada({ sessionId: online.session.id, motivo: 'CHARGER_REBOOTED' })).toBe('MARCADA')
        await waitFor(async () => recebidos.some((r) => r.method === 'TriggerMessage'), { timeoutMs: 8_000, what: 'TriggerMessage pós-marcação' })
        return recebidos.filter((r) => r.method === 'TriggerMessage')
      })
      expect(comandos).toHaveLength(1)
      expect(comandos[0]!.params).toMatchObject({ requestedMessage: 'MeterValues', connectorId: online.connector.connectorId })

      await prisma.chargePoint.update({ where: { id: cen.tenant.chargePointId }, data: { disconnectedAt: new Date(), lastSeenAt: minutosAtras(60) } })
      const offline = await criarSessao(cen, { mode: 'WALLET', status: 'CHARGING', saldoCents: 5_000, amostrasWh: [2_000] })
      const semComando = await comFakeGateway(cen.tenant.chargePointId, { TriggerMessage: 'Accepted' }, async (recebidos) => {
        await marcarSessaoNaoConfirmada({ sessionId: offline.session.id, motivo: 'CHARGER_UNREACHABLE' })
        await settle(500)
        return recebidos.filter((r) => r.method === 'TriggerMessage')
      })
      expect(semComando).toHaveLength(0)
      await presenca({ connectedAt: minutosAtras(60) })
    })

    async function sessaoComAmostragemLenta(unconfirmedHaMin: number) {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 1_000, naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: unconfirmedHaMin }, iniciouHaMin: 120 })
      // amostras a cada 15 min (> G1 = 10 min): firmware com MeterValueSampleInterval alto
      for (const [i, wh] of [2_000, 3_000, 4_000].entries()) {
        await prisma.meterSample.create({
          data: { sessionId: s.session.id, chargePointId: cen.tenant.chargePointId, operatorId: cen.tenant.operatorId, ts: new Date(s.inicio.getTime() + (i + 1) * 15 * 60_000), measurand: 'Energy.Active.Import.Register', value: wh, unit: 'Wh', context: 'Sample.Periodic' },
        })
      }
      return s
    }

    it('amostragem de 15 min (> G1 de 10): com 11 min em confirmação o servidor AINDA espera (janela = 1,5 x 15 = 22,5 min); com 23 min encerra', async () => {
      await presenca({ connectedAt: minutosAtras(120) })
      const cedo = await sessaoComAmostragemLenta(11)
      const tarde = await sessaoComAmostragemLenta(23)
      await ciclo()
      expect((await sessao(cedo.session.id)).status, 'fechou a sessão viva antes de o carregador ter chance de mandar a próxima amostra').toBe('STOP_UNCONFIRMED')
      expect((await sessao(tarde.session.id)).status).toBe('STOPPED')
      expect((await sessao(tarde.session.id)).totalCostCents).toBe(300)
    })
  })

  describe('M6 — toque humano não esgota o teto do servidor', () => {
    it('3 toques do motorista: 3 RemoteStop saem, stopAttempts continua 0; o R3 do watchdog ainda reenvia (tentativa 1 do servidor) e a sessão segue ABERTA', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'CHARGING', saldoCents: 5_000, amostrasWh: [2_000], atividadeHaMin: 1 })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        for (let i = 0; i < 3; i++) {
          await redis.del(chaveCooldownParada(s.session.id))
          const r = await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER' })
          expect(r).toMatchObject({ registrado: true, comando: 'ACCEPTED' })
        }
        expect(recebidos.filter((r) => r.method === 'RemoteStopTransaction')).toHaveLength(3)
        expect((await sessao(s.session.id)).stopAttempts).toBe(0)

        // 6 min depois do último pedido, sem Stop: o R3 é do servidor e AINDA tem as 3 tentativas
        await prisma.chargingSession.update({ where: { id: s.session.id }, data: { stopRequestedAt: minutosAtras(6) } })
        await redis.del(chaveCooldownParada(s.session.id))
        await ciclo()
        await settle(300)
        expect(recebidos.filter((r) => r.method === 'RemoteStopTransaction')).toHaveLength(4)
      })
      const linha = await sessao(s.session.id)
      expect(linha.stopAttempts).toBe(1)
      expect(linha.status).toBe('CHARGING')
    })

    it('GUARD e WATCHDOG contam para o teto; passando de LIMITE_TOQUES_HUMANOS toques na janela o toque humano é ignorado (sem comando)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'CHARGING', saldoCents: 5_000, amostrasWh: [2_000] })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        await redis.del(chaveCooldownParada(s.session.id))
        await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'GUARD' })
        expect((await sessao(s.session.id)).stopAttempts).toBe(1)
        await redis.del(chaveToquesHumanos(s.session.id))
        let ignorados = 0
        for (let i = 0; i < LIMITE_TOQUES_HUMANOS + 2; i++) {
          await redis.del(chaveCooldownParada(s.session.id))
          const r = await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER' })
          if (!r.registrado && r.motivo === 'LIMITE_DE_TOQUES') ignorados++
        }
        expect(ignorados).toBe(2)
        await settle(300)
        expect(recebidos.filter((r) => r.method === 'RemoteStopTransaction')).toHaveLength(1 + LIMITE_TOQUES_HUMANOS)
      })
      expect((await sessao(s.session.id)).stopAttempts).toBe(1)
    })
  })

  describe('M7 — reanimação só com energia NOVA, e com teto', () => {
    async function marcar(sessionId: string, energiaEsperada: number) {
      expect(await marcarSessaoNaoConfirmada({ sessionId, motivo: 'STOP_REJECTED' })).toBe('MARCADA')
      await waitFor(async () => (await redis.get(chaveEnergiaNaMarcacao(sessionId))) === String(energiaEsperada), { timeoutMs: 8_000, what: 'energia da marcação guardada' })
    }

    it('MeterValues em buffer (energia <= a da marcação) move o relógio mas NÃO reanima; energia maior reanima', async () => {
      await presenca({ connectedAt: minutosAtras(60) })
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'CHARGING', saldoCents: 5_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000] })
      await comFakeGateway(cen.tenant.chargePointId, { TriggerMessage: 'Accepted' }, async () => {
        await marcar(s.session.id, 3_000)
        await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, 2_500, minutosAtras(3))) // buffer antigo
        await settle(150)
        expect((await sessao(s.session.id)).lastMeterValuesAt!.getTime()).toBeGreaterThan((await sessao(s.session.id)).unconfirmedAt!.getTime())
        await ciclo()
        expect((await sessao(s.session.id)).status, 'buffer sem energia nova reanimou a sessão').toBe('STOP_UNCONFIRMED')

        await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, 3_600, new Date())) // entregou mais
        await settle(150)
        await ciclo()
        expect((await sessao(s.session.id)).status).toBe('CHARGING')
      })
    })

    it(`teto: depois de ${MAX_REANIMACOES_POR_SESSAO} reanimações a sessão NÃO reanima de novo e segue em confirmação (vai-e-vem do R2 contido)`, async () => {
      await presenca({ connectedAt: minutosAtras(60) })
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'CHARGING', saldoCents: 5_000, meterStartWh: 1_000, amostrasWh: [2_000] })
      await redis.del(chaveReanimacoes(s.session.id), chaveTriggerMeterValues(s.session.id))
      let energia = 2_000
      await comFakeGateway(cen.tenant.chargePointId, { TriggerMessage: 'Accepted' }, async () => {
        for (let volta = 1; volta <= MAX_REANIMACOES_POR_SESSAO + 1; volta++) {
          await marcar(s.session.id, energia)
          energia += 500
          await chamarHandler(handleMeterValues, cen.ctx, meterValues(s.connector.connectorId, s.session.ocppTransactionId, energia, new Date()))
          await settle(120)
          await ciclo()
          const status = (await sessao(s.session.id)).status
          if (volta <= MAX_REANIMACOES_POR_SESSAO) expect(status, `volta ${volta}`).toBe('CHARGING')
          else expect(status, 'a sessão foi reanimada além do teto').toBe('STOP_UNCONFIRMED')
        }
      })
    })
  })
})
