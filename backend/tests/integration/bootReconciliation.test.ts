import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { reconciliarSessoesOrfas } from '../../src/ocpp/handlers/bootNotification'
import type { OcppHandlerCtx } from '../../src/ocpp/context'

/**
 * Gap encontrado na primeira sessão de recarga real testada de ponta a ponta
 * (2026-09-17, ver PROGRESSO.md): `RemoteStopTransaction` foi aceito pelo
 * carregador, mas ele desconectou/reconectou em vez de completar o
 * `StopTransaction` — a `ChargingSession` ficou travada em STARTED pra
 * sempre, carteira nunca debitada. Este teste cobre a reconciliação que
 * fecha esse gap: ao reconectar (BootNotification), toda sessão aberta
 * daquele charge point é fechada com a última `MeterSample` conhecida.
 */
describe('Reconciliação de sessão órfã no BootNotification', () => {
  const suffix = randomUUID().slice(0, 8)
  const startedAt = new Date('2026-09-17T10:00:00Z')

  let operator: { id: string }
  let site: { id: string }
  let chargePoint: { id: string }
  let connectorComAmostra: { id: string }
  let connectorSemAmostra: { id: string }
  let tariff: { id: string }
  let ctx: OcppHandlerCtx

  const sessionIds: string[] = []

  const tariffSnapshot: Prisma.InputJsonValue = {
    id: 'tariff-snapshot',
    model: 'PER_KWH',
    pricePerKwh: '1.00', // R$1,00/kWh — deixa a conta redonda de propósito
    pricePerMinute: null,
    sessionFeeCents: null,
    minChargeCents: null,
    idleFeePerMinute: 0,
    idleGracePeriodSeconds: 0,
    windows: [],
  }

  function makeIdTag(): string {
    return `T${randomUUID().replace(/-/g, '')}`.slice(0, 20)
  }

  beforeAll(async () => {
    operator = await prisma.operator.create({ data: { name: `Operador Boot ${suffix}`, email: `operador-boot-${suffix}@example.com` } })
    site = await prisma.site.create({
      data: { operatorId: operator.id, name: `Site Boot ${suffix}`, addressLine: 'Rua Boot', city: 'São Paulo', state: 'SP', postalCode: '00000-000', latitude: -23.5, longitude: -46.6 },
    })
    chargePoint = await prisma.chargePoint.create({
      data: { operatorId: operator.id, siteId: site.id, ocppIdentity: `cp-boot-${suffix}`, basicAuthSecretHash: 'x' },
    })
    connectorComAmostra = await prisma.connector.create({ data: { operatorId: operator.id, chargePointId: chargePoint.id, connectorId: 1, type: 'AC_TYPE2' } })
    connectorSemAmostra = await prisma.connector.create({ data: { operatorId: operator.id, chargePointId: chargePoint.id, connectorId: 2, type: 'AC_TYPE2' } })
    tariff = await prisma.tariff.create({ data: { operatorId: operator.id, name: `Tarifa Boot ${suffix}`, model: 'PER_KWH', pricePerKwh: '1.00' } })

    ctx = { chargePointId: chargePoint.id, operatorId: operator.id, ocppIdentity: chargePoint.ocppIdentity }
  })

  afterAll(async () => {
    // WalletEntry é append-only (trigger no banco) — a cadeia de FK Restrict
    // sobe até Wallet/User/Operator, então (mesmo padrão de
    // paymentsReconciliation.test.ts) esses não são removidos aqui.
    await prisma.meterSample.deleteMany({ where: { chargePointId: chargePoint.id } })
    await prisma.chargingSession.deleteMany({ where: { id: { in: sessionIds } } })
    await prisma.connector.deleteMany({ where: { id: { in: [connectorComAmostra.id, connectorSemAmostra.id] } } })
    await prisma.chargePoint.deleteMany({ where: { id: chargePoint.id } })
    await prisma.site.deleteMany({ where: { id: site.id } })
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('sessão com MeterSample: fecha com a última leitura, calcula custo real e debita a carteira', async () => {
    const driver = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista Com Amostra ${suffix}`, email: `driver-sample-${suffix}@example.com` } })
    const authToken = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driver.id } })
    const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
    await prisma.walletEntry.create({
      data: { walletId: wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: 1000, balanceAfterCents: 1000, referenceType: 'MANUAL', description: 'Saldo inicial de teste' },
    })

    const session = await prisma.chargingSession.create({
      data: {
        operatorId: operator.id,
        siteId: site.id,
        chargePointId: chargePoint.id,
        connectorId: connectorComAmostra.id,
        authTokenId: authToken.id,
        userId: driver.id,
        status: 'STARTED',
        meterStartWh: 0,
        startedAt,
        tariffId: tariff.id,
        tariffSnapshot,
      },
    })
    sessionIds.push(session.id)

    // Duas amostras — a reconciliação precisa pegar a ÚLTIMA (maior ts), não
    // a primeira nem a de maior valor por acaso.
    await prisma.meterSample.create({
      data: {
        sessionId: session.id,
        chargePointId: chargePoint.id,
        operatorId: operator.id,
        ts: new Date(startedAt.getTime() + 5 * 60_000),
        measurand: 'Energy.Active.Import.Register',
        value: 2000,
        unit: 'Wh',
        context: 'Sample.Periodic',
      },
    })
    await prisma.meterSample.create({
      data: {
        sessionId: session.id,
        chargePointId: chargePoint.id,
        operatorId: operator.id,
        ts: new Date(startedAt.getTime() + 10 * 60_000),
        measurand: 'Energy.Active.Import.Register',
        value: 5000, // Wh — energia entregue = 5000 Wh = R$5,00 a R$1,00/kWh
        unit: 'Wh',
        context: 'Sample.Periodic',
      },
    })

    await reconciliarSessoesOrfas(ctx)

    const reconciled = await prisma.chargingSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(reconciled.status).toBe('STOPPED')
    expect(reconciled.meterStopWh).toBe(5000)
    expect(reconciled.energyDeliveredWh).toBe(5000)
    expect(reconciled.stopReason).toBe('OTHER')
    expect(reconciled.totalCostCents).toBe(500)
    expect(reconciled.stoppedAt?.toISOString()).toBe(new Date(startedAt.getTime() + 10 * 60_000).toISOString())

    const walletEntry = await prisma.walletEntry.findFirst({ where: { type: 'CHARGE_DEBIT', referenceType: 'CHARGING_SESSION', referenceId: session.id } })
    expect(walletEntry).not.toBeNull()
    expect(walletEntry?.amountCents).toBe(-500)
    expect(walletEntry?.balanceAfterCents).toBe(500)
  })

  it('sessão SEM nenhuma MeterSample: fecha com energia zero, sem lançar exceção', async () => {
    const driver = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista Sem Amostra ${suffix}`, email: `driver-no-sample-${suffix}@example.com` } })
    const authToken = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driver.id } })
    await prisma.wallet.create({ data: { userId: driver.id } })

    const session = await prisma.chargingSession.create({
      data: {
        operatorId: operator.id,
        siteId: site.id,
        chargePointId: chargePoint.id,
        connectorId: connectorSemAmostra.id,
        authTokenId: authToken.id,
        userId: driver.id,
        status: 'STARTED',
        meterStartWh: 1234,
        startedAt,
        tariffId: tariff.id,
        tariffSnapshot,
      },
    })
    sessionIds.push(session.id)

    await expect(reconciliarSessoesOrfas(ctx)).resolves.not.toThrow()

    const reconciled = await prisma.chargingSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(reconciled.status).toBe('STOPPED')
    expect(reconciled.meterStopWh).toBe(1234) // = meterStartWh, energia entregue = 0
    expect(reconciled.energyDeliveredWh).toBe(0)
    expect(reconciled.totalCostCents).toBe(0)
    expect(reconciled.stoppedAt?.toISOString()).toBe(startedAt.toISOString())

    const walletEntry = await prisma.walletEntry.findFirst({ where: { type: 'CHARGE_DEBIT', referenceType: 'CHARGING_SESSION', referenceId: session.id } })
    expect(walletEntry).toBeNull() // custo zero -> `debitarSessao` não cria entrada nenhuma
  })

  it('sessão já STOPPED não é reconciliada de novo (idempotência)', async () => {
    // Chama de novo depois que as duas sessões acima já foram fechadas —
    // não deve sobrar nenhuma sessão aberta para este charge point, então a
    // segunda chamada não deve alterar nada nem lançar.
    await expect(reconciliarSessoesOrfas(ctx)).resolves.not.toThrow()

    const stillOpen = await prisma.chargingSession.count({
      where: { chargePointId: chargePoint.id, status: { in: ['STARTED', 'CHARGING', 'FINISHING'] } },
    })
    expect(stillOpen).toBe(0)
  })
})
