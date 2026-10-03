import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { marcarSessaoNaoConfirmada, chaveEnergiaNaMarcacao } from '../../src/services/sessao/marcarSessaoNaoConfirmada'
import { reanimarSessao, chaveReanimacoes, MAX_REANIMACOES_POR_SESSAO } from '../../src/services/sessao/reanimarSessao'
import { encerrarSessaoPeloServidor } from '../../src/services/sessao/encerrarSessaoPeloServidor'
import { chaveCooldownParada, chaveToquesHumanos, LIMITE_TOQUES_HUMANOS, pedirParadaSessao } from '../../src/services/sessao/pedirParadaSessao'
import { chaveTriggerMeterValues } from '../../src/services/sessao/triggerMeterValues'
import { vigiarSessoes } from '../../src/services/sessao/vigiarSessoes'
import { chamarHandler, comFakeGateway, criarCenario, cenariosCriados, criarSessao, minutosAtras, resolverCapturasPendentes, tokenDoMotorista, type Cenario } from './helpers/sessaoTravadaFixture'
import { createUser, uniqueSuffix, waitFor, settle } from './helpers/fixtures'
import type { FotoDaSessao } from '../../src/services/sessao/travarSessao'

const cancelar = vi.hoisted(() => ({ travar: false }))
vi.mock('../../src/services/pagamentos/cancelarPreAutorizacaoCartao', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/pagamentos/cancelarPreAutorizacaoCartao')>()
  return { ...real, cancelarPreAutorizacaoCartao: (...a: Parameters<typeof real.cancelarPreAutorizacaoCartao>) => (cancelar.travar ? new Promise<never>(() => undefined) : real.cancelarPreAutorizacaoCartao(...a)) }
})
vi.mock('../../src/services/pagamentos/capturarSessaoCartao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/pagamentos/capturarSessaoCartao')>()),
  enqueueCapturarSessaoCartao: vi.fn().mockResolvedValue('ENFILEIRADO'),
}))

/**
 * Órion, M5 (sessão viva fechada: TriggerMessage na marcação e G1 x intervalo de amostragem), M6 (toque humano não esgota o teto), M7 (reanimar só com energia
 * nova; teto de reanimações), M8 (disjuntor de Redis no ciclo; VOID da Cielo com prazo) e BAIXO-1 (alertas pelo limitador). Postgres + Redis reais.
 */
