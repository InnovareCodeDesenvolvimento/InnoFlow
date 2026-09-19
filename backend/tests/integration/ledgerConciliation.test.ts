import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Prisma } from '@prisma/client'
import type { IHandlersOption } from 'ocpp-rpc'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import type { OcppHandlerCtx } from '../../src/ocpp/context'
import { handleStartTransaction } from '../../src/ocpp/handlers/startTransaction'
import { handleMeterValues } from '../../src/ocpp/handlers/meterValues'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { finalizarSessao } from '../../src/services/carteira/finalizarSessao'
import { liquidarSessao } from '../../src/services/carteira/liquidarSessao'
import { issueToken } from '../../src/lib/jwt'
import { createTenant, makeIdTag, uniqueSuffix, type TestTenant } from './helpers/fixtures'

/**
 * Ciclo financeiro COMPLETO contra Postgres real: StartTransaction ->
 * MeterValues -> StopTransaction (handlers OCPP de verdade, chamados
 * direto — o transporte WebSocket não muda a regra de negócio) -> custo ->
 * débito da carteira / dívida -> relatório de conciliação.
 *
 * A IDENTIDADE (`revenue = cardCaptured + walletDebit + openDebt`,
 * `differenceCents = 0`) é conferida contra um ORÁCULO calculado aqui no
 * teste (somas feitas à mão), nunca contra o próprio número do relatório.
 *
 * Tarifa dos fixtures: R$ 1,00/kWh, sem taxa nem mínimo — 1 kWh = 100
 * centavos, para as contas ficarem legíveis.
 */

