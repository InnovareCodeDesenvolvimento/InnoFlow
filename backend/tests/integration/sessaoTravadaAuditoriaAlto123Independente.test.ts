import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { handleMeterValues } from '../../src/ocpp/handlers/meterValues'
import { handleStatusNotification } from '../../src/ocpp/handlers/statusNotification'
import { withIdempotency } from '../../src/ocpp/idempotency'
import { vigiarSessoes } from '../../src/services/sessao/vigiarSessoes'
import { chamarHandler, criarCenario, criarSessao, debitosDaSessao, minutosAtras, saldo, type Cenario, cenariosCriados, resolverCapturasPendentes } from './helpers/sessaoTravadaFixture'
import { settle, uniqueSuffix } from './helpers/fixtures'

/**
 * F5.9d (Íris) — verificação INDEPENDENTE das correções ALTO-1/2/3 do Órion, pelos caminhos reais (handlers OCPP com idempotência + watchdog), não
 * pelas funções puras. Tarifa R$ 1,00/kWh.
 *
 *  ALTO-1: o custo nunca vira ZERO por exceção. Dois gatilhos do Órion — (a) o carro terminou de carregar DEPOIS da última amostra (`chargingEndedAt` >
 *          `ts` da amostra) e o carregador some: o watchdog encerra com a amostra; (b) StopTransaction com o RTC resetado (timestamp antes de `startedAt`).
 *          Em WALLET e CARD: cobra o consumo real; no cartão a pré-autorização NÃO é cancelada.
 *  ALTO-2: carregador B com o transactionId do A não toca a sessão do A (nem Stop, nem MeterValues) e a amostra forjada não vira a "última amostra" do watchdog.
 *  ALTO-3: `messageId` reaproveitado (contador do firmware zera no reboot) com OUTRA action, OUTRO payload ou fora da janela de 24 h é mensagem NOVA e executa;
 *          a MESMA mensagem repetida continua sendo replay; erro transitório não fica cacheado.
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

describe('F5.9d — correções ALTO-1/2/3 do Órion, verificadas pelos fluxos reais (Postgres + Redis reais)', () => {
  const suffix = uniqueSuffix()
  const killSwitchOriginal = (env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED
  let A: Cenario
  let B: Cenario
  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const ciclo = (c: Cenario) => vigiarSessoes({ chargePointIds: [c.tenant.chargePointId], aguardarComandos: true })
  const naoConf = { motivo: 'CHARGER_UNREACHABLE' as const, haMin: 20 }

  beforeAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = true
    A = await criarCenario(`${suffix}a`, 'alto-a')
    B = await criarCenario(`${suffix}b`, 'alto-b')
  })
  afterAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED?: boolean }).SESSION_WATCHDOG_ENABLED = killSwitchOriginal
    await resolverCapturasPendentes(cenariosCriados)
    await prisma.$disconnect()
    redis.disconnect()
  })

  describe('ALTO-1 — o custo nunca vira zero por exceção', () => {
    it('(a) WALLET: o carro terminou DEPOIS da última amostra e o carregador sumiu: o watchdog encerra COBRANDO a amostra (200), com débito — não de graça', async () => {
      const s = await criarSessao(A, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf, saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], iniciouHaMin: 60 })
      // última amostra = início + 2 min; o carro terminou de carregar 20 min depois (depois da amostra)
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { chargingEndedAt: new Date(s.inicio.getTime() + 20 * 60_000) } })
      const r = await ciclo(A)
      expect(r.falhas).toBe(0)
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOPPED')
      expect(linha.totalCostCents, 'não pode fechar com 0').toBe(200)
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
      expect(await saldo(s.wallet.id)).toBe(9_800)
    })

    it('(a) CARD: mesma coisa — captura pendente de 200 e a pré-autorização NÃO é cancelada (VOID)', async () => {
      const s = await criarSessao(A, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], iniciouHaMin: 60, autorizadoCents: 5_000 })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { chargingEndedAt: new Date(s.inicio.getTime() + 20 * 60_000) } })
      await ciclo(A)
      expect((await sessao(s.session.id)).totalCostCents).toBe(200)
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { chargingSessionId: s.session.id } })
      expect(intent.status).toBe('CAPTURE_PENDING')
      expect(intent.captureAmountCents).toBe(200)
    })

    it('(b) WALLET: StopTransaction com timestamp ANTES do início (RTC resetado) fecha cobrando a energia real (500), não zero', async () => {
      const s = await criarSessao(A, { mode: 'WALLET', status: 'CHARGING', saldoCents: 10_000, meterStartWh: 1_000, iniciouHaMin: 30 })
      const antesDoInicio = new Date(s.inicio.getTime() - 3_600_000).toISOString()
      const r = await chamarHandler(handleStopTransaction, A.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: antesDoInicio, reason: 'Local' })
      expect(r.idTagInfo.status).toBe('Accepted')
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOPPED')
      expect(linha.totalCostCents).toBe(500)
      expect(linha.stoppedAt!.getTime(), 'o instante final nunca fica antes do início').toBeGreaterThanOrEqual(linha.startedAt.getTime())
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
    })

    it('(b) CARD: o mesmo Stop com RTC resetado captura 500 e NÃO cancela a pré-autorização', async () => {
      const s = await criarSessao(A, { mode: 'CARD', status: 'CHARGING', meterStartWh: 1_000, iniciouHaMin: 30, autorizadoCents: 5_000 })
      await chamarHandler(handleStopTransaction, A.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: new Date(s.inicio.getTime() - 3_600_000).toISOString() })
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { chargingSessionId: s.session.id } })
      expect(intent.status).toBe('CAPTURE_PENDING')
      expect(intent.captureAmountCents).toBe(500)
    })

    it('(b) com janela de ociosidade (FINISHING, chargingEndedAt) E timestamp antes do início: fecha, não lança, e o total não é zero', async () => {
      const s = await criarSessao(A, { mode: 'WALLET', status: 'FINISHING', saldoCents: 10_000, meterStartWh: 0, iniciouHaMin: 30 })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { chargingEndedAt: minutosAtras(5) } })
      await chamarHandler(handleStopTransaction, A.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 4_000, timestamp: new Date(s.inicio.getTime() - 7_200_000).toISOString() })
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOPPED')
      expect(linha.totalCostCents).toBe(400)
    })
  })

  describe('ALTO-2 — o carregador B não toca a sessão do A', () => {
    it('Stop e MeterValues de B com o transactionId do A: nada muda no A; o alerta de erro sai; a amostra forjada não vira a última amostra do watchdog', async () => {
      const erros: Array<Record<string, unknown>> = []
      const original = logger.error.bind(logger)
      vi.spyOn(logger, 'error').mockImplementation(((obj: unknown, ...resto: unknown[]) => {
        if (obj && typeof obj === 'object' && 'alert' in obj) erros.push(obj as Record<string, unknown>)
        return (original as (...a: unknown[]) => unknown)(obj, ...resto)
      }) as never)

      const s = await criarSessao(A, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: { motivo: 'CHARGER_UNREACHABLE', haMin: 20 }, saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], atividadeHaMin: 20, lastMeterValuesHaMin: 20 })
      const antes = await sessao(s.session.id)
      const amostrasAntes = await prisma.meterSample.count({ where: { sessionId: s.session.id } })
      const tx = s.session.ocppTransactionId

      // B (outro operador, outro carregador) diz que a transação do A acabou e forja leituras gigantes
      const rStop = await chamarHandler(handleStopTransaction, B.ctx, { transactionId: tx, meterStop: 999_000, timestamp: new Date().toISOString(), reason: 'Local' })
      await chamarHandler(handleMeterValues, B.ctx, meterValues(1, tx, 888_000, new Date()))
      expect(rStop.idTagInfo.status).toBe('Accepted') // o carregador B recebe resposta normal (não vira oráculo de "esse id existe")
      await settle(200)

      const depois = await sessao(s.session.id)
      expect(depois.status).toBe('STOP_UNCONFIRMED')
      expect(depois.lastMeterValuesAt?.getTime()).toBe(antes.lastMeterValuesAt?.getTime())
      expect(depois.lastActivityAt?.getTime()).toBe(antes.lastActivityAt?.getTime())
      expect(depois.totalCostCents).toBeNull()
      expect(await prisma.meterSample.count({ where: { sessionId: s.session.id } })).toBe(amostrasAntes)
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
      expect(erros.some((e) => e.alert === 'ocpp_foreign_transaction' && e.chargePointId === B.tenant.chargePointId)).toBe(true)
      vi.restoreAllMocks()

      // o watchdog do A encerra com a leitura REAL do A (3.000 => 200), nunca com a forjada
      await ciclo(A)
      const fechada = await sessao(s.session.id)
      expect(fechada.status).toBe('STOPPED')
      expect(fechada.meterStopWh).toBe(3_000)
      expect(fechada.totalCostCents).toBe(200)
    })
  })

  describe('ALTO-3 — messageId reaproveitado só é replay se for a MESMA mensagem', () => {
    const base = () => ({ chargePointId: A.tenant.chargePointId, operatorId: A.tenant.operatorId })
    const msg = () => `iris-${Math.random().toString(36).slice(2, 10)}`

    it('mesma action + mesmo payload (retransmissão): UMA execução; a segunda devolve a resposta guardada', async () => {
      const id = msg()
      let n = 0
      const run = async () => ({ n: ++n })
      const r1 = await withIdempotency({ ...base(), ocppMessageId: id, action: 'StopTransaction', rawPayload: { transactionId: 1, meterStop: 10 }, run })
      const r2 = await withIdempotency({ ...base(), ocppMessageId: id, action: 'StopTransaction', rawPayload: { meterStop: 10, transactionId: 1 }, run }) // chaves em outra ordem
      expect(n).toBe(1)
      expect(r2).toEqual(r1)
    })

    it('mesmo messageId e action, payload DIFERENTE: é mensagem nova — executa', async () => {
      const id = msg()
      let n = 0
      const run = async () => ({ n: ++n })
      await withIdempotency({ ...base(), ocppMessageId: id, action: 'StopTransaction', rawPayload: { transactionId: 1, meterStop: 10 }, run })
      await withIdempotency({ ...base(), ocppMessageId: id, action: 'StopTransaction', rawPayload: { transactionId: 2, meterStop: 10 }, run })
      expect(n).toBe(2)
    })

    it('mesmo messageId e payload, OUTRA action: executa', async () => {
      const id = msg()
      let n = 0
      const run = async () => ({ n: ++n })
      await withIdempotency({ ...base(), ocppMessageId: id, action: 'StatusNotification', rawPayload: { x: 1 }, run })
      await withIdempotency({ ...base(), ocppMessageId: id, action: 'StopTransaction', rawPayload: { x: 1 }, run })
      expect(n).toBe(2)
    })

    it('mesma mensagem, mas a primeira foi há mais de 24 h (fora da janela): executa de novo', async () => {
      const id = msg()
      let n = 0
      const run = async () => ({ n: ++n })
      await withIdempotency({ ...base(), ocppMessageId: id, action: 'StopTransaction', rawPayload: { transactionId: 7 }, run })
      await prisma.ocppMessage.updateMany({ where: { chargePointId: A.tenant.chargePointId, ocppMessageId: id }, data: { receivedAt: new Date(Date.now() - 25 * 3_600_000) } })
      await withIdempotency({ ...base(), ocppMessageId: id, action: 'StopTransaction', rawPayload: { transactionId: 7 }, run })
      expect(n).toBe(2)
    })

    it('erro TRANSITÓRIO não fica guardado (o reenvio executa); erro DETERMINÍSTICO (FormatViolation) é guardado e reaparece sem executar', async () => {
      const idT = msg()
      let n = 0
      await expect(withIdempotency({ ...base(), ocppMessageId: idT, action: 'StopTransaction', rawPayload: { t: 1 }, run: async () => { n++; throw new Error('banco fora') } })).rejects.toThrow('banco fora')
      const ok = await withIdempotency({ ...base(), ocppMessageId: idT, action: 'StopTransaction', rawPayload: { t: 1 }, run: async () => ({ n: ++n }) })
      expect(ok).toEqual({ n: 2 }) // executou de novo

      const idD = msg()
      let m = 0
      const fv = () => Object.assign(new Error('payload inválido'), { rpcErrorCode: 'FormatViolation' })
      await expect(withIdempotency({ ...base(), ocppMessageId: idD, action: 'StopTransaction', rawPayload: { t: 2 }, run: async () => { m++; throw fv() } })).rejects.toThrow('payload inválido')
      await expect(withIdempotency({ ...base(), ocppMessageId: idD, action: 'StopTransaction', rawPayload: { t: 2 }, run: async () => { m++; return {} } })).rejects.toThrow('payload inválido')
      expect(m).toBe(1)
    })

    it('ponta a ponta: contador do firmware zerou no reboot — o Stop de OUTRA sessão com o MESMO messageId fecha a sessão (não é engolido como replay)', async () => {
      const s1 = await criarSessao(A, { mode: 'WALLET', status: 'CHARGING', saldoCents: 5_000, meterStartWh: 0 })
      const s2 = await criarSessao(A, { mode: 'WALLET', status: 'CHARGING', saldoCents: 5_000, meterStartWh: 0 })
      const id = msg()
      await chamarHandler(handleStopTransaction, A.ctx, { transactionId: s1.session.ocppTransactionId, meterStop: 1_000, timestamp: new Date().toISOString() }, id)
      expect((await sessao(s1.session.id)).status).toBe('STOPPED')
      const r2 = await chamarHandler(handleStopTransaction, A.ctx, { transactionId: s2.session.ocppTransactionId, meterStop: 2_000, timestamp: new Date().toISOString() }, id)
      expect(r2.idTagInfo.status).toBe('Accepted')
      const l2 = await sessao(s2.session.id)
      expect(l2.status, 'o Stop reaproveitando o messageId foi engolido como replay').toBe('STOPPED')
      expect(l2.totalCostCents).toBe(200)
      // e uma StatusNotification com o mesmo id não interfere
      await chamarHandler(handleStatusNotification, A.ctx, { connectorId: s2.connector.connectorId, errorCode: 'NoError', status: 'Available' }, id)
    })
  })

})
