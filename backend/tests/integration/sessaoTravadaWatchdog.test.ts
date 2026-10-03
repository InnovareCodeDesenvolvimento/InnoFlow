import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { logger } from '../../src/lib/logger'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { vigiarSessoes, chaveAlertaLimitado, chaveTriggerMeterValues } from '../../src/services/sessao/vigiarSessoes'
import { chaveEnergiaNoPedidoDeParada } from '../../src/services/sessao/pedirParadaSessao'
import { chamarHandler, comFakeGateway, criarCenario, criarSessao, debitosDaSessao, minutosAtras, saldo, type Cenario, cenariosCriados, resolverCapturasPendentes } from './helpers/sessaoTravadaFixture'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * F5.9b1 — o JOB DO WATCHDOG (`vigiarSessoes`) de ponta a ponta contra Postgres + Redis reais, regra por regra (R1-R6, U1, U2), com a
 * decisão do núcleo puro e os efeitos reais. O ciclo é escopado ao(s) carregador(es) do teste (`chargePointIds`): as suítes dividem o
 * MESMO banco e o watchdog global agiria em sessões das outras. O relógio é injetado (`agora`); as sessões nascem com timestamps
 * relativos ao relógio real.
 *
 * Padrões do núcleo (env): offline >= 10 min + inativo >= 15 min (R1); conector livre >= 5 min (R2); confirmação do stop 5 min, 3
 * tentativas (R3); 24 h (R5); sem MeterValues 15 min (R4); janela G1 10 min online / G2 120 min offline (U2); hold do cartão 48 h.
 */

// A captura de cartão é enfileirada na fila COMPARTILHADA `capturar-sessao-cartao` (Redis único) e outras suítes têm um worker vivo nela
// (`capturaVarredorCooldownEAdiamentoLimpo` conta chamadas): o job de uma sessão DESTA suíte seria consumido por lá e o contaria. Aqui o que
// se prova é o estado ANTES da captura (intent CAPTURE_PENDING com o valor-alvo) — o enfileiramento é trocado por um no-op.
vi.mock('../../src/services/pagamentos/capturarSessaoCartao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/pagamentos/capturarSessaoCartao')>()),
  enqueueCapturarSessaoCartao: vi.fn().mockResolvedValue('ENFILEIRADO'),
}))

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

const TARIFA_POR_MINUTO: Prisma.InputJsonValue = {
  id: 'tariff-snapshot',
  model: 'PER_MINUTE',
  pricePerKwh: null,
  pricePerMinute: '1.00', // R$ 1,00/min = 100 centavos/min
  sessionFeeCents: null,
  minChargeCents: null,
  idleFeePerMinute: 0,
  idleGracePeriodSeconds: 0,
  windows: [],
}

