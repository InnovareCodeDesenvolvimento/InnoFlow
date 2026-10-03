import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { encerrarSessaoPeloServidor } from '../../src/services/sessao/encerrarSessaoPeloServidor'
import { marcarSessaoNaoConfirmada } from '../../src/services/sessao/marcarSessaoNaoConfirmada'
import { avaliarGuardaDeSaldo, carregarSessaoParaGuarda } from '../../src/services/sessao/guardaDeSaldo'
import { chamarHandler, comFakeGateway, criarCenario, cenariosCriados, criarSessao, debitosDaSessao, minutosAtras, resolverCapturasPendentes, saldo, tokenDoMotorista, type Cenario } from './helpers/sessaoTravadaFixture'
import { uniqueSuffix } from './helpers/fixtures'

const falha = vi.hoisted(() => ({ ativa: false }))

// `calcularCustoSessao` real, com um interruptor para simular o bug que o ALTO-1 teme: o cálculo de dinheiro LANÇANDO.
vi.mock('../../src/core/tarifacao/calcularCustoSessao', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/tarifacao/calcularCustoSessao')>()
  return { ...real, calcularCustoSessao: (...args: Parameters<typeof real.calcularCustoSessao>) => (falha.ativa ? (() => { throw new Error('falha simulada no cálculo') })() : real.calcularCustoSessao(...args)) }
})
vi.mock('../../src/services/pagamentos/capturarSessaoCartao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/pagamentos/capturarSessaoCartao')>()),
  enqueueCapturarSessaoCartao: vi.fn().mockResolvedValue('ENFILEIRADO'),
}))

/**
 * Órion, ALTO-1 — "cálculo de custo que lança exceção fecha a sessão de graça, em silêncio". Antes: `catch -> ZERO_CUSTOS` em `finalizarSessao`;
 * a sessão virava STOPPED com custo 0, sem débito, e no cartão a pré-autorização era CANCELADA. Gatilhos reais: `chargingEndedAt` depois da última
 * amostra (o watchdog fecha com o `ts` da amostra) e Stop com RTC resetado (`stoppedAt < startedAt`). Tarifa R$ 1,00/kWh.
 */
