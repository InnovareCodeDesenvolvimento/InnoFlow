import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../../src/lib/prisma'
import { encryptPaymentSecret } from '../../../src/lib/crypto/paymentSecrets'
import { createTenant, createUser, type TestTenant, type TestUser } from './fixtures'
import { HASH_SENHA_ADMIN_TESTE } from './senhaAdmin'

/**
 * Fixtures do estorno/chargeback (L1.8): sessão ENCERRADA (STOPPED) já cobrada, paga com carteira ou com cartão, direto no banco (sem OCPP). Tudo leva o `suffix`
 * do arquivo (as suítes rodam em paralelo no MESMO Postgres — só afirmar sobre os ids criados aqui).
 */

export interface CenarioEstorno {
  tenant: TestTenant
  admin: TestUser
  driver: TestUser
  walletId: string
  sessionId: string
  /** Venda de cartão CAPTURED (só em `paga: 'CARD'`). */
  intentId: string | null
  totalCents: number
}

export interface OpcoesCenarioEstorno {
  paga?: 'WALLET' | 'CARD' | 'NENHUMA'
  totalCents?: number
  /** Saldo da carteira ANTES do débito da sessão. */
  saldoInicialCents?: number
  status?: 'STOPPED' | 'STARTED'
  totalNulo?: boolean
  googleSub?: string | null
  tenant?: TestTenant
  admin?: TestUser
}

const SNAPSHOT: Prisma.InputJsonValue = { id: 'snap', model: 'PER_KWH', pricePerKwh: '1.00', windows: [] }

export async function criarAdminComSenha(suffix: string, label: string): Promise<TestUser> {
  return createUser({ role: 'ADMIN', label: `admin-${label}`, suffix, passwordHash: HASH_SENHA_ADMIN_TESTE })
}

export async function criarCenarioEstorno(suffix: string, label: string, opcoes: OpcoesCenarioEstorno = {}): Promise<CenarioEstorno> {
  const paga = opcoes.paga ?? 'WALLET'
  const totalCents = opcoes.totalCents ?? 1000
  const tenant = opcoes.tenant ?? (await createTenant({ suffix, label }))
  const admin = opcoes.admin ?? (await criarAdminComSenha(suffix, label))
  const driver = await createUser({ role: 'DRIVER', label: `driver-${label}`, suffix })
  if (opcoes.googleSub !== undefined) await prisma.user.update({ where: { id: driver.id }, data: { googleSub: opcoes.googleSub } })
  const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
  const token = await prisma.authToken.create({ data: { idTag: `V${randomUUID().replace(/-/g, '')}`.slice(0, 20), type: 'VIRTUAL', userId: driver.id, status: 'ACCEPTED' } })
  const connector = await prisma.connector.findFirstOrThrow({ where: { chargePointId: tenant.chargePointId } })

  const sessao = await prisma.chargingSession.create({
    data: {
      operatorId: tenant.operatorId,
      siteId: tenant.siteId,
      chargePointId: tenant.chargePointId,
      connectorId: connector.id,
      authTokenId: token.id,
      userId: driver.id,
      tariffId: tenant.tariffId,
      tariffSnapshot: SNAPSHOT,
      meterStartWh: 0,
      meterStopWh: 10_000,
      energyDeliveredWh: 10_000,
      startedAt: new Date(Date.now() - 3600_000),
      stoppedAt: opcoes.status === 'STARTED' ? null : new Date(),
      status: opcoes.status ?? 'STOPPED',
      paymentMode: paga === 'CARD' ? 'CARD' : 'WALLET',
      totalCostCents: opcoes.totalNulo ? null : totalCents,
    },
  })

  let intentId: string | null = null
  if (paga === 'WALLET') {
    const saldoInicial = opcoes.saldoInicialCents ?? totalCents
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'TOPUP_PIX', amountCents: saldoInicial, balanceAfterCents: saldoInicial, createdAt: new Date(Date.now() - 10_000) } })
    await prisma.walletEntry.create({
      data: { walletId: wallet.id, type: 'CHARGE_DEBIT', amountCents: -totalCents, balanceAfterCents: saldoInicial - totalCents, referenceType: 'CHARGING_SESSION', referenceId: sessao.id, description: 'Recarga de teste', createdAt: new Date(Date.now() - 5_000) },
    })
  } else if (paga === 'CARD') {
    const metodo = await prisma.paymentMethod.create({
      data: { userId: driver.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(`tok-${label}-${suffix}`), brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2030, holderName: `Titular ${label} ${suffix}`, isDefault: true },
    })
    const intent = await prisma.paymentIntent.create({
      data: {
        purpose: 'SESSION_CARD_CAPTURE',
        provider: 'CIELO_CARD',
        userId: driver.id,
        chargingSessionId: sessao.id,
        paymentMethodId: metodo.id,
        status: 'CAPTURED',
        returnCode: '00',
        cieloPaymentId: `pay-${randomUUID()}`,
        cieloTid: `tid${randomUUID().slice(0, 12)}`,
        cieloAuthorizationCode: '123456',
        cieloProofOfSale: `nsu${randomUUID().slice(0, 10)}`,
        amountRequestedCents: totalCents,
        amountAuthorizedCents: totalCents,
        amountCapturedCents: totalCents,
        authorizedAt: new Date(Date.now() - 3500_000),
        capturedAt: new Date(Date.now() - 60_000),
        environment: 'SANDBOX',
      },
    })
    intentId = intent.id
  }

  return { tenant, admin, driver, walletId: wallet.id, sessionId: sessao.id, intentId, totalCents }
}

export async function saldoDaCarteira(walletId: string): Promise<number> {
  const ultima = await prisma.walletEntry.findFirst({ where: { walletId }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
  return ultima?.balanceAfterCents ?? 0
}
