import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { ADMIN_CHANNEL, operatorChannel, subscribeChannels, userChannel } from '../../src/realtime/bus'
import type { RealtimeEvent } from '../../src/realtime/events'
import { checkAuthorization } from '../../src/ocpp/authorizationCheck'
import { marcarSessaoNaoConfirmada } from '../../src/services/sessao/marcarSessaoNaoConfirmada'
import { reanimarSessao } from '../../src/services/sessao/reanimarSessao'
import { avaliarGuardaDeSaldo, carregarSessaoParaGuarda } from '../../src/services/sessao/guardaDeSaldo'
import { chaveCooldownParada } from '../../src/services/sessao/pedirParadaSessao'
import { cenariosCriados, comFakeGateway, criarCenario, criarSessao, minutosAtras, resolverCapturasPendentes, tokenDoMotorista, type Cenario } from './helpers/sessaoTravadaFixture'
import { createUser, settle, uniqueSuffix, waitFor } from './helpers/fixtures'

vi.mock('../../src/services/pagamentos/capturarSessaoCartao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/pagamentos/capturarSessaoCartao')>()),
  enqueueCapturarSessaoCartao: vi.fn().mockResolvedValue('ENFILEIRADO'),
}))

/**
 * F5.9b2 — a API da sessão travada contra Postgres + Redis reais: listas de "sessão aberta" pela constante única (FAULTED incluído), 409 de stop
 * para STOP_UNCONFIRMED/STOPPED, o bloco `closure` (motorista e admin) com o que o motorista NUNCA vê, `session.updated` no SSE, a decisão D7 nos
 * dois valores da chave e o duplo toque no stop. Tarifa R$ 1,00/kWh; WALLET_MIN_START_BALANCE_CENTS = 2000 (default).
 */

const MIN_START = env.WALLET_MIN_START_BALANCE_CENTS

