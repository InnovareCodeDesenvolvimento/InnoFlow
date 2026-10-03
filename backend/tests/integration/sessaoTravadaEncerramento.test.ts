import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { marcarSessaoNaoConfirmada } from '../../src/services/sessao/marcarSessaoNaoConfirmada'
import { encerrarSessaoPeloServidor } from '../../src/services/sessao/encerrarSessaoPeloServidor'
import { reanimarSessao } from '../../src/services/sessao/reanimarSessao'
import { chaveCooldownParada, pedirParadaSessao } from '../../src/services/sessao/pedirParadaSessao'
import type { FotoDaSessao } from '../../src/services/sessao/travarSessao'
import { chamarHandler, comFakeGateway, criarCenario, criarSessao, debitosDaSessao, minutosAtras, saldo, TARIFF_SNAPSHOT_COM_TAXA, type Cenario, cenariosCriados, resolverCapturasPendentes } from './helpers/sessaoTravadaFixture'
import { createUser, uniqueSuffix } from './helpers/fixtures'

/**
 * F5.9b1 — os SERVIÇOS de sessão travada contra Postgres + Redis reais: pedir parada (gateway de mentira pelo barramento), marcar não
 * confirmada, reanimar, encerrar pelo servidor (cada prova de leitura x cada política D2 x WALLET/CARD), as corridas contra o
 * StopTransaction do carregador e a identidade de conciliação. Tarifa R$ 1,00/kWh (1.000 Wh = 100 centavos).
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

const foto = (l: { status: FotoDaSessao['status']; lastActivityAt: Date | null; lastMeterValuesAt: Date | null; stopRequestedAt: Date | null; stopAttempts: number; unconfirmedAt: Date | null }): FotoDaSessao => ({
  status: l.status,
  lastActivityAt: l.lastActivityAt,
  lastMeterValuesAt: l.lastMeterValuesAt,
  stopRequestedAt: l.stopRequestedAt,
  stopAttempts: l.stopAttempts,
  unconfirmedAt: l.unconfirmedAt,
})

describe('Serviços de sessão travada (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let cen: Cenario

  beforeAll(async () => {
    cen = await criarCenario(suffix, 'enc')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await resolverCapturasPendentes(cenariosCriados) // hermético: não deixa CAPTURE_PENDING velho para o varredor de outras suítes
    await prisma.$disconnect()
    redis.disconnect()
  })

  const sessao = (id: string) => prisma.chargingSession.findUniqueOrThrow({ where: { id } })
  const intentDe = (sessionId: string) => prisma.paymentIntent.findFirstOrThrow({ where: { chargingSessionId: sessionId, purpose: 'SESSION_CARD_CAPTURE' } })

  /** Registra no log bruto um StopTransaction INBOUND (o que `idempotency.ts` grava ANTES do handler) — sem processar. */
  async function stopNoLogBruto(c: Cenario, transactionId: number, meterStop: number, quando: Date, reason: string = 'PowerLoss') {
    await prisma.ocppMessage.create({
      data: {
        chargePointId: c.tenant.chargePointId,
        operatorId: c.tenant.operatorId,
        direction: 'INBOUND',
        messageType: 'CALL',
        ocppMessageId: randomUUID(),
        action: 'StopTransaction',
        payload: { transactionId, meterStop, timestamp: quando.toISOString(), reason },
        occurredAt: quando,
      },
    })
  }

  const naoConfirmada = { motivo: 'CHARGER_UNREACHABLE', haMin: 200 } as const

  describe('pedirParadaSessao — único ponto de RemoteStop (gateway OCPP de mentira pelo barramento Redis real)', () => {
    it('Accepted: grava stopRequestedAt/By e stopAttempts, manda o RemoteStopTransaction certo e a sessão SEGUE aberta', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, amostrasWh: [2_000] })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        const r = await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER' })
        expect(r).toMatchObject({ registrado: true, tentativa: 1, comando: 'ACCEPTED', marcacao: null })
        expect(recebidos).toEqual([{ method: 'RemoteStopTransaction', params: { transactionId: s.session.ocppTransactionId } }])
      })
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('CHARGING')
      expect(linha.stopRequestedBy).toBe('DRIVER')
      expect(linha.stopAttempts).toBe(1)
      expect(linha.stopRequestedAt).not.toBeNull()
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
    })

    it('Rejected: STOP_UNCONFIRMED(STOP_REJECTED) com unconfirmedAt+reason no MESMO update — e NENHUM dinheiro (era aqui que o reconciliarSessaoOrfa cobrava na hora)', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000, meterStartWh: 1_000, amostrasWh: [3_000] })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Rejected' }, async () => {
        const r = await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'ADMIN' })
        expect(r).toMatchObject({ registrado: true, comando: 'REJECTED', marcacao: 'MARCADA' })
      })
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOP_UNCONFIRMED')
      expect(linha.unconfirmedReason).toBe('STOP_REJECTED')
      expect(linha.unconfirmedAt).not.toBeNull()
      expect(linha.provisionalCostCents).toBe(200)
      expect(linha.stopRequestedBy).toBe('ADMIN')
      expect(linha.stoppedAt).toBeNull()
      expect(linha.totalCostCents).toBeNull()
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
      expect(await saldo(s.wallet.id)).toBe(5_000)
      expect(alertas.map((a) => a.alert)).toContain('session_stop_unconfirmed')
    })

    it('erro de transporte (o gateway responde ok:false): STOP_UNCONFIRMED(CHARGER_UNREACHABLE)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000 })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'erro' }, async () => {
        const r = await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER' })
        expect(r).toMatchObject({ registrado: true, comando: 'UNREACHABLE', marcacao: 'MARCADA' })
      })
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOP_UNCONFIRMED')
      expect(linha.unconfirmedReason).toBe('CHARGER_UNREACHABLE')
    })

    it('TIMEOUT só registra: a sessão segue aberta (quem decide é o R3), com o pedido gravado', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000 })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'silencio' }, async () => {
        const r = await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER', timeoutMs: 400 })
        expect(r).toMatchObject({ registrado: true, comando: 'TIMEOUT', marcacao: null })
      })
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('CHARGING')
      expect(linha.stopAttempts).toBe(1)
      expect(linha.unconfirmedAt).toBeNull()
    })

    it('a cada nova tentativa incrementa stopAttempts e RE-CARIMBA stopRequestedAt (é ele que espaça o R3); o 1º solicitante (automático) permanece, humano assume', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000 })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async () => {
        await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'GUARD' })
        const primeira = await sessao(s.session.id)
        await redis.del(chaveCooldownParada(s.session.id))
        await new Promise((r) => setTimeout(r, 15))
        await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'WATCHDOG' })
        const segunda = await sessao(s.session.id)
        expect(segunda.stopAttempts).toBe(2)
        expect(segunda.stopRequestedAt!.getTime()).toBeGreaterThan(primeira.stopRequestedAt!.getTime())
        expect(segunda.stopRequestedBy).toBe('GUARD')

        await redis.del(chaveCooldownParada(s.session.id))
        await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER' })
        const terceira = await sessao(s.session.id)
        expect(terceira.stopAttempts).toBe(3)
        expect(terceira.stopRequestedBy).toBe('DRIVER')
      })
    })

    it('duplo toque SIMULTÂNEO: um pedido registra, o outro cai no cooldown — 1 tentativa, 1 comando', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 5_000 })
      await comFakeGateway(cen.tenant.chargePointId, { RemoteStopTransaction: 'Accepted' }, async (recebidos) => {
        const [a, b] = await Promise.all([pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER' }), pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER' })])
        expect([a.registrado, b.registrado].sort()).toEqual([false, true])
        expect([a, b].find((x) => !x.registrado)).toEqual({ registrado: false, motivo: 'EM_COOLDOWN' })
        expect(recebidos.filter((c) => c.method === 'RemoteStopTransaction')).toHaveLength(1)
      })
      expect((await sessao(s.session.id)).stopAttempts).toBe(1)
    })

    it.each(['STOPPED', 'STOP_UNCONFIRMED'] as const)('sessão %s: NAO_ABERTA, nada gravado e nenhum comando', async (status) => {
      const s = await criarSessao(cen, { mode: 'WALLET', status, naoConfirmada: status === 'STOP_UNCONFIRMED' ? naoConfirmada : undefined })
      await comFakeGateway(cen.tenant.chargePointId, {}, async (recebidos) => {
        expect(await pedirParadaSessao({ sessionId: s.session.id, solicitante: 'DRIVER' })).toEqual({ registrado: false, motivo: 'NAO_ABERTA' })
        expect(recebidos).toHaveLength(0)
      })
      expect((await sessao(s.session.id)).stopAttempts).toBe(0)
    })
  })

  describe('marcarSessaoNaoConfirmada', () => {
    it('é idempotente: a 2ª chamada devolve JA_NAO_CONFIRMADA e NÃO mexe em unconfirmedAt/motivo', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 1_000, amostrasWh: [2_000] })
      expect(await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'MAX_DURATION' })).toBe('MARCADA')
      const primeira = await sessao(s.session.id)
      expect(await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CONNECTOR_IDLE' })).toBe('JA_NAO_CONFIRMADA')
      const segunda = await sessao(s.session.id)
      expect(segunda.unconfirmedReason).toBe('MAX_DURATION')
      expect(segunda.unconfirmedAt!.toISOString()).toBe(primeira.unconfirmedAt!.toISOString())
    })

    it('com a foto velha (atividade nova entre o snapshot e o lock): CONDICAO_MUDOU e a sessão fica como estava', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 1_000, atividadeHaMin: 20 })
      const fotoVelha = foto(await sessao(s.session.id))
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { lastActivityAt: new Date() } }) // chegou MeterValues no meio
      expect(await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CHARGER_UNREACHABLE', fotoEsperada: fotoVelha })).toBe('CONDICAO_MUDOU')
      expect((await sessao(s.session.id)).status).toBe('CHARGING')
    })

    it('custo provisório sem NENHUMA leitura segue a política D2 (NO_CHARGE => 0, mesmo com taxa fixa) e nunca estima energia', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 1_000, tariffSnapshot: TARIFF_SNAPSHOT_COM_TAXA })
      await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'CHARGER_REBOOTED' })
      expect((await sessao(s.session.id)).provisionalCostCents).toBe(0)
    })

    it('CARD em STOP_UNCONFIRMED: a pré-autorização CONTINUA AUTHORIZED (nem captura nem cancela até a sessão encerrar)', async () => {
      const s = await criarSessao(cen, { mode: 'CARD', amostrasWh: [2_000] })
      await marcarSessaoNaoConfirmada({ sessionId: s.session.id, motivo: 'STOP_REJECTED' })
      expect((await intentDe(s.session.id)).status).toBe('AUTHORIZED')
    })
  })

  describe('encerrarSessaoPeloServidor — cada prova de leitura x WALLET', () => {
    it('prova 1 (StopTransaction no log bruto, que vale mesmo sem o handler ter fechado): usa o meterStop e o horário do payload, motivo do Stop e cobra o REAL', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000] })
      const quando = minutosAtras(3)
      await stopNoLogBruto(cen, s.session.ocppTransactionId, 5_000, quando)
      // isca: Stop de OUTRA transação do mesmo carregador — jamais pode ser usado
      await stopNoLogBruto(cen, s.session.ocppTransactionId + 100_000, 99_999, minutosAtras(1))

      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id })).toEqual({ encerrada: true, prova: 'STOP_TRANSACTION', custoZerado: false })

      const linha = await sessao(s.session.id)
      expect(linha).toMatchObject({ status: 'STOPPED', closureSource: 'SERVER', meterStopSource: 'STOP_TRANSACTION', meterStopWh: 5_000, energyDeliveredWh: 4_000, totalCostCents: 400, stopReason: 'POWER_LOSS' })
      expect(linha.stoppedAt?.toISOString()).toBe(quando.toISOString())
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
      expect(await saldo(s.wallet.id)).toBe(9_600)
      expect(alertas.map((a) => a.alert)).toContain('session_closed_by_server')
      expect(alertas.map((a) => a.alert)).not.toContain('session_closed_without_meter_reading')
    })

    it('prova 2 (última amostra Energy.Active.Import.Register): meterStop e horário da AMOSTRA, stopReason OTHER', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 4_000] })
      const ultima = await prisma.meterSample.findFirstOrThrow({ where: { sessionId: s.session.id }, orderBy: { ts: 'desc' } })

      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id })).toMatchObject({ encerrada: true, prova: 'LAST_METER_SAMPLE' })

      const linha = await sessao(s.session.id)
      expect(linha).toMatchObject({ status: 'STOPPED', closureSource: 'SERVER', meterStopSource: 'LAST_METER_SAMPLE', meterStopWh: 4_000, totalCostCents: 300, stopReason: 'OTHER' })
      expect(linha.stoppedAt?.toISOString()).toBe(ultima.ts.toISOString())
      expect(await saldo(s.wallet.id)).toBe(9_700)
    })

    it('prova 3 (NENHUMA leitura) com a política NO_CHARGE (D2): custo ZERO mesmo com taxa fixa, carteira sem débito, alerta de ERRO', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 10_000, meterStartWh: 1_234, tariffSnapshot: TARIFF_SNAPSHOT_COM_TAXA })

      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id, politicaSemLeitura: 'NO_CHARGE' })).toEqual({ encerrada: true, prova: 'NO_READING', custoZerado: true })

      const linha = await sessao(s.session.id)
      expect(linha).toMatchObject({ status: 'STOPPED', closureSource: 'SERVER', meterStopSource: 'NO_READING', meterStopWh: 1_234, energyDeliveredWh: 0, totalCostCents: 0, sessionFeeCents: 0 })
      expect(linha.stoppedAt?.toISOString()).toBe(s.session.startedAt.toISOString())
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
      expect(await saldo(s.wallet.id)).toBe(10_000)
      const a = alertas.find((x) => x.alert === 'session_closed_without_meter_reading')
      expect(a?.nivel).toBe('error')
      expect(a?.campos).toMatchObject({ policy: 'NO_CHARGE', chargeZeroed: true })
    })

    it('prova 3 (NENHUMA leitura) com a política MIN_FEE: comportamento antigo — cobra a taxa fixa com energia 0 (e o alerta continua)', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 10_000, tariffSnapshot: TARIFF_SNAPSHOT_COM_TAXA })

      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id, politicaSemLeitura: 'MIN_FEE' })).toEqual({ encerrada: true, prova: 'NO_READING', custoZerado: false })

      const linha = await sessao(s.session.id)
      expect(linha).toMatchObject({ status: 'STOPPED', meterStopSource: 'NO_READING', energyDeliveredWh: 0, totalCostCents: 200 })
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
      expect(await saldo(s.wallet.id)).toBe(9_800)
      expect(alertas.map((a) => a.alert)).toContain('session_closed_without_meter_reading')
    })

    it('a política D2 NÃO afeta quem tem leitura: com amostra, NO_CHARGE e MIN_FEE cobram exatamente o mesmo', async () => {
      const a = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 10_000, meterStartWh: 0, amostrasWh: [2_000] })
      const b = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 10_000, meterStartWh: 0, amostrasWh: [2_000] })
      await encerrarSessaoPeloServidor({ sessionId: a.session.id, politicaSemLeitura: 'NO_CHARGE' })
      await encerrarSessaoPeloServidor({ sessionId: b.session.id, politicaSemLeitura: 'MIN_FEE' })
      expect((await sessao(a.session.id)).totalCostCents).toBe(200)
      expect((await sessao(b.session.id)).totalCostCents).toBe(200)
    })

    it('saldo insuficiente: debita o que há e o resto vira Debt (o MESMO caminho do StopTransaction)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 100, meterStartWh: 0, amostrasWh: [4_000] })
      await encerrarSessaoPeloServidor({ sessionId: s.session.id })
      expect((await sessao(s.session.id)).totalCostCents).toBe(400)
      expect(await saldo(s.wallet.id)).toBe(0)
      const divida = await prisma.debt.findFirstOrThrow({ where: { chargingSessionId: s.session.id } })
      expect(divida.amountCents).toBe(300)
    })
  })

  describe('encerrarSessaoPeloServidor — CARD (captura min(total, autorizado) ou cancelamento)', () => {
    it('Stop no log: intent CAPTURE_PENDING com o valor-alvo = total; NADA na carteira', async () => {
      const s = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada, meterStartWh: 1_000, amostrasWh: [2_000], autorizadoCents: 5_000 })
      await stopNoLogBruto(cen, s.session.ocppTransactionId, 5_000, minutosAtras(3))

      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id })).toMatchObject({ encerrada: true, prova: 'STOP_TRANSACTION' })

      expect((await sessao(s.session.id)).totalCostCents).toBe(400)
      const intent = await intentDe(s.session.id)
      expect(intent.status).toBe('CAPTURE_PENDING')
      expect(intent.captureAmountCents).toBe(400)
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
    })

    it('total acima do autorizado: captura só o autorizado (min), a sessão guarda o total real — a diferença vira Debt na captura (já existente)', async () => {
      const s = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada, meterStartWh: 0, amostrasWh: [4_000], autorizadoCents: 300 })
      await encerrarSessaoPeloServidor({ sessionId: s.session.id })
      expect((await sessao(s.session.id)).totalCostCents).toBe(400)
      expect((await intentDe(s.session.id)).captureAmountCents).toBe(300)
    })

    it('NENHUMA leitura + NO_CHARGE: total 0 => a pré-autorização é CANCELADA (VOIDED), nada capturado', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada, tariffSnapshot: TARIFF_SNAPSHOT_COM_TAXA })
      await encerrarSessaoPeloServidor({ sessionId: s.session.id, politicaSemLeitura: 'NO_CHARGE' })

      expect((await sessao(s.session.id)).totalCostCents).toBe(0)
      const intent = await intentDe(s.session.id)
      expect(intent.status).toBe('VOIDED')
      expect(intent.captureAmountCents).toBeNull()
      expect(alertas.map((a) => a.alert)).toContain('session_closed_without_meter_reading')
    })

    it('NENHUMA leitura + MIN_FEE: cobra a taxa fixa — CAPTURE_PENDING de 200', async () => {
      const s = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada, tariffSnapshot: TARIFF_SNAPSHOT_COM_TAXA })
      await encerrarSessaoPeloServidor({ sessionId: s.session.id, politicaSemLeitura: 'MIN_FEE' })
      const intent = await intentDe(s.session.id)
      expect(intent.status).toBe('CAPTURE_PENDING')
      expect(intent.captureAmountCents).toBe(200)
    })

    it('prazo do hold do cartão: forcadoPeloPrazoDoCartao acrescenta o alerta card_session_hold_deadline (erro)', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada, meterStartWh: 0, amostrasWh: [1_000] })
      await encerrarSessaoPeloServidor({ sessionId: s.session.id, forcadoPeloPrazoDoCartao: true })
      expect(alertas.find((a) => a.alert === 'card_session_hold_deadline')?.nivel).toBe('error')
    })
  })

  describe('encerrarSessaoPeloServidor — o que NUNCA faz', () => {
    it('sessão ABERTA (nunca passou por STOP_UNCONFIRMED): STATUS_NAO_PERMITIDO — aberta -> STOPPED direto é proibido', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', saldoCents: 1_000, amostrasWh: [2_000] })
      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id })).toEqual({ encerrada: false, motivo: 'STATUS_NAO_PERMITIDO' })
      expect((await sessao(s.session.id)).status).toBe('CHARGING')
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
    })

    it('sessão já STOPPED: JA_ENCERRADA, nenhum débito novo', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 1_000, meterStartWh: 0, amostrasWh: [1_000] })
      await encerrarSessaoPeloServidor({ sessionId: s.session.id })
      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id })).toEqual({ encerrada: false, motivo: 'JA_ENCERRADA' })
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
    })

    it('a foto do watchdog mudou sob o lock (chegou MeterValues): FOTO_MUDOU — não fecha uma sessão que voltou a entregar', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 1_000, amostrasWh: [2_000], lastMeterValuesHaMin: 190 })
      const fotoVelha = foto(await sessao(s.session.id))
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { lastMeterValuesAt: new Date(), lastActivityAt: new Date() } })
      expect(await encerrarSessaoPeloServidor({ sessionId: s.session.id, fotoEsperada: fotoVelha })).toEqual({ encerrada: false, motivo: 'FOTO_MUDOU' })
      expect((await sessao(s.session.id)).status).toBe('STOP_UNCONFIRMED')
    })
  })

  describe('reanimarSessao (U1)', () => {
    it('volta a CHARGING, limpa unconfirmedAt/Reason/provisório, MANTÉM stopAttempts e alerta de ERRO — nada de dinheiro', async () => {
      const alertas = espiarAlertas()
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 5 }, lastMeterValuesHaMin: 1, stopRequestedHaMin: 6 })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { provisionalCostCents: 150 } })

      expect(await reanimarSessao({ sessionId: s.session.id, fotoEsperada: foto(await sessao(s.session.id)) })).toBe('REANIMADA')

      const linha = await sessao(s.session.id)
      expect(linha).toMatchObject({ status: 'CHARGING', unconfirmedAt: null, unconfirmedReason: null, provisionalCostCents: null, stopAttempts: 1 })
      expect(await debitosDaSessao(s.session.id)).toHaveLength(0)
      expect(alertas.find((a) => a.alert === 'session_revived_after_unconfirmed')?.nivel).toBe('error')
    })

    it('com a janela de ociosidade já aberta (chargingEndedAt), volta a FINISHING', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: { motivo: 'CONNECTOR_IDLE', haMin: 5 }, lastMeterValuesHaMin: 1 })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { chargingEndedAt: minutosAtras(20) } })
      await reanimarSessao({ sessionId: s.session.id, fotoEsperada: foto(await sessao(s.session.id)) })
      expect((await sessao(s.session.id)).status).toBe('FINISHING')
    })

    it('foto velha: CONDICAO_MUDOU; sessão que não está em confirmação: NAO_ESTA_NAO_CONFIRMADA', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 5 }, lastMeterValuesHaMin: 1 })
      const velha = foto(await sessao(s.session.id))
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { lastMeterValuesAt: new Date() } })
      expect(await reanimarSessao({ sessionId: s.session.id, fotoEsperada: velha })).toBe('CONDICAO_MUDOU')

      const aberta = await criarSessao(cen, { mode: 'WALLET', saldoCents: 1_000 })
      expect(await reanimarSessao({ sessionId: aberta.session.id, fotoEsperada: foto(await sessao(aberta.session.id)) })).toBe('NAO_ESTA_NAO_CONFIRMADA')
    })

    it('OUTRA sessão ativa no mesmo conector (D7): o índice único parcial barra — CONECTOR_OCUPADO, a sessão segue em confirmação (a transação inteira é desfeita)', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 1_000, naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 5 }, lastMeterValuesHaMin: 1 })
      const outroMotorista = await prisma.user.create({ data: { role: 'DRIVER', name: `Outro ${suffix}`, email: `outro-${randomUUID().slice(0, 6)}-${suffix}@example.com` } })
      const outroToken = await prisma.authToken.create({ data: { idTag: `T${randomUUID().replace(/-/g, '')}`.slice(0, 20), type: 'RFID', userId: outroMotorista.id } })
      await prisma.chargingSession.create({
        data: { operatorId: cen.tenant.operatorId, siteId: cen.tenant.siteId, chargePointId: cen.tenant.chargePointId, connectorId: s.connector.id, authTokenId: outroToken.id, userId: outroMotorista.id, status: 'STARTED', meterStartWh: 0, startedAt: new Date(), tariffId: cen.tenant.tariffId, tariffSnapshot: s.session.tariffSnapshot as never },
      })

      expect(await reanimarSessao({ sessionId: s.session.id, fotoEsperada: foto(await sessao(s.session.id)) })).toBe('CONECTOR_OCUPADO')
      const linha = await sessao(s.session.id)
      expect(linha.status).toBe('STOP_UNCONFIRMED')
      expect(linha.unconfirmedReason).toBe('STOP_REJECTED')
    })
  })

  describe('DOIS EXECUTORES SIMULTÂNEOS — watchdog (encerrar pelo servidor) x StopTransaction do carregador', () => {
    it('WALLET, 8 rodadas: NUNCA cobrança dupla, NUNCA dois fechamentos; o perdedor vira stop tardio (ou duplicata) e o total é coerente com a prova do VENCEDOR', async () => {
      for (let rodada = 0; rodada < 8; rodada++) {
        const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000, 3_000] })
        const stopTs = minutosAtras(2).toISOString()
        const [servidor, carregador] = await Promise.all([
          encerrarSessaoPeloServidor({ sessionId: s.session.id }),
          chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: stopTs, reason: 'Local' }),
        ])
        expect(carregador.idTagInfo.status).toBe('Accepted') // o carregador SEMPRE recebe Accepted

        const linha = await sessao(s.session.id)
        const debitos = await debitosDaSessao(s.session.id)
        expect(linha.status).toBe('STOPPED')
        expect(debitos, `rodada ${rodada}: exatamente UM débito`).toHaveLength(1)
        expect(await saldo(s.wallet.id)).toBe(10_000 - linha.totalCostCents!)
        expect(debitos[0]!.amountCents).toBe(-linha.totalCostCents!)

        if (linha.closureSource === 'CHARGER') {
          expect(linha.totalCostCents).toBe(500)
          expect(linha.meterStopSource).toBe('STOP_TRANSACTION')
          expect(servidor).toMatchObject({ encerrada: false, motivo: 'JA_ENCERRADA' })
          expect(linha.lateStopReceivedAt).toBeNull()
        } else {
          // O servidor ganhou o lock. Duas possibilidades LEGÍTIMAS, e o total tem de ser coerente com a prova que ele usou:
          //  - o Stop do carregador JÁ estava no log bruto (idempotency.ts o grava ANTES do handler): prova 1, cobra o REAL (500) e o Stop
          //    que chega depois é só a confirmação — diferença não cobrada 0;
          //  - o log ainda não existia: última amostra (200) e o Stop vira stop tardio, registrado e NUNCA cobrado (diferença 300).
          expect(linha.closureSource).toBe('SERVER')
          expect(servidor.encerrada).toBe(true)
          expect(linha.lateStopMeterWh).toBe(6_000)
          if (linha.meterStopSource === 'STOP_TRANSACTION') {
            expect(linha.totalCostCents).toBe(500)
            expect(linha.unbilledCostCents).toBe(0)
          } else {
            expect(linha.meterStopSource).toBe('LAST_METER_SAMPLE')
            expect(linha.totalCostCents).toBe(200)
            expect(linha.unbilledCostCents).toBe(300)
          }
        }
      }
    })

    it('CARD: exatamente UM intent em CAPTURE_PENDING e o valor-alvo bate com o total da sessão vencedora', async () => {
      for (let rodada = 0; rodada < 5; rodada++) {
        const s = await criarSessao(cen, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada, meterStartWh: 1_000, amostrasWh: [2_000, 3_000], autorizadoCents: 5_000 })
        await Promise.all([
          encerrarSessaoPeloServidor({ sessionId: s.session.id }),
          chamarHandler(handleStopTransaction, cen.ctx, { transactionId: s.session.ocppTransactionId, meterStop: 6_000, timestamp: minutosAtras(2).toISOString() }),
        ])
        const linha = await sessao(s.session.id)
        const intents = await prisma.paymentIntent.findMany({ where: { chargingSessionId: s.session.id } })
        expect(intents).toHaveLength(1)
        expect(intents[0]!.status).toBe('CAPTURE_PENDING')
        expect(intents[0]!.captureAmountCents).toBe(linha.totalCostCents)
        expect(await debitosDaSessao(s.session.id)).toHaveLength(0) // CARD jamais debita a carteira
      }
    })

    it('dois encerramentos do servidor ao mesmo tempo: UM só encerra, o outro vê JA_ENCERRADA', async () => {
      const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 10_000, meterStartWh: 0, amostrasWh: [2_000] })
      const [a, b] = await Promise.all([encerrarSessaoPeloServidor({ sessionId: s.session.id }), encerrarSessaoPeloServidor({ sessionId: s.session.id })])
      expect([a.encerrada, b.encerrada].sort()).toEqual([false, true])
      expect(await debitosDaSessao(s.session.id)).toHaveLength(1)
    })
  })

  describe('a identidade de conciliação continua fechando com sessões encerradas pelo servidor (a fórmula NÃO mudou)', () => {
    it('receita = captura de cartão pendente + débito de carteira + dívida aberta, differenceCents === 0; stop tardio e STOP_UNCONFIRMED não entram', async () => {
      const conc = await criarCenario(suffix, 'conc') // operador PRÓPRIO: o relatório sai com números exatos
      const admin = await createUser({ role: 'ADMIN', label: 'admin-conc', suffix })

      // a) WALLET fechada pelo servidor com a última amostra: 400 centavos, saldo suficiente.
      const a = await criarSessao(conc, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 10_000, meterStartWh: 0, amostrasWh: [4_000] })
      await encerrarSessaoPeloServidor({ sessionId: a.session.id })
      // b) WALLET com saldo curto: 400 de custo = 100 de carteira + 300 de dívida.
      const b = await criarSessao(conc, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 100, meterStartWh: 0, amostrasWh: [4_000] })
      await encerrarSessaoPeloServidor({ sessionId: b.session.id })
      // c) CARD fechada pelo servidor com o Stop do log: 400 pendentes de captura.
      const c = await criarSessao(conc, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada, meterStartWh: 0, amostrasWh: [1_000], autorizadoCents: 5_000 })
      await stopNoLogBruto(conc, c.session.ocppTransactionId, 4_000, minutosAtras(3))
      await encerrarSessaoPeloServidor({ sessionId: c.session.id })
      // d) sem leitura nenhuma + NO_CHARGE: receita 0, nada a conciliar.
      const d = await criarSessao(conc, { mode: 'CARD', status: 'STOP_UNCONFIRMED', naoConfirmada })
      await encerrarSessaoPeloServidor({ sessionId: d.session.id, politicaSemLeitura: 'NO_CHARGE' })
      // e) ainda em confirmação, com custo provisório: NÃO é receita.
      const e = await criarSessao(conc, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada, saldoCents: 5_000, meterStartWh: 0, amostrasWh: [9_000] })
      await prisma.chargingSession.update({ where: { id: e.session.id }, data: { provisionalCostCents: 900 } })
      // f) Stop tardio sobre (a): registra, mas não muda o total.
      await chamarHandler(handleStopTransaction, conc.ctx, { transactionId: a.session.ocppTransactionId, meterStop: 8_000, timestamp: minutosAtras(1).toISOString() })

      const from = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)
      const to = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10)
      const res = await request(app).get('/api/admin/reports/payments').query({ from, to, operatorId: conc.tenant.operatorId, pageSize: 100 }).set('Authorization', `Bearer ${admin.token}`)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const r = res.body.reconciliation as Record<string, number>

      expect(r.revenueCents).toBe(1_200) // 400 + 400 + 400 (d = 0; e ainda não é receita)
      expect(r.walletDebitCents).toBe(500) // 400 + 100
      expect(r.openDebtCents).toBe(300)
      expect(r.cardCapturePendingCents).toBe(400)
      expect(r.cardCapturedCents).toBe(0)
      expect(r.differenceCents).toBe(0)
      expect(r.expectedCents).toBe(r.accountedCents)
    })
  })
})