describe('Watchdog de sessões (vigiarSessoes) — Postgres + Redis reais', () => {
  const suffix = uniqueSuffix()
  const killSwitchOriginal = env.SESSION_WATCHDOG_ENABLED

  beforeAll(() => {
    ;(env as { SESSION_WATCHDOG_ENABLED: boolean }).SESSION_WATCHDOG_ENABLED = true // M4: o watchdog nasce DESLIGADO (default false); estes testes o ligam EXPLICITAMENTE
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    ;(env as { SESSION_WATCHDOG_ENABLED: boolean }).SESSION_WATCHDOG_ENABLED = killSwitchOriginal
    await resolverCapturasPendentes(cenariosCriados) // hermético: não deixa CAPTURE_PENDING velho para o varredor de outras suítes
    await prisma.$disconnect()
    redis.disconnect()
  })

  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const cenario = (label: string) => criarCenario(suffix, label)
  const ciclo = (c: Cenario, extra: { agora?: Date; batchSize?: number } = {}) => vigiarSessoes({ chargePointIds: [c.tenant.chargePointId], aguardarComandos: true, ...extra })
  const emMin = (min: number) => new Date(Date.now() + min * 60_000)
  const offline = (c: Cenario, haMin: number) => prisma.chargePoint.update({ where: { id: c.tenant.chargePointId }, data: { lastSeenAt: minutosAtras(haMin + 1), disconnectedAt: minutosAtras(haMin) } })

  describe('sessão ABERTA', () => {
    it('R1 — carregador offline há 20 min e sessão sem sinal há 30: STOP_UNCONFIRMED(CHARGER_UNREACHABLE), SEM RemoteStop (não chegaria) e sem dinheiro', async () => {
      const c = await cenario('r1')
      await offline(c, 20)
      const s = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, atividadeHaMin: 30, amostrasWh: [2_000] })
      await comFakeGateway(c.tenant.chargePointId, {}, async (recebidos) => {
        const r = await ciclo(c)
        expect(r).toMatchObject({ avaliadas: 1, falhas: 0, porAcao: { MARCAR_NAO_CONFIRMADA: 1 } })
        expect(recebidos).toHaveLength(0)
      })
      expect(await sessao(s.session.id)).toMatchObject({ status: 'STOP_UNCONFIRMED', unconfirmedReason: 'CHARGER_UNREACHABLE' })
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
    })

    it('R1 NÃO dispara com atividade recente (5 min) mesmo com o carregador offline há 20: continua CHARGING', async () => {
      const c = await cenario('r1b')
      await offline(c, 20)
      const s = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, atividadeHaMin: 5 })
      await ciclo(c)
      expect((await sessao(s.session.id)).status).toBe('CHARGING')
    })

    it('FAULTED é vigiada (constante única): carregador sumido => STOP_UNCONFIRMED também', async () => {
      const c = await cenario('faulted')
      await offline(c, 20)
      const s = await criarSessao(c, { mode: 'WALLET', status: 'FAULTED', saldoCents: 5_000, atividadeHaMin: 30 })
      await ciclo(c)
      expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')
    })

    it('R2 — conector (online) AVAILABLE há 10 min, status recebido DEPOIS de a sessão abrir: STOP_UNCONFIRMED(CONNECTOR_IDLE); status ANTERIOR à sessão não conta', async () => {
      const c = await cenario('r2')
      const idle = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, iniciouHaMin: 30 })
      const antigo = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, iniciouHaMin: 30 })
      await prisma.connector.update({ where: { id: idle.connector.id }, data: { status: 'AVAILABLE', statusReceivedAt: minutosAtras(10) } })
      await prisma.connector.update({ where: { id: antigo.connector.id }, data: { status: 'AVAILABLE', statusReceivedAt: minutosAtras(45) } }) // antes do createdAt (30 min atrás)
      await ciclo(c)
      expect(await sessao(idle.session.id)).toMatchObject({ status: 'STOP_UNCONFIRMED', unconfirmedReason: 'CONNECTOR_IDLE' })
      expect((await sessao(antigo.session.id)).status).toBe('CHARGING')
    })

    it('R3 — stop pedido há 6 min sem StopTransaction: REENVIA o RemoteStop (WATCHDOG), re-carimba o pedido; energia subindo => alerta session_stop_not_obeyed', async () => {
      const alertas = espiarAlertas()
      const c = await cenario('r3')
      const s = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, meterStartWh: 1_000, amostrasWh: [3_000], stopRequestedHaMin: 6 })
      await redis.set(chaveEnergiaNoPedidoDeParada(s.session.id), '2000', 'EX', 600) // a energia NO MOMENTO do pedido era 2000; agora é 3000
      const antes = await sessao(s.session.id)
      await comFakeGateway(c.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        const r = await ciclo(c)
        expect(r.porAcao).toEqual({ PEDIR_REMOTE_STOP: 1 })
        expect(recebidos).toEqual([{ method: 'RemoteStopTransaction', params: { transactionId: s.session.ocppTransactionId } }])
      })
      const depois = await sessao(s.session.id)
      expect(depois.stopAttempts).toBe(2)
      expect(depois.stopRequestedAt!.getTime()).toBeGreaterThan(antes.stopRequestedAt!.getTime())
      expect(depois.stopRequestedBy).toBe('DRIVER') // o 1º solicitante permanece
      expect(depois.status).toBe('CHARGING')
      expect(alertas.find((a) => a.alert === 'session_stop_not_obeyed')?.nivel).toBe('error')
    })

    it('R3 — esgotadas as 3 tentativas: STOP_UNCONFIRMED(STOP_NOT_CONFIRMED), sem novo comando', async () => {
      const c = await cenario('r3b')
      const s = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, stopRequestedHaMin: 6, stopAttempts: 3 })
      await comFakeGateway(c.tenant.chargePointId, {}, async (recebidos) => {
        await ciclo(c)
        expect(recebidos).toHaveLength(0)
      })
      expect(await sessao(s.session.id)).toMatchObject({ status: 'STOP_UNCONFIRMED', unconfirmedReason: 'STOP_NOT_CONFIRMED' })
    })

    it('R3 respeita a janela: stop pedido há 2 min (< 5) => não reenvia', async () => {
      const c = await cenario('r3c')
      const s = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, stopRequestedHaMin: 2 })
      await comFakeGateway(c.tenant.chargePointId, {}, async (recebidos) => {
        await ciclo(c)
        expect(recebidos).toHaveLength(0)
      })
      expect((await sessao(s.session.id)).stopAttempts).toBe(1)
    })

    it('R4 — conector CHARGING, online, sem MeterValues há 20 min: TriggerMessage(MeterValues) UMA vez (cooldown no Redis) + alerta; NUNCA fecha a sessão', async () => {
      const alertas = espiarAlertas()
      const c = await cenario('r4')
      const s = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, atividadeHaMin: 20 })
      await prisma.connector.update({ where: { id: s.connector.id }, data: { status: 'CHARGING', statusReceivedAt: minutosAtras(25) } })
      await comFakeGateway(c.tenant.chargePointId, { TriggerMessage: 'NotImplemented' }, async (recebidos) => {
        const r1 = await ciclo(c)
        expect(r1.porAcao).toEqual({ TENTAR_TRIGGER_MESSAGE: 1 })
        expect(recebidos).toEqual([{ method: 'TriggerMessage', params: { requestedMessage: 'MeterValues', connectorId: s.connector.connectorId } }])
        expect(await redis.get(chaveTriggerMeterValues(s.session.id))).not.toBeNull()

        const r2 = await ciclo(c) // dentro do cooldown de 15 min: não manda de novo
        expect(r2.porAcao.TENTAR_TRIGGER_MESSAGE).toBeUndefined()
        expect(recebidos.filter((x) => x.method === 'TriggerMessage')).toHaveLength(1)
      })
      expect((await sessao(s.session.id)).status).toBe('CHARGING') // NotImplemented = nada a fazer; sem MeterValues NÃO é sessão travada
      expect(alertas.find((a) => a.alert === 'session_no_meter_values')?.nivel).toBe('warn')
    })

    it('R5 — sessão aberta há 25 h: pede o RemoteStop (WATCHDOG); com o pedido já vencido na janela, marca STOP_UNCONFIRMED(MAX_DURATION)', async () => {
      const alertas = espiarAlertas()
      const c = await cenario('r5')
      const nova = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, iniciouHaMin: 25 * 60, atividadeHaMin: 1 })
      const vencida = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, iniciouHaMin: 25 * 60, atividadeHaMin: 1, stopRequestedHaMin: 6 })
      await comFakeGateway(c.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        const r = await ciclo(c)
        expect(r.porAcao).toEqual({ PEDIR_REMOTE_STOP: 1, MARCAR_NAO_CONFIRMADA: 1 })
        expect(recebidos.filter((x) => x.method === 'RemoteStopTransaction')).toHaveLength(1)
      })
      expect(await sessao(nova.session.id)).toMatchObject({ status: 'CHARGING', stopRequestedBy: 'WATCHDOG', stopAttempts: 1 })
      expect(await sessao(vencida.session.id)).toMatchObject({ status: 'STOP_UNCONFIRMED', unconfirmedReason: 'MAX_DURATION' })
      expect(alertas.map((a) => a.alert)).toContain('session_max_duration_reached')
    })

    it('R6 (corrige o D-C) — SEM nenhuma amostra, a tarifa por TEMPO estoura o saldo: o watchdog reavalia a guarda e pede a parada (GUARD)', async () => {
      const c = await cenario('r6')
      // 30 min a R$ 1,00/min = 3.000 centavos contra um saldo de 1.000 — antes só um MeterValues disparava a guarda, e ele nunca chegava.
      const s = await criarSessao(c, { mode: 'WALLET', saldoCents: 1_000, iniciouHaMin: 30, atividadeHaMin: 5, tariffSnapshot: TARIFA_POR_MINUTO })
      await comFakeGateway(c.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        const r = await ciclo(c)
        expect(r.porAcao).toEqual({ REAVALIAR_GUARDA: 1 })
        await vi.waitFor(() => expect(recebidos.some((x) => x.method === 'RemoteStopTransaction')).toBe(true))
      })
      expect(await sessao(s.session.id)).toMatchObject({ status: 'CHARGING', stopRequestedBy: 'GUARD', stopAttempts: 1 })
    })

    it('R6 — dentro do limite a guarda NÃO pede nada (nenhum falso positivo)', async () => {
      const c = await cenario('r6b')
      const s = await criarSessao(c, { mode: 'WALLET', saldoCents: 50_000, iniciouHaMin: 30, atividadeHaMin: 5, tariffSnapshot: TARIFA_POR_MINUTO })
      await comFakeGateway(c.tenant.chargePointId, {}, async (recebidos) => {
        await ciclo(c)
        expect(recebidos).toHaveLength(0)
      })
      expect((await sessao(s.session.id)).stopAttempts).toBe(0)
    })

    it('sessão ativa e saudável (atividade agora, conector carregando, online): NADA — o watchdog não encosta', async () => {
      const c = await cenario('saudavel')
      const s = await criarSessao(c, { mode: 'WALLET', saldoCents: 5_000, atividadeHaMin: 0 })
      await prisma.connector.update({ where: { id: s.connector.id }, data: { status: 'CHARGING', statusReceivedAt: minutosAtras(25) } })
      const antes = await sessao(s.session.id)
      const r = await ciclo(c)
      expect(r.porAcao).toEqual({ NADA: 1 })
      expect(await sessao(s.session.id)).toEqual(antes)
    })
  })

  describe('sessão STOP_UNCONFIRMED', () => {
    const naoConf = (haMin: number) => ({ motivo: 'CHARGER_UNREACHABLE' as const, haMin })

    it('U1 — o carregador voltou a mandar MeterValues depois do unconfirmedAt: REANIMA (CHARGING), sem dinheiro, com alerta de erro', async () => {
      const alertas = espiarAlertas()
      const c = await cenario('u1')
      const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, naoConfirmada: naoConf(3), lastMeterValuesHaMin: 1, stopRequestedHaMin: 4 })
      await ciclo(c)
      expect(await sessao(s.session.id)).toMatchObject({ status: 'CHARGING', unconfirmedAt: null, unconfirmedReason: null })
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
      expect(alertas.map((a) => a.alert)).toContain('session_revived_after_unconfirmed')
    })

    it('U1 — anti vai-e-vem: com os 3 RemoteStop esgotados NÃO reanima; segue em confirmação e alerta session_stop_not_obeyed UMA vez por hora (limite no Redis)', async () => {
      const alertas = espiarAlertas()
      const c = await cenario('u1b')
      const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, naoConfirmada: naoConf(3), lastMeterValuesHaMin: 1, stopRequestedHaMin: 4, stopAttempts: 3 })
      await ciclo(c)
      await ciclo(c)
      await ciclo(c)
      expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')
      expect(alertas.filter((a) => a.alert === 'session_stop_not_obeyed')).toHaveLength(1)
      expect(await redis.exists(chaveAlertaLimitado('session_stop_not_obeyed', s.session.id))).toBe(1)
    })

    it('U2 — depois da janela G1 (10 min, carregador online): ENCERRA pelo servidor com a última amostra (WALLET debita uma vez)', async () => {
      const c = await cenario('u2')
      const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], naoConfirmada: naoConf(11) })
      const r = await ciclo(c)
      expect(r.porAcao).toEqual({ ENCERRAR_PELO_SERVIDOR: 1 })
      expect(await sessao(s.session.id)).toMatchObject({ status: 'STOPPED', closureSource: 'SERVER', meterStopSource: 'LAST_METER_SAMPLE', totalCostCents: 200 })
      expect(await saldo(s.wallet.id)).toBe(9_800)
    })

    it('U2 — dentro da janela (9 min) NÃO encerra; carregador OFFLINE usa G2 (120 min): 11 min não basta, 121 min encerra', async () => {
      const c = await cenario('u2b')
      await offline(c, 30)
      const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [1_000], naoConfirmada: naoConf(11), atividadeHaMin: 30 })
      await ciclo(c)
      expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED') // offline: espera G2

      await ciclo(c, { agora: emMin(111) }) // 11 + 111 = 122 min desde o unconfirmedAt
      expect((await sessao(s.session.id)).status).toBe('STOPPED')

      const c2 = await cenario('u2c')
      const dentro = await criarSessao(c2, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, amostrasWh: [1_000], naoConfirmada: naoConf(9) })
      await ciclo(c2)
      expect((await sessao(dentro.session.id)).status).toBe('STOP_UNCONFIRMED')
    })

    it('U2 + Stop no log bruto: a janela venceu mas o StopTransaction do carregador JÁ estava no log — usa o meterStop dele (prova 1)', async () => {
      const c = await cenario('u2d')
      const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [1_000], naoConfirmada: naoConf(11) })
      await prisma.ocppMessage.create({
        data: { chargePointId: c.tenant.chargePointId, operatorId: c.tenant.operatorId, direction: 'INBOUND', messageType: 'CALL', ocppMessageId: `stop-${s.session.id}`, action: 'StopTransaction', payload: { transactionId: s.session.ocppTransactionId, meterStop: 5_000, timestamp: minutosAtras(2).toISOString() }, occurredAt: minutosAtras(2) },
      })
      await ciclo(c)
      expect(await sessao(s.session.id)).toMatchObject({ status: 'STOPPED', meterStopSource: 'STOP_TRANSACTION', meterStopWh: 5_000, totalCostCents: 500 })
    })

    it('U2 + NENHUMA leitura: encerra SEM cobrar (política D2 padrão NO_CHARGE) e alerta de erro', async () => {
      const alertas = espiarAlertas()
      const c = await cenario('u2e')
      const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, naoConfirmada: naoConf(11) })
      await ciclo(c)
      expect(await sessao(s.session.id)).toMatchObject({ status: 'STOPPED', meterStopSource: 'NO_READING', totalCostCents: 0 })
      expect(await saldo(s.wallet.id)).toBe(10_000)
      expect(alertas.find((a) => a.alert === 'session_closed_without_meter_reading')?.nivel).toBe('error')
    })

    it('prazo do hold do cartão (48 h): encerra forçado antes da janela, captura o valor pela leitura e alerta card_session_hold_deadline', async () => {
      const alertas = espiarAlertas()
      const c = await cenario('card48')
      // sessão CARD aberta há 49 h de autorização, já em confirmação há 2 min: a janela G1 (10 min) ainda não venceu, o hold sim.
      const s = await criarSessao(c, { mode: 'CARD', status: 'STOP_UNCONFIRMED', meterStartWh: 0, amostrasWh: [3_000], naoConfirmada: naoConf(2), iniciouHaMin: 49 * 60, autorizadoHaMin: 49 * 60, autorizadoCents: 5_000, atividadeHaMin: 1 })
      await ciclo(c)
      expect((await sessao(s.session.id)).status).toBe('STOPPED')
      const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { chargingSessionId: s.session.id } })
      expect(intent).toMatchObject({ status: 'CAPTURE_PENDING', captureAmountCents: 300 })
      expect(alertas.map((a) => a.alert)).toEqual(expect.arrayContaining(['session_closed_by_server', 'card_session_hold_deadline']))
    })

    it('sessão aberta de cartão com o hold vencido (49 h): marca STOP_UNCONFIRMED(MAX_DURATION) com card_session_hold_deadline — nunca aberta -> STOPPED direto', async () => {
      const alertas = espiarAlertas()
      const c = await cenario('card48b')
      const s = await criarSessao(c, { mode: 'CARD', iniciouHaMin: 49 * 60, autorizadoHaMin: 49 * 60, atividadeHaMin: 1, amostrasWh: [1_000] })
      await ciclo(c)
      expect(await sessao(s.session.id)).toMatchObject({ status: 'STOP_UNCONFIRMED', unconfirmedReason: 'MAX_DURATION' })
      expect((await prisma.paymentIntent.findFirstOrThrow({ where: { chargingSessionId: s.session.id } })).status).toBe('AUTHORIZED')
      expect(alertas.map((a) => a.alert)).toContain('card_session_hold_deadline')
    })
  })

  describe('robustez e corridas do próprio job', () => {
    it('o ciclo PAGINA: com lote 2 e 5 sessões vencidas, todas são processadas no mesmo ciclo (sem inanição)', async () => {
      const c = await cenario('pag')
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, meterStartWh: 0, amostrasWh: [1_000], naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: 20 } })
        ids.push(s.session.id)
      }
      const r = await ciclo(c, { batchSize: 2 })
      expect(r.avaliadas).toBe(5)
      expect(r.porAcao).toEqual({ ENCERRAR_PELO_SERVIDOR: 5 })
      expect(await prisma.chargingSession.count({ where: { id: { in: ids }, status: 'STOPPED' } })).toBe(5)
    })

    it('uma sessão que FALHA não derruba o ciclo: as outras são processadas e a falha é contada', async () => {
      const c = await cenario('falha')
      const ruim = await criarSessao(c, { mode: 'WALLET', saldoCents: 1_000, iniciouHaMin: 30, atividadeHaMin: 5 }) // R6 => a guarda lê a carteira
      const boa = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, meterStartWh: 0, amostrasWh: [1_000], naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: 20 } })
      // O banco "cai" só para a leitura da carteira da guarda (o encerramento da boa usa a transação e não passa por aí).
      vi.spyOn(prisma.wallet, 'findUnique').mockRejectedValue(new Error('conexão perdida (simulada)'))
      const r = await ciclo(c)
      vi.restoreAllMocks()
      expect(r.falhas).toBe(1)
      expect(r.avaliadas).toBe(1)
      expect((await sessao(boa.session.id)).status).toBe('STOPPED')
      expect((await sessao(ruim.session.id)).status).toBe('CHARGING') // a falha não deixou a sessão pela metade
    })

    it('DOIS watchdogs simultâneos sobre a mesma sessão vencida: UM fechamento, UM débito', async () => {
      const c = await cenario('dois')
      const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [3_000], naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: 20 } })
      await Promise.all([ciclo(c), ciclo(c)])
      expect((await sessao(s.session.id)).status).toBe('STOPPED')
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
      expect(await saldo(s.wallet.id)).toBe(9_700)
    })

    it('watchdog x StopTransaction do carregador chegando NO MESMO INSTANTE, 6 rodadas: nunca cobrança dupla, nunca dois fechamentos, total do vencedor', async () => {
      const c = await cenario('corrida')
      for (let rodada = 0; rodada < 6; rodada++) {
        const s = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: 20 } })
        await Promise.all([
          ciclo(c),
          chamarHandler(handleStopTransaction, c.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: minutosAtras(1).toISOString() }),
        ])
        const linha = await sessao(s.session.id)
        const debitos = await debitosDaSessao(s.session.id)
        expect(linha.status).toBe('STOPPED')
        expect(debitos, `rodada ${rodada}`).toHaveLength(1)
        expect(await saldo(s.wallet.id)).toBe(10_000 - linha.totalCostCents!)
        // CHARGER => 500 (o Stop). SERVER => 500 se o Stop já estava no log bruto (prova 1) ou 200 se o watchdog correu antes dele (última amostra).
        const esperado = linha.closureSource === 'CHARGER' || linha.meterStopSource === 'STOP_TRANSACTION' ? 500 : 200
        expect(linha.totalCostCents).toBe(esperado)
      }
    })

    it('só encosta nos carregadores pedidos e ignora sessão STOPPED', async () => {
      const a = await cenario('esc-a')
      const b = await cenario('esc-b')
      const sa = await criarSessao(a, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: 20 } })
      const sb = await criarSessao(b, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: { motivo: 'CHARGER_REBOOTED', haMin: 20 } })
      const parada = await criarSessao(a, { mode: 'WALLET', status: 'STOPPED' })
      const r = await ciclo(a)
      expect(r.avaliadas).toBe(1)
      expect((await sessao(sa.session.id)).status).toBe('STOPPED')
      expect((await sessao(sb.session.id)).status).toBe('STOP_UNCONFIRMED')
      expect((await sessao(parada.session.id)).closureSource).toBeNull()
    })
  })
})