describe('API da sessão travada (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let cen: Cenario
  let admin: Awaited<ReturnType<typeof createUser>>
  const naoConf = (haMin: number) => ({ motivo: 'CHARGER_UNREACHABLE' as const, haMin })

  beforeAll(async () => {
    cen = await criarCenario(suffix, 'api')
    admin = await createUser({ role: 'ADMIN', label: 'admin-api', suffix })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await resolverCapturasPendentes(cenariosCriados)
    await prisma.$disconnect()
    redis.disconnect()
  })

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })

  describe('listas de "sessão aberta" pela constante única', () => {
    it('GET /api/me/sessions/active: FAULTED APARECE; STOP_UNCONFIRMED NÃO (vai ao recibo, não é "ativa")', async () => {
      const faulted = await criarSessao(cen, { mode: 'WALLET', status: 'FAULTED', saldoCents: 5_000 })
      const pendente = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, naoConfirmada: naoConf(3) })

      const a = await request(app).get('/api/me/sessions/active').set(auth(tokenDoMotorista(faulted.driver.id)))
      expect(a.status, JSON.stringify(a.body)).toBe(200)
      expect(a.body.session).toMatchObject({ id: faulted.session.id, status: 'FAULTED' })

      const b = await request(app).get('/api/me/sessions/active').set(auth(tokenDoMotorista(pendente.driver.id)))
      expect(b.status).toBe(200)
      expect(b.body.session).toBeNull()
    })

    it('POST /api/me/sessions/:id/stop: STOP_UNCONFIRMED e STOPPED => 409 SESSION_NOT_ACTIVE; FAULTED => 202 e o RemoteStop sai', async () => {
      const pendente = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: naoConf(3) })
      const parada = await criarSessao(cen, { mode: 'WALLET', status: 'STOPPED', saldoCents: 1_000 })
      const faulted = await criarSessao(cen, { mode: 'WALLET', status: 'FAULTED', saldoCents: 1_000 })

      for (const s of [pendente, parada]) {
        const r = await request(app).post(`/api/me/sessions/${s.session.id}/stop`).set(auth(tokenDoMotorista(s.driver.id)))
        expect(r.status).toBe(409)
        expect(r.body.error?.code ?? r.body.code).toBe('SESSION_NOT_ACTIVE')
      }
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        const r = await request(app).post(`/api/me/sessions/${faulted.session.id}/stop`).set(auth(tokenDoMotorista(faulted.driver.id)))
        expect(r.status).toBe(202)
        await waitFor(async () => recebidos.some((c) => c.method === 'RemoteStopTransaction'), { what: 'RemoteStop da sessão FAULTED' })
      })
    })

    it('POST /api/admin/sessions/:id/stop: o mesmo — STOP_UNCONFIRMED e STOPPED => 409; FAULTED => 202', async () => {
      const pendente = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf(3) })
      const parada = await criarSessao(cen, { mode: 'WALLET', status: 'STOPPED' })
      const faulted = await criarSessao(cen, { mode: 'WALLET', status: 'FAULTED' })
      for (const s of [pendente, parada]) {
        const r = await request(app).post(`/api/admin/sessions/${s.session.id}/stop`).set(auth(admin.token))
        expect(r.status).toBe(409)
        expect(r.body.error?.code ?? r.body.code).toBe('SESSION_NOT_ACTIVE')
      }
      await comFakeGateway(cen.tenant.chargePointId, {}, async () => {
        expect((await request(app).post(`/api/admin/sessions/${faulted.session.id}/stop`).set(auth(admin.token))).status).toBe(202)
      })
    })

    it('SQL cru com a constante única: lista de motoristas (activeSessionId) e dashboard ao vivo enxergam FAULTED, não STOP_UNCONFIRMED', async () => {
      const faulted = await criarSessao(cen, { mode: 'WALLET', status: 'FAULTED', saldoCents: 1_000 })
      const pendente = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: naoConf(3) })

      const lista = await request(app).get('/api/admin/drivers').query({ search: suffix, pageSize: 100 }).set(auth(admin.token))
      expect(lista.status, JSON.stringify(lista.body)).toBe(200)
      const porId = new Map<string, { activeSessionId: string | null }>(lista.body.items.map((i: { id: string; activeSessionId: string | null }) => [i.id, i]))
      expect(porId.get(faulted.driver.id)?.activeSessionId).toBe(faulted.session.id)
      expect(porId.get(pendente.driver.id)?.activeSessionId).toBeNull()

      const live = await request(app).get('/api/admin/dashboard/live').set(auth(cen.tenant.staff.token))
      expect(live.status, JSON.stringify(live.body)).toBe(200)
      const ids = live.body.activeSessions.map((s: { id: string }) => s.id)
      expect(ids).toContain(faulted.session.id)
      expect(ids).not.toContain(pendente.session.id)
    })

    it('o filtro de status do relatório de sessões aceita FAULTED e STOP_UNCONFIRMED (e recusa lixo)', async () => {
      const pendente = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf(3) })
      const r = await request(app).get('/api/admin/reports/sessions').query({ status: 'STOP_UNCONFIRMED', operatorId: cen.tenant.operatorId, pageSize: 100 }).set(auth(admin.token))
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.items.map((i: { id: string }) => i.id)).toContain(pendente.session.id)
      expect((await request(app).get('/api/admin/reports/sessions').query({ status: 'FAULTED' }).set(auth(admin.token))).status).toBe(200)
      expect((await request(app).get('/api/admin/reports/sessions').query({ status: 'INVENTADO' }).set(auth(admin.token))).status).toBe(400)
    })
  })

  describe('closure — detalhe do motorista e do admin', () => {
    it('STOP_UNCONFIRMED: unconfirmedSince/Reason + confirmDeadline (= unconfirmedAt + G1 10 min, carregador online); custos NULL (nunca 0); billedUntil null', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, naoConfirmada: naoConf(3), amostrasWh: [2_000] })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { provisionalCostCents: 123 } })
      const r = await request(app).get(`/api/me/sessions/${s.session.id}`).set(auth(tokenDoMotorista(s.driver.id)))
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      const unconfirmedAt = (await sessao(s.session.id)).unconfirmedAt!
      expect(r.body.status).toBe('STOP_UNCONFIRMED')
      expect(r.body.closure).toEqual({
        source: null,
        meterStopSource: null,
        unconfirmedSince: unconfirmedAt.toISOString(),
        unconfirmedReason: 'CHARGER_UNREACHABLE',
        confirmDeadline: new Date(unconfirmedAt.getTime() + 10 * 60_000).toISOString(),
        billedUntil: null,
      })
      for (const campo of ['totalCostCents', 'energyCostCents', 'timeCostCents', 'idleFeeCents', 'sessionFeeCents', 'minChargeAdjustmentCents', 'energyDeliveredWh']) expect(r.body[campo], campo).toBeNull()
      expect(r.body.walletEntry).toBeNull()
      expect(r.body.debt).toBeNull()
    })

    it('confirmDeadline muda com a presença do carregador: OFFLINE usa G2 (120 min); com CARD, o hold de 48 h limita', async () => {
      const off = await criarCenario(suffix, 'api-off')
      await prisma.chargePoint.update({ where: { id: off.tenant.chargePointId }, data: { lastSeenAt: minutosAtras(30), disconnectedAt: minutosAtras(29) } })
      const a = await criarSessao(off, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: naoConf(3) })
      const ra = await request(app).get(`/api/me/sessions/${a.session.id}`).set(auth(tokenDoMotorista(a.driver.id)))
      const ua = (await sessao(a.session.id)).unconfirmedAt!
      expect(ra.body.closure.confirmDeadline).toBe(new Date(ua.getTime() + 120 * 60_000).toISOString())

      // CARD autorizado há 47 h 55 min: o hold vence em 5 min, antes da janela G1 (10 min) => o prazo é o do cartão.
      const b = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf(3), iniciouHaMin: 47 * 60 + 55, autorizadoHaMin: 47 * 60 + 55 })
      const rb = await request(app).get(`/api/me/sessions/${b.session.id}`).set(auth(tokenDoMotorista(b.driver.id)))
      expect(rb.status, JSON.stringify(rb.body)).toBe(200)
      const autorizadoEm = (await prisma.paymentIntent.findFirstOrThrow({ where: { chargingSessionId: b.session.id } })).authorizedAt!
      expect(rb.body.closure.confirmDeadline).toBe(new Date(autorizadoEm.getTime() + 48 * 3_600_000).toISOString())
    })

    it('STOPPED pelo servidor: source=SERVER, meterStopSource e billedUntil = stoppedAt; sem unconfirmedSince/confirmDeadline', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, naoConfirmada: naoConf(30), meterStartWh: 0, amostrasWh: [2_000] })
      const { encerrarSessaoPeloServidor } = await import('../../src/services/sessao/encerrarSessaoPeloServidor')
      await encerrarSessaoPeloServidor({ sessionId: s.session.id })
      const linha = await sessao(s.session.id)
      const r = await request(app).get(`/api/me/sessions/${s.session.id}`).set(auth(tokenDoMotorista(s.driver.id)))
      expect(r.body.closure).toEqual({ source: 'SERVER', meterStopSource: 'LAST_METER_SAMPLE', unconfirmedSince: null, unconfirmedReason: null, confirmDeadline: null, billedUntil: linha.stoppedAt!.toISOString() })
      expect(r.body.totalCostCents).toBe(200)
    })

    it('sessão ABERTA e sessão ANTERIOR à F5.9 (colunas nulas): closure TODO null — nunca inventa valor', async () => {
      const aberta = await criarSessao(cen, { mode: 'WALLET', saldoCents: 1_000 })
      const legada = await criarSessao(cen, { mode: 'WALLET', status: 'STOPPED', saldoCents: 1_000 })
      await prisma.chargingSession.update({ where: { id: legada.session.id }, data: { stoppedAt: new Date(), meterStopWh: 5, totalCostCents: 0 } })
      const nulo = { source: null, meterStopSource: null, unconfirmedSince: null, unconfirmedReason: null, confirmDeadline: null, billedUntil: null }
      for (const s of [aberta, legada]) {
        const r = await request(app).get(`/api/me/sessions/${s.session.id}`).set(auth(tokenDoMotorista(s.driver.id)))
        expect(r.status).toBe(200)
        expect(r.body.closure).toEqual(nulo)
      }
    })

    it('O MOTORISTA NUNCA VÊ lateStop / unbilledCostCents / stopRequested* / provisionalCostCents — nem como chave, nem como valor, nem em sessão com stop tardio', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, naoConfirmada: naoConf(30), meterStartWh: 0, amostrasWh: [2_000], stopRequestedHaMin: 20 })
      const { encerrarSessaoPeloServidor } = await import('../../src/services/sessao/encerrarSessaoPeloServidor')
      const { registrarStopTardio } = await import('../../src/services/sessao/registrarStopTardio')
      await encerrarSessaoPeloServidor({ sessionId: s.session.id })
      await registrarStopTardio({ sessionId: s.session.id, meterStopWh: 9_000, timestamp: new Date() })
      expect((await sessao(s.session.id)).unbilledCostCents).toBe(700) // existe no banco...

      const token = tokenDoMotorista(s.driver.id)
      const detalhe = await request(app).get(`/api/me/sessions/${s.session.id}`).set(auth(token))
      const lista = await request(app).get('/api/me/sessions').set(auth(token))
      const ativa = await request(app).get('/api/me/sessions/active').set(auth(token))
      for (const resposta of [detalhe, lista, ativa]) {
        expect(resposta.status).toBe(200)
        const json = JSON.stringify(resposta.body)
        for (const proibido of ['lateStop', 'unbilledCostCents', 'lateStopMeterWh', 'stopRequestedAt', 'stopRequestedBy', 'stopAttempts', 'provisionalCostCents']) {
          expect(json, `${proibido} vazou para o motorista`).not.toContain(proibido)
        }
      }
    })

    it('ADMIN vê lateStop + stopRequested* + closure; OPERATOR vê closure e stopRequested*, mas lateStop = null', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 5_000, naoConfirmada: naoConf(30), meterStartWh: 0, amostrasWh: [2_000], stopRequestedHaMin: 20, stopAttempts: 2 })
      const { encerrarSessaoPeloServidor } = await import('../../src/services/sessao/encerrarSessaoPeloServidor')
      const { registrarStopTardio } = await import('../../src/services/sessao/registrarStopTardio')
      await encerrarSessaoPeloServidor({ sessionId: s.session.id })
      const tsDoStop = minutosAtras(1)
      await registrarStopTardio({ sessionId: s.session.id, meterStopWh: 9_000, timestamp: tsDoStop })
      const linha = await sessao(s.session.id)

      const comoAdmin = await request(app).get(`/api/admin/reports/sessions/${s.session.id}`).set(auth(admin.token))
      expect(comoAdmin.status, JSON.stringify(comoAdmin.body)).toBe(200)
      expect(comoAdmin.body.closure).toMatchObject({ source: 'SERVER', meterStopSource: 'LAST_METER_SAMPLE', billedUntil: linha.stoppedAt!.toISOString() })
      expect(comoAdmin.body).toMatchObject({ stopRequestedBy: 'DRIVER', stopAttempts: 2 })
      expect(comoAdmin.body.stopRequestedAt).toBe(linha.stopRequestedAt!.toISOString())
      expect(comoAdmin.body.lateStop).toEqual({ meterStopWh: 9_000, stoppedAt: tsDoStop.toISOString(), receivedAt: linha.lateStopReceivedAt!.toISOString(), unbilledCostCents: 700 })

      const comoOperador = await request(app).get(`/api/admin/reports/sessions/${s.session.id}`).set(auth(cen.tenant.staff.token))
      expect(comoOperador.status).toBe(200)
      expect(comoOperador.body.lateStop).toBeNull()
      expect(comoOperador.body.stopAttempts).toBe(2)
      expect(comoOperador.body.closure.source).toBe('SERVER')
      expect(JSON.stringify(comoOperador.body)).not.toContain('unbilledCostCents')
    })

    it('admin: sessão aberta => stopAttempts 0, lateStop/stopRequested null, closure toda null (contrato não-opcional do tipo)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 1_000 })
      const r = await request(app).get(`/api/admin/reports/sessions/${s.session.id}`).set(auth(admin.token))
      expect(r.body).toMatchObject({ stopRequestedAt: null, stopRequestedBy: null, stopAttempts: 0, lateStop: null })
      expect(r.body.closure.source).toBeNull()
    })
  })

  describe('SSE — session.updated', () => {
    it('marcar STOP_UNCONFIRMED e reanimar publicam session.updated {sessionId, chargePointId} para o motorista, o operador dono e o admin — e nada além disso no payload', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, amostrasWh: [2_000] })
      const eventos: RealtimeEvent[] = []
      const parar = subscribeChannels([userChannel(s.driver.id), operatorChannel(cen.tenant.operatorId), ADMIN_CHANNEL], (e) => {
        if (e.type === 'session.updated') eventos.push(e)
      })
      try {
        await settle(300) // a assinatura é assíncrona
        expect(await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'STOP_REJECTED' })).toBe('MARCADA')
        await waitFor(async () => eventos.filter((e) => e.type === 'session.updated' && (e as { sessionId: string }).sessionId === s.session.id).length >= 1, { what: 'session.updated ao marcar' })

        await prisma.chargingSession.update({ where: { id: s.session.id }, data: { lastMeterValuesAt: new Date(), lastActivityAt: new Date() } })
        const linha = await sessao(s.session.id)
        expect(await reanimarSessao({ sessionId: s.session.id, fotoEsperada: { status: linha.status, lastActivityAt: linha.lastActivityAt, lastMeterValuesAt: linha.lastMeterValuesAt, stopRequestedAt: linha.stopRequestedAt, stopAttempts: linha.stopAttempts, unconfirmedAt: linha.unconfirmedAt } })).toBe('REANIMADA')
        await waitFor(async () => eventos.filter((e) => (e as { sessionId?: string }).sessionId === s.session.id).length >= 2, { what: 'session.updated ao reanimar' })
      } finally {
        parar()
      }
      const meus = eventos.filter((e) => (e as { sessionId?: string }).sessionId === s.session.id) as Array<{ type: string; sessionId: string; chargePointId: string; occurredAt: string }>
      expect(meus.length).toBeGreaterThanOrEqual(2)
      for (const e of meus) {
        expect(Object.keys(e).sort()).toEqual(['chargePointId', 'occurredAt', 'sessionId', 'type'])
        expect(e.chargePointId).toBe(cen.tenant.chargePointId)
      }
    })

    it('marcar uma sessão que já não está aberta NÃO publica nada', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOPPED' })
      const eventos: RealtimeEvent[] = []
      const parar = subscribeChannels([ADMIN_CHANNEL], (e) => eventos.push(e))
      try {
        await settle(300)
        expect(await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'STOP_REJECTED' })).toBe('NAO_ABERTA')
        await settle(400)
      } finally {
        parar()
      }
      expect(eventos.filter((e) => (e as { sessionId?: string }).sessionId === s.session.id)).toHaveLength(0)
    })
  })

  describe('D7 — iniciar outra recarga com sessão em STOP_UNCONFIRMED', () => {
    /** Motorista com carteira de `saldoCents` e uma sessão WALLET em confirmação com custo provisório `provisorioCents`. */
    async function motoristaComPendente(label: string, saldoCents: number, provisorioCents: number, mode: 'WALLET' | 'CARD' = 'WALLET') {
      const c = await criarCenario(suffix, label)
      const pendente = await criarSessao(c, { mode, status: 'STOP_UNCONFIRMED', saldoCents, naoConfirmada: naoConf(3), amostrasWh: [2_000] })
      await prisma.chargingSession.update({ where: { id: pendente.session.id }, data: { provisionalCostCents: provisorioCents } })
      if (mode === 'CARD') {
        // saldo para o caso WALLET: a carteira do motorista do cartão começa vazia
        await prisma.walletEntry.create({ data: { walletId: pendente.wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: saldoCents, balanceAfterCents: saldoCents, referenceType: 'MANUAL', description: 'saldo de teste' } })
      }
      return { c, pendente, token: tokenDoMotorista(pendente.driver.id) }
    }
    const iniciar = (c: Cenario, token: string) => request(app).post('/api/me/sessions/start').set(auth(token)).send({ ocppIdentity: c.tenant.ocppIdentity, connectorId: 1 })
    async function comEnv<T>(permitir: boolean, fn: () => Promise<T>): Promise<T> {
      const original = env.SESSION_ALLOW_START_WHILE_UNCONFIRMED
      ;(env as { SESSION_ALLOW_START_WHILE_UNCONFIRMED: boolean }).SESSION_ALLOW_START_WHILE_UNCONFIRMED = permitir
      try {
        return await fn()
      } finally {
        ;(env as { SESSION_ALLOW_START_WHILE_UNCONFIRMED: boolean }).SESSION_ALLOW_START_WHILE_UNCONFIRMED = original
      }
    }

    it('chave = true (padrão): INICIA se o saldo DISPONÍVEL (saldo - custo provisório pendente) ainda cobre o mínimo', async () => {
      const { c, token } = await motoristaComPendente('d7a', MIN_START + 1_500, 1_000) // disponível = MIN_START + 500
      await comEnv(true, async () => {
        await comFakeGateway(c.tenant.chargePointId, { RemoteStartTransaction: 'Accepted' }, async () => {
          const r = await iniciar(c, token)
          expect(r.status, JSON.stringify(r.body)).toBe(202)
          expect(r.body.walletBalanceCents).toBe(MIN_START + 1_500) // o saldo real continua sendo informado
        })
      })
    })

    it('chave = true: NÃO inicia se o saldo que a sessão pendente já consome deixa o disponível abaixo do mínimo (409 INSUFFICIENT_BALANCE, com o comprometido nos detalhes)', async () => {
      const { c, token } = await motoristaComPendente('d7b', MIN_START + 500, 1_000) // saldo real passaria; o disponível (MIN_START - 500) não
      await comEnv(true, async () => {
        await comFakeGateway(c.tenant.chargePointId, {}, async (recebidos) => {
          const r = await iniciar(c, token)
          expect(r.status).toBe(409)
          expect(r.body.error?.code ?? r.body.code).toBe('INSUFFICIENT_BALANCE')
          const det = JSON.stringify(r.body)
          expect(det).toContain('"committedCents":1000')
          expect(det).toContain(`"availableBalanceCents":${MIN_START - 500}`)
          expect(recebidos).toHaveLength(0) // nenhum RemoteStart saiu
        })
      })
    })

    it('chave = false: 409 ALREADY_HAS_ACTIVE_SESSION (pendingConfirmation) MESMO com saldo de sobra, e nenhum comando sai', async () => {
      const { c, token, pendente } = await motoristaComPendente('d7c', 50_000, 100)
      await comEnv(false, async () => {
        await comFakeGateway(c.tenant.chargePointId, {}, async (recebidos) => {
          const r = await iniciar(c, token)
          expect(r.status).toBe(409)
          expect(r.body.error?.code ?? r.body.code).toBe('ALREADY_HAS_ACTIVE_SESSION')
          expect(JSON.stringify(r.body)).toContain(pendente.session.id)
          expect(recebidos).toHaveLength(0)
        })
      })
    })

    it('sessão pendente de CARTÃO não compromete a carteira (a pré-autorização dela já cobre): início WALLET passa mesmo com custo provisório alto', async () => {
      const { c, token } = await motoristaComPendente('d7d', MIN_START + 100, 9_000, 'CARD')
      await comEnv(true, async () => {
        await comFakeGateway(c.tenant.chargePointId, { RemoteStartTransaction: 'Accepted' }, async () => {
          expect((await iniciar(c, token)).status).toBe(202)
        })
      })
    })

    it('OCPP (Authorize/StartTransaction de idTag): o MESMO saldo disponível e a MESMA chave valem — Accepted/Blocked(INSUFFICIENT_BALANCE)/Blocked(SESSION_PENDING_CONFIRMATION)', async () => {
      const ok = await motoristaComPendente('d7e', MIN_START + 1_500, 1_000)
      const curto = await motoristaComPendente('d7f', MIN_START + 500, 1_000)
      const idTag = async (s: { authToken: { id: string } }) => (await prisma.authToken.findUniqueOrThrow({ where: { id: s.authToken.id } })).idTag

      await comEnv(true, async () => {
        expect((await checkAuthorization(await idTag(ok.pendente))).resultado).toEqual({ decision: 'Accepted' })
        expect((await checkAuthorization(await idTag(curto.pendente))).resultado).toEqual({ decision: 'Blocked', reason: 'INSUFFICIENT_BALANCE' })
      })
      await comEnv(false, async () => {
        expect((await checkAuthorization(await idTag(ok.pendente))).resultado).toEqual({ decision: 'Blocked', reason: 'SESSION_PENDING_CONFIRMATION' })
      })
    })

    it('guarda de saldo da sessão NOVA desconta o comprometido da pendente: 600 de custo estoura um disponível de 500 (3000 - 2500) e pede a parada', async () => {
      const c = await criarCenario(suffix, 'd7g')
      const pendente = await criarSessao(c, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 3_000, naoConfirmada: naoConf(3), amostrasWh: [2_000] })
      await prisma.chargingSession.update({ where: { id: pendente.session.id }, data: { provisionalCostCents: 2_500 } })
      const nova = await criarSessao(c, { mode: 'WALLET', motorista: pendente, meterStartWh: 1_000 })

      await comFakeGateway(c.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async () => {
        const guarda = await carregarSessaoParaGuarda(nova.session.id)
        // 7000 - 1000 = 6 kWh = 600 centavos: abaixo do saldo real (3000), acima do disponível (500).
        expect(await avaliarGuardaDeSaldo(guarda, 7_000, { aguardarComando: true })).toBe('DISPARADA')
      })
      expect((await sessao(nova.session.id)).stopRequestedBy).toBe('GUARD')

      // controle: sem a pendente comprometendo, o MESMO consumo NÃO dispara
      const livre = await criarSessao(c, { mode: 'WALLET', saldoCents: 3_000, meterStartWh: 1_000 })
      expect(await avaliarGuardaDeSaldo(await carregarSessaoParaGuarda(livre.session.id), 7_000, { aguardarComando: true })).toBe('ABAIXO_DO_LIMITE')
    })
  })

  describe('duplo toque no stop (POST /api/me/sessions/:id/stop)', () => {
    it('dois toques seguidos: o 2º recebe o MESMO correlationId do 1º, UM só RemoteStop sai, e o polling resolve com o resultado real', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, amostrasWh: [2_000] })
      const token = tokenDoMotorista(s.driver.id)
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Rejected' }, async (recebidos) => {
        const [a, b] = [await request(app).post(`/api/me/sessions/${s.session.id}/stop`).set(auth(token)), await request(app).post(`/api/me/sessions/${s.session.id}/stop`).set(auth(token))]
        expect([a.status, b.status]).toEqual([202, 202])
        expect(b.body.correlationId).toBe(a.body.correlationId)
        expect(a.body.status).toBe('PENDING')

        const resultado = await waitFor(async () => {
          const r = await request(app).get(`/api/me/commands/${a.body.correlationId}`).set(auth(token))
          return r.body.status !== 'PENDING' ? r.body.status : null
        }, { what: 'resultado do comando de parada', timeoutMs: 10_000 })
        expect(resultado).toBe('REJECTED') // o resultado REAL do carregador, para os dois toques
        expect(recebidos.filter((x) => x.method === 'RemoteStopTransaction')).toHaveLength(1)
      })
      expect((await sessao(s.session.id)).stopAttempts).toBe(1)
    })

    it('toque simultâneo (Promise.all): mesma coisa — um correlationId, um comando', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000 })
      const token = tokenDoMotorista(s.driver.id)
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        const [a, b] = await Promise.all([request(app).post(`/api/me/sessions/${s.session.id}/stop`).set(auth(token)), request(app).post(`/api/me/sessions/${s.session.id}/stop`).set(auth(token))])
        expect(a.body.correlationId).toBe(b.body.correlationId)
        await waitFor(async () => (await request(app).get(`/api/me/commands/${a.body.correlationId}`).set(auth(token))).body.status === 'ACCEPTED', { what: 'ACCEPTED' })
        expect(recebidos.filter((x) => x.method === 'RemoteStopTransaction')).toHaveLength(1)
      })
    })

    it('cooldown de OUTRO solicitante (guarda/watchdog acabou de pedir): o correlationId deste toque NÃO fica PENDING para sempre — resolve ACCEPTED (o pedido em curso já cobre)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000 })
      const token = tokenDoMotorista(s.driver.id)
      await redis.set(chaveCooldownParada(s.session.id), 'GUARD', 'EX', 30)
      await comFakeGateway(cen.tenant.chargePointId, {}, async (recebidos) => {
        const r = await request(app).post(`/api/me/sessions/${s.session.id}/stop`).set(auth(token))
        expect(r.status).toBe(202)
        await waitFor(async () => (await request(app).get(`/api/me/commands/${r.body.correlationId}`).set(auth(token))).body.status === 'ACCEPTED', { what: 'correlationId resolvido' })
        expect(recebidos).toHaveLength(0) // nenhum comando novo
      })
    })

    it('depois do cooldown (10 s) um novo toque é uma NOVA tentativa legítima, com outro correlationId', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000 })
      const token = tokenDoMotorista(s.driver.id)
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        const a = await request(app).post(`/api/me/sessions/${s.session.id}/stop`).set(auth(token))
        await waitFor(async () => recebidos.length >= 1, { what: 'primeiro comando' })
        await redis.del(`me:stop-corr:${s.session.id}`, chaveCooldownParada(s.session.id)) // = passaram os 10 s
        const b = await request(app).post(`/api/me/sessions/${s.session.id}/stop`).set(auth(token))
        expect(b.body.correlationId).not.toBe(a.body.correlationId)
        await waitFor(async () => recebidos.filter((x) => x.method === 'RemoteStopTransaction').length === 2, { what: 'segundo comando' })
      })
    })
  })
})