function callHandler<T>(handler: (args: IHandlersOption, ctx: OcppHandlerCtx) => Promise<T>, ctx: OcppHandlerCtx, params: unknown, messageId: string = randomUUID()): Promise<T> {
  return handler({ messageId, params, method: 'X', signal: new AbortController().signal } as unknown as IHandlersOption, ctx)
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

describe('Ledger e conciliação financeira (Postgres real)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()

  /** Um "cenário" = um operador com seu carregador OCPP. O describe do meio usa um operador PRÓPRIO para o relatório sair com números exatos. */
  interface Scope {
    t: TestTenant
    ctx: OcppHandlerCtx
  }
  let main: Scope
  let adminToken: string
  const connectorCounter = new Map<string, number>() // por charge point: cada sessão usa um conector novo

  // ---- helpers de cenário --------------------------------------------------
  /** Cria motorista + carteira + token RFID e devolve tudo, com `balanceCents` já creditado (entrada append-only de saldo inicial). */
  async function newDriver(label: string, balanceCents: number) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver ${label} ${suffix}`, email: `driver-${label}-${suffix}@example.com` } })
    const wallet = await prisma.wallet.create({ data: { userId: user.id } })
    const token = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: user.id } })
    if (balanceCents > 0) await ajustar(wallet.id, balanceCents)
    return { user, wallet, idTag: token.idTag, tokenId: token.id }
  }

  /** Lançamento manual de crédito/débito (append-only): o saldo é sempre `balanceAfterCents` da ÚLTIMA entrada. */
  async function ajustar(walletId: string, deltaCents: number) {
    const last = await prisma.walletEntry.findFirst({ where: { walletId }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
    const before = last?.balanceAfterCents ?? 0
    await prisma.walletEntry.create({
      data: { walletId, type: deltaCents >= 0 ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT', amountCents: deltaCents, balanceAfterCents: before + deltaCents, referenceType: 'MANUAL', description: `ajuste de teste ${suffix}` },
    })
  }

  async function saldo(walletId: string): Promise<number> {
    return (await prisma.walletEntry.findFirst({ where: { walletId }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } }))?.balanceAfterCents ?? 0
  }

  /** Um conector novo por sessão (o índice `ux_charging_session_active_per_connector` só admite UMA sessão ativa por conector). Devolve o id interno e o número OCPP. */
  async function newConnector(sc: Scope): Promise<{ id: string; connectorId: number }> {
    const n = (connectorCounter.get(sc.t.chargePointId) ?? 1) + 1 // o 1 já existe (createTenant)
    connectorCounter.set(sc.t.chargePointId, n)
    const c = await prisma.connector.create({ data: { operatorId: sc.t.operatorId, chargePointId: sc.t.chargePointId, connectorId: n, type: 'AC_TYPE2' } })
    return { id: c.id, connectorId: n }
  }

  /** Sessão STOPPED montada direto no banco (para cenários de liquidação em que o protocolo OCPP não é o foco). */
  async function stoppedSession(sc: Scope, driver: { user: { id: string }; tokenId: string }, costCents: number) {
    const conn = await newConnector(sc)
    return prisma.chargingSession.create({
      data: {
        operatorId: sc.t.operatorId,
        siteId: sc.t.siteId,
        chargePointId: sc.t.chargePointId,
        connectorId: conn.id,
        authTokenId: driver.tokenId,
        userId: driver.user.id,
        status: 'STOPPED',
        meterStartWh: 0,
        meterStopWh: 1,
        energyDeliveredWh: 1,
        startedAt: minutesAgo(50),
        stoppedAt: minutesAgo(20),
        tariffId: sc.t.tariffId,
        tariffSnapshot: {} as Prisma.InputJsonValue,
        totalCostCents: costCents,
      },
    })
  }

  /** Percorre Start -> MeterValues -> (opcional gancho) -> Stop pelos handlers reais. Devolve o que o teste precisa conferir. */
  async function runSession(sc: Scope, opts: { idTag: string; deliveredWh: number; beforeStop?: () => Promise<void>; startedMinAgo?: number }) {
    const { connectorId } = await newConnector(sc)
    const ctx = sc.ctx
    const meterStart = 5_000
    const startedAt = minutesAgo(opts.startedMinAgo ?? 40)

    const start = await callHandler(handleStartTransaction, ctx, { connectorId, idTag: opts.idTag, meterStart, timestamp: startedAt.toISOString() })
    expect(start.idTagInfo.status, 'StartTransaction tem que ser aceito').toBe('Accepted')
    const session = await prisma.chargingSession.findUniqueOrThrow({ where: { ocppTransactionId: start.transactionId } })

    await callHandler(handleMeterValues, ctx, {
      connectorId,
      transactionId: start.transactionId,
      meterValue: [
        {
          timestamp: minutesAgo((opts.startedMinAgo ?? 40) / 2).toISOString(),
          sampledValue: [
            { value: String(meterStart + Math.min(300, opts.deliveredWh)), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
            { value: '7000', measurand: 'Power.Active.Import', unit: 'W' },
            { value: '40', measurand: 'SoC', unit: 'Percent' },
          ],
        },
      ],
    })

    if (opts.beforeStop) await opts.beforeStop()

    const stop = await callHandler(handleStopTransaction, ctx, {
      transactionId: start.transactionId,
      meterStop: meterStart + opts.deliveredWh,
      timestamp: minutesAgo(10).toISOString(),
      reason: 'Local',
    })
    expect(stop.idTagInfo.status).toBe('Accepted')
    return { sessionId: session.id, transactionId: start.transactionId, connectorId }
  }

  const reportFor = async (auth: string, operatorId?: string) => {
    const from = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)
    const to = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10)
    const res = await request(app)
      .get('/api/admin/reports/payments')
      .query({ from, to, ...(operatorId ? { operatorId } : {}), pageSize: 100 })
      .set('Authorization', `Bearer ${auth}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.reconciliation as Record<string, number>
  }

  /** Vincula a tarifa do operador (escopo OPERATOR) — sem isso o StartTransaction não resolve tarifa — e monta o contexto OCPP do carregador. */
  async function scopeFor(t: TestTenant): Promise<Scope> {
    await prisma.tariffAssignment.create({ data: { operatorId: t.operatorId, tariffId: t.tariffId, scope: 'OPERATOR' } })
    return { t, ctx: { chargePointId: t.chargePointId, operatorId: t.operatorId, ocppIdentity: t.ocppIdentity } }
  }

  beforeAll(async () => {
    main = await scopeFor(await createTenant({ suffix, label: 'led' }))
    const admin = await prisma.user.create({ data: { role: 'ADMIN', name: `Admin Ledger ${suffix}`, email: `admin-ledger-${suffix}@example.com` } })
    adminToken = issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })
  })

  afterAll(async () => {
    // WalletEntry/Debt são imortais (append-only + FK Restrict) — nada é removido aqui.
    await prisma.$disconnect()
    redis.disconnect()
  })

  // ---------------------------------------------------------------------------
  describe('ciclo completo: start -> métricas -> stop -> débito', () => {
    let d: Awaited<ReturnType<typeof newDriver>>
    let s: Awaited<ReturnType<typeof runSession>>

    beforeAll(async () => {
      d = await newDriver('ciclo', 10_000)
      s = await runSession(main, { idTag: d.idTag, deliveredWh: 10_000 })
    })

    it('StartTransaction abriu a sessão com o snapshot da tarifa e o motorista certo', async () => {
      const session = await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.sessionId } })
      expect(session).toMatchObject({ userId: d.user.id, operatorId: main.t.operatorId, siteId: main.t.siteId, meterStartWh: 5_000, tariffId: main.t.tariffId })
      expect(Number((session.tariffSnapshot as { pricePerKwh: string }).pricePerKwh)).toBe(1) // R$ 1,00/kWh congelado na sessão (o Decimal volta normalizado: '1')
    })

    it('MeterValues gravou uma MeterSample por medida (3), com o valor normalizado, e atualizou o painel ao vivo da sessão', async () => {
      const samples = await prisma.meterSample.findMany({ where: { sessionId: s.sessionId }, orderBy: { measurand: 'asc' } })
      expect(samples.map((x) => x.measurand)).toEqual(['Energy.Active.Import.Register', 'Power.Active.Import', 'SoC'])
      expect(Number(samples[0].value)).toBe(5_300)
      const session = await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.sessionId } })
      expect(session).toMatchObject({ lastPowerW: 7000, lastSoc: 40 })
    })

    it('StopTransaction fechou a sessão: energia = meterStop - meterStart, custo = 10 kWh x R$ 1,00 = 1000 centavos', async () => {
      const session = await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.sessionId } })
      expect(session).toMatchObject({ status: 'STOPPED', meterStopWh: 15_000, energyDeliveredWh: 10_000, stopReason: 'LOCAL', totalCostCents: 1000, energyCostCents: 1000 })
      expect(session.stoppedAt).not.toBeNull()
    })

    it('a carteira foi debitada com o contrato LITERAL: CHARGE_DEBIT, referenceType=CHARGING_SESSION, referenceId=session.id (cuid, não o transactionId)', async () => {
      const entries = await prisma.walletEntry.findMany({ where: { walletId: d.wallet.id, type: 'CHARGE_DEBIT' } })
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ amountCents: -1000, balanceAfterCents: 9000, referenceType: 'CHARGING_SESSION', referenceId: s.sessionId })
      expect(entries[0].description).toBe(`Recarga ${s.transactionId} — Site led ${suffix}`)
      expect(await saldo(d.wallet.id)).toBe(9000)
      expect(await prisma.debt.count({ where: { userId: d.user.id } })).toBe(0)
    })

    it('a conciliação do operador fecha em ZERO com o débito real (revenue 1000 = carteira 1000), tanto para ADMIN quanto para o próprio OPERATOR', async () => {
      // Este operador só tem ESTA sessão finalizada até aqui (as demais deste arquivo vêm depois), então o oráculo é exato.
      const asAdmin = await reportFor(adminToken, main.t.operatorId)
      expect(asAdmin).toMatchObject({ revenueCents: 1000, walletDebitCents: 1000, cardCapturedCents: 0, openDebtCents: 0, expectedCents: 1000, accountedCents: 1000, differenceCents: 0 })
      const asOperator = await reportFor(main.t.staff.token)
      expect(asOperator).toMatchObject({ revenueCents: 1000, walletDebitCents: 1000, differenceCents: 0 })
    })

    describe('idempotência: nada é cobrado duas vezes', () => {
      const debitCount = () => prisma.walletEntry.count({ where: { walletId: d.wallet.id, type: 'CHARGE_DEBIT' } })

      it('StopTransaction reenviado (mesmo evento, messageId NOVO — reconexão do carregador) não debita de novo', async () => {
        const again = await callHandler(handleStopTransaction, main.ctx, { transactionId: s.transactionId, meterStop: 15_000, timestamp: minutesAgo(10).toISOString(), reason: 'Local' })
        expect(again.idTagInfo.status).toBe('Accepted')
        expect(await debitCount()).toBe(1)
        expect(await saldo(d.wallet.id)).toBe(9000)
      })

      it('StopTransaction com o MESMO messageId devolve a resposta em cache, sem reprocessar', async () => {
        const messageId = randomUUID()
        const params = { transactionId: s.transactionId, meterStop: 15_000, timestamp: minutesAgo(10).toISOString() }
        const first = await callHandler(handleStopTransaction, main.ctx, params, messageId)
        const second = await callHandler(handleStopTransaction, main.ctx, params, messageId)
        expect(second).toEqual(first)
        expect(await debitCount()).toBe(1)
      })

      it('liquidarSessao e finalizarSessao chamados de novo sobre a sessão já liquidada não cobram nem recalculam nada', async () => {
        const r = await liquidarSessao(s.sessionId)
        expect(r).toMatchObject({ balanceAfterCents: 9000 })
        await finalizarSessao(s.sessionId, { meterStopWh: 99_999, timestamp: new Date(), stopReason: 'OTHER' })
        const session = await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.sessionId } })
        expect(session.totalCostCents).toBe(1000) // a 2ª finalização NÃO recalculou
        expect(await debitCount()).toBe(1)
        expect(await saldo(d.wallet.id)).toBe(9000)
      })

      /**
       * BUG MENOR (Íris, 2026-09-19): o contrato documentado de
       * `LiquidarSessaoResultado.debited` é "true SÓ quando um WalletEntry
       * NOVO foi criado nesta chamada — idempotência/já liquidada não
       * contam". Na prática `liquidarSessaoComTx` calcula
       * `debited = resultado.walletEntryId !== null`, e o ramo idempotente de
       * `debitarSessao` devolve o id da entrada JÁ EXISTENTE — então um
       * reprocessamento sem efeito reporta `debited: true`, e o job de retry
       * (`liquidarSessao` sem tx) republica `wallet.updated` à toa (evento
       * duplicado, sem dano financeiro). Não corrigi: é código de dinheiro do
       * Vega; a correção é devolver de `debitarSessao` um "criado agora"
       * explícito. `it.fails` = comportamento desejado; troque por `it` ao corrigir.
       */
      it.fails('liquidarSessao repetido sobre sessão já liquidada deveria reportar debited: false (FURO CONHECIDO: hoje reporta true)', async () => {
        const r = await liquidarSessao(s.sessionId)
        expect(r?.debited).toBe(false)
      })

      it('TRÊS finalizações CONCORRENTES da mesma sessão (corrida real) -> exatamente 1 débito', async () => {
        const racer = await newDriver('corrida-final', 10_000)
        const conn = await newConnector(main)
        const session = await prisma.chargingSession.create({
          data: {
            operatorId: main.t.operatorId,
            siteId: main.t.siteId,
            chargePointId: main.t.chargePointId,
            connectorId: conn.id,
            authTokenId: racer.tokenId,
            userId: racer.user.id,
            status: 'STARTED',
            meterStartWh: 0,
            startedAt: minutesAgo(30),
            tariffId: main.t.tariffId,
            tariffSnapshot: { id: 't', model: 'PER_KWH', pricePerKwh: '1.00', pricePerMinute: null, sessionFeeCents: null, minChargeCents: null, idleFeePerMinute: 0, idleGracePeriodSeconds: 0, windows: [] } as Prisma.InputJsonValue,
          },
        })
        const final = { meterStopWh: 7_000, timestamp: minutesAgo(5), stopReason: 'LOCAL' as const }
        await Promise.all([finalizarSessao(session.id, final), finalizarSessao(session.id, final), finalizarSessao(session.id, final)])

        const entries = await prisma.walletEntry.findMany({ where: { walletId: racer.wallet.id, type: 'CHARGE_DEBIT' } })
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({ amountCents: -700, referenceId: session.id })
        expect(await saldo(racer.wallet.id)).toBe(9300)
      })

      it('rede de segurança do BANCO: um 2º CHARGE_DEBIT para a mesma sessão viola ux_wallet_entry_charge_debit_once', async () => {
        await expect(
          prisma.walletEntry.create({
            data: { walletId: d.wallet.id, type: 'CHARGE_DEBIT', amountCents: -1000, balanceAfterCents: 8000, referenceType: 'CHARGING_SESSION', referenceId: s.sessionId },
          }),
        ).rejects.toThrow(/ux_wallet_entry_charge_debit_once|Unique constraint/i)
      })
    })

    describe('WalletEntry é append-only (trigger no banco)', () => {
      it('UPDATE é bloqueado e o valor não muda', async () => {
        const entry = await prisma.walletEntry.findFirstOrThrow({ where: { walletId: d.wallet.id, type: 'CHARGE_DEBIT' } })
        await expect(prisma.walletEntry.update({ where: { id: entry.id }, data: { amountCents: -1 } })).rejects.toThrow(/append-only/)
        expect((await prisma.walletEntry.findUniqueOrThrow({ where: { id: entry.id } })).amountCents).toBe(-1000)
      })

      it('DELETE é bloqueado e a linha continua lá', async () => {
        const entry = await prisma.walletEntry.findFirstOrThrow({ where: { walletId: d.wallet.id, type: 'CHARGE_DEBIT' } })
        await expect(prisma.walletEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/)
        expect(await prisma.walletEntry.count({ where: { id: entry.id } })).toBe(1)
      })

      it('deleteMany em massa também é bloqueado', async () => {
        await expect(prisma.walletEntry.deleteMany({ where: { walletId: d.wallet.id } })).rejects.toThrow(/append-only/)
        expect(await prisma.walletEntry.count({ where: { walletId: d.wallet.id } })).toBeGreaterThanOrEqual(2)
      })
    })
  })

  // ---------------------------------------------------------------------------
  describe('identidade de conciliação com TODOS os meios de pagamento simultâneos', () => {
    let mix: Scope
    const oracle = { revenue: 0, wallet: 0, card: 0, debt: 0 }

    beforeAll(async () => {
      // Operador NOVO só deste describe: os números do relatório saem exatos.
      mix = await scopeFor(await createTenant({ suffix: `${suffix}m`, label: 'mix' }))

      // S1 — carteira cobre tudo: 10 kWh = 1000.
      const d1 = await newDriver('s1', 5_000)
      await runSession(mix, { idTag: d1.idTag, deliveredWh: 10_000 })
      oracle.revenue += 1000
      oracle.wallet += 1000

      // S2 — carteira cobre PARTE: a sessão começou com saldo, mas ele foi gasto até sobrar R$ 12,00; custo 30 kWh = 3000.
      const d2 = await newDriver('s2', 5_000)
      await runSession(mix, { idTag: d2.idTag, deliveredWh: 30_000, beforeStop: () => ajustar(d2.wallet.id, -3_800) })
      oracle.revenue += 3000
      oracle.wallet += 1200
      oracle.debt += 1800

      // S3 — inadimplente TOTAL: saldo zerado antes do stop; custo 5 kWh = 500 vira dívida inteira, sem WalletEntry.
      const d3 = await newDriver('s3', 5_000)
      await runSession(mix, { idTag: d3.idTag, deliveredWh: 5_000, beforeStop: () => ajustar(d3.wallet.id, -5_000) })
      oracle.revenue += 500
      oracle.debt += 500

      // S5 — sessão GRATUITA (0 Wh): nada a cobrar, nada a registrar.
      const d5 = await newDriver('s5', 5_000)
      await runSession(mix, { idTag: d5.idTag, deliveredWh: 0 })

      // S4 — CARTÃO capturado (fixture direto: o fluxo Cielo é a F5): 800 centavos.
      const d4 = await newDriver('s4', 0)
      const cardSession = await stoppedSession(mix, d4, 800)
      await prisma.paymentIntent.create({
        data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: d4.user.id, chargingSessionId: cardSession.id, status: 'CAPTURED', returnCode: '00', amountRequestedCents: 800, amountCapturedCents: 800, capturedAt: minutesAgo(19) },
      })
      oracle.revenue += 800
      oracle.card += 800
    })

    it('o oráculo do teste tem os números esperados (guarda contra fixture quebrado)', () => {
      expect(oracle).toEqual({ revenue: 5300, wallet: 2200, card: 800, debt: 2300 })
    })

    it('cada parcela do relatório bate com a conta feita à mão e differenceCents === 0', async () => {
      const r = await reportFor(adminToken, mix.t.operatorId)
      expect(r.revenueCents).toBe(oracle.revenue)
      expect(r.walletDebitCents).toBe(oracle.wallet)
      expect(r.cardCapturedCents).toBe(oracle.card)
      expect(r.openDebtCents).toBe(oracle.debt)
      expect(r.expectedCents).toBe(oracle.revenue)
      expect(r.accountedCents).toBe(oracle.wallet + oracle.card + oracle.debt)
      expect(r.differenceCents).toBe(0)
    })

    it('a sessão inadimplente total gerou Debt OPEN (100%) SEM WalletEntry, com operatorId derivado da sessão pelo trigger', async () => {
      const debts = await prisma.debt.findMany({ where: { operatorId: mix.t.operatorId }, orderBy: { amountCents: 'asc' } })
      expect(debts.map((x) => x.amountCents)).toEqual([500, 1800])
      expect(debts.every((x) => x.status === 'OPEN' && x.reason === 'INSUFFICIENT_WALLET_BALANCE')).toBe(true)
      const inadimplente = debts[0]
      expect(await prisma.walletEntry.count({ where: { type: 'CHARGE_DEBIT', referenceId: inadimplente.chargingSessionId! } })).toBe(0)
    })

    it('a sessão gratuita não gerou nenhum lançamento nem dívida', async () => {
      const free = await prisma.chargingSession.findFirstOrThrow({ where: { operatorId: mix.t.operatorId, energyDeliveredWh: 0 } })
      expect(free.totalCostCents).toBe(0)
      expect(await prisma.walletEntry.count({ where: { referenceId: free.id } })).toBe(0)
      expect(await prisma.debt.count({ where: { chargingSessionId: free.id } })).toBe(0)
    })

    it('a identidade TEM DENTES: uma sessão faturada sem cartão, sem débito e sem dívida aparece como differenceCents = 999', async () => {
      const leak = await scopeFor(await createTenant({ suffix: `${suffix}l`, label: 'leak' }))
      const leakDriver = await newDriver('leak', 0)
      await stoppedSession(leak, leakDriver, 999)
      const r = await reportFor(adminToken, leak.t.operatorId)
      expect(r).toMatchObject({ revenueCents: 999, accountedCents: 0, differenceCents: 999 })
    })
  })

  // ---------------------------------------------------------------------------
  describe('integridade do razão sob concorrência', () => {
    it('duas sessões do MESMO motorista liquidadas AO MESMO TEMPO com saldo para uma só: FOR UPDATE serializa, o saldo nunca fica negativo e o razão é uma cadeia consistente', async () => {
      const d = await newDriver('serial', 1_500)
      const [s1, s2] = [await stoppedSession(main, d, 1000), await stoppedSession(main, d, 1000)]

      await Promise.all([liquidarSessao(s1.id), liquidarSessao(s2.id)])

      const entries = await prisma.walletEntry.findMany({ where: { walletId: d.wallet.id }, orderBy: { createdAt: 'asc' } })
      const debts = await prisma.debt.findMany({ where: { userId: d.user.id } })
      const debited = entries.filter((e) => e.type === 'CHARGE_DEBIT').reduce((acc, e) => acc - e.amountCents, 0)
      const owed = debts.reduce((acc, x) => acc + x.amountCents, 0)

      // Nenhum centavo se perde nem se duplica: 2000 de custo = 1500 debitado + 500 de dívida.
      expect(debited).toBe(1500)
      expect(owed).toBe(500)
      expect(debited + owed).toBe(2000)
      expect(await saldo(d.wallet.id)).toBe(0)

      // Cadeia do razão: cada balanceAfter = anterior + amount, nunca negativo.
      let running = 0
      for (const e of entries) {
        running += e.amountCents
        expect(e.balanceAfterCents, `entrada ${e.id}`).toBe(running)
        expect(e.balanceAfterCents).toBeGreaterThanOrEqual(0)
      }
    })

    it('uma sessão só pode ter UMA dívida aberta (ux_debt_open_per_session)', async () => {
      const d = await newDriver('debt-once', 0)
      const session = await stoppedSession(main, d, 300)
      await prisma.debt.create({ data: { userId: d.user.id, chargingSessionId: session.id, amountCents: 300, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE' } })
      await expect(prisma.debt.create({ data: { userId: d.user.id, chargingSessionId: session.id, amountCents: 300, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE' } })).rejects.toThrow(
        /ux_debt_open_per_session|Unique constraint/i,
      )
    })
  })
})