describe('ALTO-1 — o custo NUNCA vira zero por exceção (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let cen: Cenario
  const naoConf = { motivo: 'CHARGER_UNREACHABLE' as const, haMin: 30 }

  beforeAll(async () => {
    cen = await criarCenario(suffix, 'alto1')
  })
  afterEach(() => {
    falha.ativa = false
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await resolverCapturasPendentes(cenariosCriados)
    await prisma.$disconnect()
    redis.disconnect()
  })

  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const intentDe = (id: string) => prisma.paymentIntent.findFirstOrThrow({ where: { chargingSessionId: id } })
  function espiarAlertas() {
    const alertas: Array<{ nivel: string; alert: string }> = []
    for (const nivel of ['info', 'warn', 'error'] as const) {
      vi.spyOn(logger, nivel).mockImplementation(((obj: unknown) => {
        if (obj && typeof obj === 'object' && 'alert' in obj) alertas.push({ nivel, alert: String((obj as Record<string, unknown>).alert) })
      }) as never)
    }
    return alertas
  }

  describe('regressão 1: chargingEndedAt DEPOIS da última amostra (o servidor fecha com o ts da amostra)', () => {
    it.each(['WALLET', 'CARD'] as const)('%s: fecha COBRANDO a energia medida (nada de custo zero / void), com stoppedAt = chargingEndedAt', async (mode) => {
      const s = await criarSessao(cen, { mode, status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf, saldoCents: 10_000, meterStartWh: 0, amostrasWh: [1_000, 2_000], iniciouHaMin: 60 })
      // a última amostra é início + 2 min; o carro parou de carregar em início + 10 min
      const fimDaCarga = new Date(s.inicio.getTime() + 10 * 60_000)
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { chargingEndedAt: fimDaCarga } })

      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id })).toMatchObject({ encerrada: true, prova: 'LAST_METER_SAMPLE' })

      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOPPED')
      expect(linha.totalCostCents).toBe(200) // 2 kWh a R$ 1,00 — antes: 0
      expect(linha.stoppedAt!.getTime()).toBe(fimDaCarga.getTime()) // max(ts da amostra, chargingEndedAt, startedAt)
      if (mode === 'WALLET') {
        expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
        expect(await saldo(s.wallet.id)).toBe(9_800)
      } else {
        const intent = await intentDe(s.session.id)
        expect(intent.status).toBe('CAPTURE_PENDING') // NUNCA VOIDED por causa de exceção
        expect(intent.captureAmountCents).toBe(200)
      }
    })

    it('o custo provisório da marcação usa o mesmo instante (não fica null nem 0 por causa da janela)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [1_000, 3_000], iniciouHaMin: 60 })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { chargingEndedAt: new Date(s.inicio.getTime() + 20 * 60_000) } })
      await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CHARGER_UNREACHABLE' })
      expect((await sessao(s.session.id)).provisionalCostCents).toBe(300)
    })
  })

  describe('regressão 2: StopTransaction com RTC resetado (timestamp ANTES do startedAt)', () => {
    it.each(['WALLET', 'CARD'] as const)('%s: o Stop normal fecha cobrando a energia (500), stoppedAt >= startedAt', async (mode) => {
      const s = await criarSessao(cen, { mode, saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000], iniciouHaMin: 30 })
      const r = await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: new Date('2000-01-01T00:00:00Z').toISOString() })
      expect(r.idTagInfo.status).toBe('Accepted')

      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOPPED')
      expect(linha.totalCostCents).toBe(500)
      expect(linha.stoppedAt!.getTime()).toBeGreaterThanOrEqual(linha.startedAt.getTime())
      if (mode === 'WALLET') expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
      else expect((await intentDe(s.session.id)).status).toBe('CAPTURE_PENDING')
    })
  })

  describe('se o cálculo AINDA lançar: aborta, alerta de erro e deixa para revisão manual — nunca fecha de graça', () => {
    it.each(['WALLET', 'CARD'] as const)('%s: encerrar pelo servidor => ABORTADA, STOP_UNCONFIRMED intacto, sem débito, pré-autorização AUTHORIZED (NÃO cancelada), alerta session_cost_calculation_failed (erro)', async (mode) => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode, status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf, saldoCents: 10_000, meterStartWh: 0, amostrasWh: [2_000] })
      falha.ativa = true
      const r = await encerrarSessaoPeloServidor({ sessionId: s.session.id })
      falha.ativa = false

      expect(r).toEqual({ encerrada: false, motivo: 'ABORTADA' })
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOP_UNCONFIRMED')
      expect(linha.totalCostCents).toBeNull()
      expect(linha.stoppedAt).toBeNull()
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
      if (mode === 'CARD') expect((await intentDe(s.session.id)).status).toBe('AUTHORIZED')
      await vi.waitFor(() => expect(alertas.some((a) => a.alert === 'session_cost_calculation_failed' && a.nivel === 'error')).toBe(true))

      // e quando o bug é corrigido, o MESMO caminho fecha normalmente
      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id })).toMatchObject({ encerrada: true })
      expect((await sessao(s.session.id)).totalCostCents).toBe(200)
    })

    it('StopTransaction do carregador com o cálculo falhando: responde Accepted, a sessão NÃO fecha de graça e nada é debitado', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000] })
      falha.ativa = true
      const r = await chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: minutosAtras(1).toISOString() })
      falha.ativa = false
      expect(r.idTagInfo.status).toBe('Accepted')
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('CHARGING')
      expect(linha.totalCostCents).toBeNull()
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
    })

    it('marcar STOP_UNCONFIRMED com o cálculo falhando: marca do mesmo jeito (sem dinheiro), custo provisório NULL — nunca 0', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [2_000] })
      falha.ativa = true
      expect(await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CHARGER_REBOOTED' })).toBe('MARCADA')
      falha.ativa = false
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOP_UNCONFIRMED')
      expect(linha.provisionalCostCents).toBeNull()
    })
  })

  describe('outros pontos que calculavam custo com "agora" (servidor) contra startedAt (carregador)', () => {
    it('guarda de saldo com o relógio do carregador ADIANTADO (startedAt no futuro): não lança e dispara quando deve (antes: fail-open silencioso)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 500, meterStartWh: 1_000 })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { startedAt: new Date(Date.now() + 2 * 3_600_000) } })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async () => {
        const guarda = await carregarSessaoParaGuarda(s.session.id)
        expect(await avaliarGuardaDeSaldo(guarda, 7_000, { aguardarComando: true })).toBe('DISPARADA') // 6 kWh = 600 >= 500
      })
    })

    it('GET /api/me/sessions/active com startedAt no futuro: 200 (antes: o cálculo lançava e o app tomava 500)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, amostrasWh: [2_000] })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { startedAt: new Date(Date.now() + 2 * 3_600_000) } })
      const r = await request(app).get('/api/me/sessions/active').set({ Authorization: `Bearer ${tokenDoMotorista(s.driver.id)}` })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.session.id).toBe(s.session.id)
    })
  })
})
