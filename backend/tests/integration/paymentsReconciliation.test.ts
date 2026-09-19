import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Prisma } from '@prisma/client'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { issueToken } from '../../src/lib/jwt'

/**
 * Achado da Íris (auditoria de QA, 2026-09-17): a identidade de conciliação
 * financeira (`paymentsService.ts`: `revenue === cardCaptured + walletDebit +
 * openDebt`) só tinha sido testada manualmente contra o caso trivial "zero a
 * zero" (dado sintético do seed) — nunca um cenário combinando os TRÊS meios
 * de pagamento simultaneamente na mesma janela. Este teste cobre o cenário
 * real: uma sessão paga no cartão, outra debitada da carteira, outra
 * inadimplente (virou `Debt`) — `differenceCents` tem que fechar em zero.
 *
 * NOTA para quem reexecutar isto localmente (fora do CI, que sobe um
 * Postgres efêmero por job): `WalletEntry` é append-only por trigger
 * (`UPDATE`/`DELETE` bloqueados no banco, de propósito — ver schema.prisma).
 * `Debt`/`WalletEntry`/`Wallet`/`User`(motorista)/`Operator` deste fixture
 * NÃO são removidos no `afterAll` por causa disso (a cadeia de FK Restrict
 * sobe até eles) — nomes únicos (`suffix`) evitam colisão entre execuções.
 */