describe('Auditoria F5.9 — M5/M6/M7/M8 (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const killSwitchOriginal = env.SESSION_WATCHDOG_ENABLED
  let cen: Cenario
  const naoConf = (haMin: number) => ({ motivo: 'CHARGER_UNREACHABLE' as const, haMin })

  beforeAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED: boolean }).SESSION_WATCHDOG_ENABLED = true
    cen = await criarCenario(suffix, 'm58')
  })
  afterEach(() => {
    cancelar.travar = false
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED: boolean }).SESSION_WATCHDOG_ENABLED = killSwitchOriginal
    await resolverCapturasPendentes(cenariosCriados)
    await prisma.$disconnect()
    redis.disconnect()
  })

  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const foto = (l: Awaited<ReturnType<typeof sessao>>): FotoDaSessao => ({ status: l.status, lastActivityAt: l.lastActivityAt, lastMeterValuesAt: l.lastMeterValuesAt, stopRequestedAt: l.stopRequestedAt, stopAttempts: l.stopAttempts, unconfirmedAt: l.unconfirmedAt })
  function espiarAlertas() {
    const alertas: Array<{ nivel: string; alert: string }> = []
    for (const nivel of ['info', 'warn', 'error'] as const) {
      vi.spyOn(logger, nivel).mockImplementation(((obj: unknown) => {
        if (obj && typeof obj === 'object' && 'alert' in obj) alertas.push({ nivel, alert: String((obj as Record<string, unknown>).alert) })
      }) as never)
    }
    return alertas
  }
  const ciclo = (c: Cenario, extra: Parameters<typeof vigiarSessoes>[0] = {}) => vigiarSessoes({ chargePointIds: [c.tenant.chargePointId], aguardarComandos: true, ...extra })

  describe('M5 — marcar com o carregador ONLINE pede uma amostra na hora (TriggerMessage); G1 respeita o intervalo de amostragem', () => {
    it('online: TriggerMessage(MeterValues) com o NÚMERO OCPP do conector; NotImplemented = nada a fazer (a sessão segue em confirmação)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, amostrasWh: [2_000] })
      await comFakeGateway(cen.tenant.chargePointId, { TriggerMessage: 'NotImplemented' }, async (recebidos) => {
        expect(await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CHARGER_REBOOTED' })).toBe('MARCADA')
        await waitFor(async () => recebidos.some((c) => c.method === 'TriggerMessage'), { what: 'TriggerMessage pós-marcação' })
        expect(recebidos.find((c) => c.method === 'TriggerMessage')?.params).toEqual({ requestedMessage: 'MeterValues', connectorId: s.connector.connectorId })
        await settle(200)
      })
      expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')
    })

    it('carregador OFFLINE: não manda TriggerMessage (não chegaria)', async () => {
      const off = await criarCenario(suffix, 'm5off')
      await prisma.chargePoint.update({ where: { id: off.tenant.chargePointId }, data: { lastSeenAt: minutosAtras(30), disconnectedAt: minutosAtras(29) } })
      const s = await criarSessao(off, { mode: 'WALLET', saldoCents: 5_000, amostrasWh: [2_000] })
      await comFakeGateway(off.tenant.chargePointId, {}, async (recebidos) => {
        await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CHARGER_UNREACHABLE' })
        await settle(500)
        expect(recebidos.filter((c) => c.method === 'TriggerMessage')).toHaveLength(0)
      })
    })

    it('cooldown compartilhado com o R4: já houve TriggerMessage para esta sessão na janela => não manda outro', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, amostrasWh: [2_000] })
      await redis.set(chaveTriggerMeterValues(s.session.id), String(Date.now()), 'EX', 600)
      await comFakeGateway(cen.tenant.chargePointId, {}, async (recebidos) => {
        await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CHARGER_REBOOTED' })
        await settle(500)
        expect(recebidos.filter((c) => c.method === 'TriggerMessage')).toHaveLength(0)
      })
    })

    it('amostragem a cada 15 min: a sessão em confirmação há 11 min NÃO é encerrada (G1 de 10 min fecharia com o carro carregando); com amostras de 1 min, é', async () => {
      const lenta = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [1_000, 2_000, 3_000], espacamentoAmostrasMin: 15, naoConfirmada: naoConf(11), iniciouHaMin: 120 })
      const rapida = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [1_000, 2_000, 3_000], espacamentoAmostrasMin: 1, naoConfirmada: naoConf(11) })
      await ciclo(cen)
      expect((await sessao(lenta.session.id)).status).toBe('STOP_UNCONFIRMED')
      expect((await sessao(rapida.session.id)).status).toBe('STOPPED')
    })

    it('o confirmDeadline do detalhe mostra a MESMA janela esticada (a UI não promete o que o watchdog não faz)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [1_000, 2_000, 3_000], espacamentoAmostrasMin: 15, naoConfirmada: naoConf(3), iniciouHaMin: 120 })
      const r = await request(app).get(`/api/me/sessions/${s.session.id}`).set({ Authorization: `Bearer ${tokenDoMotorista(s.driver.id)}` })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      const unconfirmedAt = (await sessao(s.session.id)).unconfirmedAt!
      expect(r.body.closure.confirmDeadline).toBe(new Date(unconfirmedAt.getTime() + 22.5 * 60_000).toISOString())
    })

    it('encerrar sem NENHUMA leitura após RemoteStop recusado: alerta de ERRO session_closed_without_meter_reading (risco D2/D4 explícito)', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 30 } })
      await encerrarSessaoPeloServidor({ sessionId: s.session.id })
      expect(alertas.find((a) => a.alert === 'session_closed_without_meter_reading')?.nivel).toBe('error')
    })
  })

  describe('M6 — toque humano não esgota o teto de tentativas do servidor', () => {
    it('7 toques do motorista (cooldown liberado a cada um): stopAttempts continua 0 e a reanimação NÃO fica bloqueada', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, amostrasWh: [2_000] })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async () => {
        for (let i = 0; i < LIMITE_TOQUES_HUMANOS; i++) {
          await redis.del(chaveCooldownParada(s.session.id))
          expect(await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER' })).toMatchObject({ registrado: true })
        }
      })
      expect((await sessao(s.session.id)).stopAttempts).toBe(0)

      // e depois de marcada, com MeterValues novos, a sessão REANIMA (com stopAttempts=3 do jeito antigo ficaria bloqueada para sempre)
      await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'STOP_REJECTED' })
      await redis.set(chaveEnergiaNaMarcacao(s.session.id), '1000', 'EX', 600)
      await prisma.meterSample.create({ data: { sessionId: s.session.id, chargePointId: cen.tenant.chargePointId, operatorId: cen.tenant.operatorId, ts: new Date(), measurand: 'Energy.Active.Import.Register', value: 9_000, unit: 'Wh' } })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { lastMeterValuesAt: new Date(Date.now() + 1_000), lastActivityAt: new Date() } })
      await ciclo(cen)
      expect((await sessao(s.session.id)).status).toBe('CHARGING')
    })

    it('limite PRÓPRIO dos toques humanos: acima de LIMITE_TOQUES_HUMANOS na janela, o toque é ignorado (nenhum comando) — fora isso, Redis fora não vira martelada', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000 })
      await redis.set(chaveToquesHumanos(s.session.id), String(LIMITE_TOQUES_HUMANOS), 'EX', 300)
      await comFakeGateway(cen.tenant.chargePointId, {}, async (recebidos) => {
        expect(await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'ADMIN' })).toEqual({ registrado: false, motivo: 'LIMITE_DE_TOQUES' })
        expect(recebidos).toHaveLength(0)
      })
    })

    it('GUARD e WATCHDOG continuam contando para o teto (o servidor segue limitado a SESSION_STOP_MAX_ATTEMPTS)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000 })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async () => {
        for (const quem of ['GUARD', 'WATCHDOG'] as const) {
          await redis.del(chaveCooldownParada(s.session.id))
          await pedirParadaSessao({ sessionId: s.session.id, solicitante: quem })
        }
      })
      expect((await sessao(s.session.id)).stopAttempts).toBe(2)
    })
  })

  describe('M7 — reanimar só com energia nova; teto de reanimações; alertas limitados', () => {
    async function pendente(energiaNaMarcacao: number | null, amostraWh: number) {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [amostraWh], naoConfirmada: naoConf(3), lastMeterValuesHaMin: 1, stopRequestedHaMin: 4 })
      if (energiaNaMarcacao !== null) await redis.set(chaveEnergiaNaMarcacao(s.session.id), String(energiaNaMarcacao), 'EX', 600)
      return s
    }

    it('MeterValues em BUFFER (energia = a da marcação): NÃO reanima, sem alerta de erro falso', async () => {
      const alertas = espiarAlertas()
      const s = await pendente(2_000, 2_000)
      await ciclo(cen)
      expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')
      expect(alertas.filter((a) => a.alert === 'session_revived_after_unconfirmed' || a.alert === 'session_stop_not_obeyed')).toHaveLength(0)
    })

    it('energia NOVA (maior que a da marcação): reanima; chave de referência perdida: reanima pelo critério antigo', async () => {
      const nova = await pendente(2_000, 3_500)
      const perdida = await pendente(null, 2_000)
      await ciclo(cen)
      expect((await sessao(nova.session.id)).status).toBe('CHARGING')
      expect((await sessao(perdida.session.id)).status).toBe('CHARGING')
    })

    it('marcar guarda a energia da marcação (referência do U1) quando há leitura', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [1_000, 2_500] })
      await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CHARGER_REBOOTED' })
      await waitFor(async () => (await redis.get(chaveEnergiaNaMarcacao(s.session.id))) === '2500', { what: 'energia guardada na marcação' })
    })

    it(`teto de reanimações: depois de ${MAX_REANIMACOES_POR_SESSAO} a sessão NÃO reanima mais (segue em confirmação até o U2), com UM alerta de erro por hora`, async () => {
      const alertas = espiarAlertas()
      const s = await pendente(1_000, 3_000)
      await redis.set(chaveReanimacoes(s.session.id), String(MAX_REANIMACOES_POR_SESSAO), 'EX', 600)
      expect(await reanimarSessao({ sessionId: s.session.id, fotoEsperada: foto(await sessao(s.session.id)) })).toBe('TETO_DE_REANIMACOES')
      expect(await reanimarSessao({ sessionId: s.session.id, fotoEsperada: foto(await sessao(s.session.id)) })).toBe('TETO_DE_REANIMACOES')
      expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')
      expect(alertas.filter((a) => a.alert === 'session_revived_after_unconfirmed')).toHaveLength(1)
    })

    it('cada reanimação incrementa o contador; o alerta de reanimação sai UMA vez mesmo marcando/reanimando de novo (BAIXO-1)', async () => {
      const alertas = espiarAlertas()
      const s = await pendente(1_000, 3_000)
      expect(await reanimarSessao({ sessionId: s.session.id, fotoEsperada: foto(await sessao(s.session.id)) })).toBe('REANIMADA')
      await waitFor(async () => (await redis.get(chaveReanimacoes(s.session.id))) === '1', { what: 'contador de reanimações' })
      await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CONNECTOR_IDLE' })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { lastMeterValuesAt: new Date(Date.now() + 500) } })
      expect(await reanimarSessao({ sessionId: s.session.id, fotoEsperada: foto(await sessao(s.session.id)) })).toBe('REANIMADA')
      expect(alertas.filter((a) => a.alert === 'session_revived_after_unconfirmed')).toHaveLength(1)
      expect(alertas.filter((a) => a.alert === 'session_stop_unconfirmed')).toHaveLength(1) // marcada 1x neste teste (a fixture já nasce marcada)
    })
  })

  describe('M8 — falha de infraestrutura não derruba o ciclo', () => {
    it('Redis que NÃO responde: a 1ª sessão paga o prazo da guarda, as outras PULAM o R6 (disjuntor) e o resto da vigilância (encerrar vencidas) segue', async () => {
      const c = await criarCenario(suffix, 'm8redis')
      const ids: string[] = []
      for (let i = 0; i < 5; i++) ids.push((await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, atividadeHaMin: 5 })).session.id) // todas caem no R6
      const vencida = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, meterStartWh: 0, amostrasWh: [1_000], naoConfirmada: naoConf(30) })

      vi.spyOn(redis, 'get').mockImplementation((() => new Promise(() => undefined)) as never) // o Redis "parou de responder"
      const t0 = Date.now()
      const r = await vigiarSessoes({ chargePointIds: [c.tenant.chargePointId], aguardarComandos: true, guardaPrazoMs: 400 })
      const duracao = Date.now() - t0
      vi.restoreAllMocks()

      expect(duracao, `ciclo levou ${duracao} ms — sem o disjuntor seriam 5 x o prazo`).toBeLessThan(400 * 3)
      expect(r.falhas).toBeLessThanOrEqual(1) // só a que pagou o prazo
      expect((await sessao(vencida.session.id)).status).toBe('STOPPED') // a vigilância de verdade (U2) não foi atrasada
      expect(ids).toHaveLength(5)
    })

    it('VOID da pré-autorização na Cielo que TRAVA: o encerramento volta no prazo (5 s), a sessão fica STOPPED e o próximo VOID nem espera (disjuntor)', async () => {
      const a = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf(30) })
      const b = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf(30) })
      cancelar.travar = true
      const t0 = Date.now()
      await encerrarSessaoPeloServidor({ sessionId: a.session.id, politicaSemLeitura: 'NO_CHARGE' })
      const primeiro = Date.now() - t0
      const t1 = Date.now()
      await encerrarSessaoPeloServidor({ sessionId: b.session.id, politicaSemLeitura: 'NO_CHARGE' })
      const segundo = Date.now() - t1
      cancelar.travar = false

      expect(primeiro).toBeGreaterThanOrEqual(4_500)
      expect(primeiro).toBeLessThan(9_000)
      expect(segundo).toBeLessThan(2_000) // disjuntor aberto: não espera
      for (const s of [a, b]) {
        expect((await sessao(s.session.id)).status).toBe('STOPPED')
        // o intent segue AUTHORIZED com a sessão STOPPED: é exatamente o caso que o varredor de pré-autorizações (caso A) repete
        expect((await prisma.paymentIntent.findFirstOrThrow({ where: { chargingSessionId: s.session.id } })).status).toBe('AUTHORIZED')
      }
    }, 30_000)
  })
})