describe('Conciliação financeira (cartão + carteira + dívida simultâneos)', () => {
  const app = createApp()
  const suffix = randomUUID().slice(0, 8)
  const now = new Date()

  let operator: { id: string }
  let site: { id: string }
  let chargePoint: { id: string }
  let connector: { id: string }
  let adminToken: string

  const sessionIds: string[] = []
  const paymentIntentIds: string[] = []

  function makeIdTag(): string {
    return `T${randomUUID().replace(/-/g, '')}`.slice(0, 20)
  }

  beforeAll(async () => {
    operator = await prisma.operator.create({ data: { name: `Operador Reconc ${suffix}`, email: `reconc-${suffix}@example.com` } })
    site = await prisma.site.create({
      data: { operatorId: operator.id, name: `Site Reconc ${suffix}`, addressLine: 'Rua Reconc', city: 'São Paulo', state: 'SP', postalCode: '00000-000', latitude: -23.5, longitude: -46.6 },
    })
    chargePoint = await prisma.chargePoint.create({ data: { operatorId: operator.id, siteId: site.id, ocppIdentity: `cp-reconc-${suffix}`, basicAuthSecretHash: 'x' } })
    connector = await prisma.connector.create({ data: { operatorId: operator.id, chargePointId: chargePoint.id, connectorId: 1, type: 'AC_TYPE2' } })
    const tariff = await prisma.tariff.create({ data: { operatorId: operator.id, name: `Tarifa Reconc ${suffix}`, model: 'PER_KWH', pricePerKwh: '1.00' } })

    const admin = await prisma.user.create({ data: { role: 'ADMIN', name: `Admin Reconc ${suffix}`, email: `admin-reconc-${suffix}@example.com` } })
    adminToken = issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })

    const driverCard = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista Cartao ${suffix}`, email: `driver-card-${suffix}@example.com` } })
    const driverWallet = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista Carteira ${suffix}`, email: `driver-wallet-${suffix}@example.com` } })
    const driverDebt = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista Devendo ${suffix}`, email: `driver-debt-${suffix}@example.com` } })

    const tokenCard = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driverCard.id } })
    const tokenWallet = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driverWallet.id } })
    const tokenDebt = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driverDebt.id } })

    const baseSessionData = {
      operatorId: operator.id,
      siteId: site.id,
      chargePointId: chargePoint.id,
      connectorId: connector.id,
      status: 'STOPPED' as const,
      meterStartWh: 0,
      startedAt: now,
      stoppedAt: now,
      tariffId: tariff.id,
      tariffSnapshot: {} as Prisma.InputJsonValue,
      energyCostCents: 0,
      timeCostCents: 0,
      idleFeeCents: 0,
      sessionFeeCents: 0,
      minChargeAdjustmentCents: 0,
    }

    // Sessão 1 — paga no CARTÃO (R$ 10,00).
    const sessionCard = await prisma.chargingSession.create({
      data: { ...baseSessionData, authTokenId: tokenCard.id, userId: driverCard.id, meterStopWh: 10_000, energyDeliveredWh: 10_000, totalCostCents: 1000 },
    })
    const paymentIntent = await prisma.paymentIntent.create({
      data: {
        operatorId: operator.id,
        purpose: 'SESSION_CARD_CAPTURE',
        provider: 'CIELO_CARD',
        userId: driverCard.id,
        chargingSessionId: sessionCard.id,
        status: 'CAPTURED',
        // CHECK `payment_intent_return_code_required` (migration
        // 20260917130000): cartão AUTHORIZED/CAPTURED exige o ReturnCode da
        // Cielo ('00' = aprovado). Este fixture nasceu antes da constraint e
        // nunca tinha rodado contra um Postgres real — a 1ª execução real
        // (2026-09-19) falhou aqui, não na conciliação.
        returnCode: '00',
        amountRequestedCents: 1000,
        amountCapturedCents: 1000,
        capturedAt: now,
      },
    })

    // Sessão 2 — debitada da CARTEIRA (R$ 20,00).
    const sessionWallet = await prisma.chargingSession.create({
      data: { ...baseSessionData, authTokenId: tokenWallet.id, userId: driverWallet.id, meterStopWh: 20_000, energyDeliveredWh: 20_000, totalCostCents: 2000 },
    })
    const wallet = await prisma.wallet.create({ data: { userId: driverWallet.id } })
    await prisma.walletEntry.create({
      data: {
        walletId: wallet.id,
        type: 'CHARGE_DEBIT',
        amountCents: -2000,
        balanceAfterCents: 0,
        referenceType: 'CHARGING_SESSION',
        referenceId: sessionWallet.id,
        description: `Recarga ${sessionWallet.ocppTransactionId} — ${site.name}`,
      },
    })

    // Sessão 3 — inadimplente, virou DÍVIDA aberta (R$ 15,00).
    const sessionDebt = await prisma.chargingSession.create({
      data: { ...baseSessionData, authTokenId: tokenDebt.id, userId: driverDebt.id, meterStopWh: 15_000, energyDeliveredWh: 15_000, totalCostCents: 1500 },
    })
    await prisma.debt.create({
      data: { userId: driverDebt.id, operatorId: operator.id, chargingSessionId: sessionDebt.id, amountCents: 1500, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE' },
    })

    sessionIds.push(sessionCard.id, sessionWallet.id, sessionDebt.id)
    paymentIntentIds.push(paymentIntent.id)
  })

  afterAll(async () => {
    // Ver nota no cabeçalho — só o que NÃO esbarra na cadeia append-only é
    // removido aqui.
    await prisma.paymentIntent.deleteMany({ where: { id: { in: paymentIntentIds } } })
    await prisma.chargingSession.deleteMany({ where: { id: { in: sessionIds } } })
    await prisma.connector.deleteMany({ where: { id: connector.id } })
    await prisma.chargePoint.deleteMany({ where: { id: chargePoint.id } })
    await prisma.site.deleteMany({ where: { id: site.id } })
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('revenueCents = cardCaptured + walletDebit + openDebt, differenceCents === 0', async () => {
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const to = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const res = await request(app)
      .get('/api/admin/reports/payments')
      .query({ from, to, operatorId: operator.id, pageSize: 100 })
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    const { reconciliation } = res.body

    expect(reconciliation.revenueCents).toBe(4500)
    expect(reconciliation.cardCapturedCents).toBe(1000)
    expect(reconciliation.walletDebitCents).toBe(2000)
    expect(reconciliation.openDebtCents).toBe(1500)
    expect(reconciliation.expectedCents).toBe(4500)
    expect(reconciliation.accountedCents).toBe(4500)
    expect(reconciliation.differenceCents).toBe(0)
  })
})
