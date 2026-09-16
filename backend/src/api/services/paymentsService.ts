import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import type { ReportingScope } from '../lib/reportingScope'
import type { PeriodWindow } from '../lib/reportingWindow'
import { periodConditions, tenantConditions, toNumber, whereSql } from '../lib/reportingSql'

export interface PaymentsSummary {
  revenueCents: number
  cardCapturedCents: number
  walletDebitedCents: number
  // Rede inteira, NUNCA escopado por operador — WALLET_TOPUP_PIX não tem
  // operatorId no schema (a carteira é do motorista, não de um operador).
  // Por isso omitidos para role OPERATOR (ver `getPaymentsSummary`), não faz
  // sentido "fatiar" um número que estruturalmente não pertence a ninguém.
  walletTopupCents?: number
  walletFloatCents?: number
  openDebtCents: number
  refundedCents: number
  failedCaptureCount: number
  deniedAuthCount: number
  expiredPixCount?: number
  reconciliation: {
    expectedCents: number
    accountedCents: number
    differenceCents: number
  }
}

async function scalarFloat(sql: Prisma.Sql, field: string): Promise<number> {
  const rows = await prisma.$queryRaw<Record<string, number>[]>(sql)
  return Math.round(toNumber(rows[0]?.[field]))
}

async function scalarInt(sql: Prisma.Sql, field: string): Promise<number> {
  const rows = await prisma.$queryRaw<Record<string, number>[]>(sql)
  return toNumber(rows[0]?.[field])
}

export async function getPaymentsSummary(scope: ReportingScope, window: PeriodWindow, isAdmin: boolean): Promise<PaymentsSummary> {
  const sessionWhere = whereSql([...tenantConditions(scope, 'cs'), ...periodConditions('cs', window.from, window.to)])
  const stoppedSessionWhere = whereSql([Prisma.sql`cs.status = 'STOPPED'`, ...tenantConditions(scope, 'cs'), ...periodConditions('cs', window.from, window.to)])

  const [revenueCents, cardCapturedCents, walletDebitedCents, openDebtCents, refundedCents, failedCaptureCount, deniedAuthCount] = await Promise.all([
    scalarFloat(Prisma.sql`SELECT COALESCE(SUM(cs."totalCostCents"), 0)::float8 AS "v" FROM "ChargingSession" cs WHERE ${stoppedSessionWhere}`, 'v'),
    scalarFloat(
      Prisma.sql`
        SELECT COALESCE(SUM(pi."amountCapturedCents"), 0)::float8 AS "v"
        FROM "PaymentIntent" pi JOIN "ChargingSession" cs ON cs.id = pi."chargingSessionId"
        WHERE pi.purpose = 'SESSION_CARD_CAPTURE' AND pi.status = 'CAPTURED' AND ${sessionWhere}
      `,
      'v',
    ),
    scalarFloat(
      Prisma.sql`
        SELECT COALESCE(SUM(-we."amountCents"), 0)::float8 AS "v"
        FROM "WalletEntry" we JOIN "ChargingSession" cs ON cs.id = we."referenceId"
        WHERE we.type = 'CHARGE_DEBIT' AND we."referenceType" = 'CHARGING_SESSION' AND ${sessionWhere}
      `,
      'v',
    ),
    // Dívida aberta ligada a sessão do período/escopo — dívida sem
    // chargingSessionId não corresponde a nenhum totalCostCents somado em
    // revenueCents, então fica fora da identidade de conciliação de propósito.
    scalarFloat(
      Prisma.sql`
        SELECT COALESCE(SUM(d."amountCents"), 0)::float8 AS "v"
        FROM "Debt" d JOIN "ChargingSession" cs ON cs.id = d."chargingSessionId"
        WHERE d.status = 'OPEN' AND ${sessionWhere}
      `,
      'v',
    ),
    // Estorno ligado a sessão (crédito de carteira tipo REFUND referenciando
    // a sessão). Estorno de recarga de carteira (TOPUP_REFUND) não é
    // ligado a sessão — mesma razão de walletTopupCents, fica de fora aqui.
    scalarFloat(
      Prisma.sql`
        SELECT COALESCE(SUM(we."amountCents"), 0)::float8 AS "v"
        FROM "WalletEntry" we JOIN "ChargingSession" cs ON cs.id = we."referenceId"
        WHERE we.type = 'REFUND' AND we."referenceType" = 'CHARGING_SESSION' AND ${sessionWhere}
      `,
      'v',
    ),
    scalarInt(
      Prisma.sql`
        SELECT COUNT(*)::int AS "v"
        FROM "PaymentIntent" pi JOIN "ChargingSession" cs ON cs.id = pi."chargingSessionId"
        WHERE pi.purpose = 'SESSION_CARD_CAPTURE' AND pi.status = 'FAILED' AND ${sessionWhere}
      `,
      'v',
    ),
    scalarInt(
      Prisma.sql`
        SELECT COUNT(*)::int AS "v"
        FROM "PaymentIntent" pi JOIN "ChargingSession" cs ON cs.id = pi."chargingSessionId"
        WHERE pi.purpose = 'SESSION_CARD_CAPTURE' AND pi.status = 'DENIED' AND ${sessionWhere}
      `,
      'v',
    ),
  ])

  const expectedCents = revenueCents
  const accountedCents = cardCapturedCents + walletDebitedCents + openDebtCents
  const differenceCents = expectedCents - accountedCents

  const summary: PaymentsSummary = {
    revenueCents,
    cardCapturedCents,
    walletDebitedCents,
    openDebtCents,
    refundedCents,
    failedCaptureCount,
    deniedAuthCount,
    reconciliation: { expectedCents, accountedCents, differenceCents },
  }

  if (isAdmin) {
    const [walletTopupCents, walletFloatCents, expiredPixCount] = await Promise.all([
      scalarFloat(
        Prisma.sql`SELECT COALESCE(SUM("amountCents"), 0)::float8 AS "v" FROM "WalletEntry" WHERE type = 'TOPUP_PIX' AND "createdAt" >= ${window.from} AND "createdAt" < ${window.to}`,
        'v',
      ),
      // Float atual da carteira da rede = soma do ÚLTIMO balanceAfterCents de
      // cada wallet (snapshot pós-entrada) — não é escopado por período
      // (é uma foto do saldo AGORA, não um total do intervalo).
      scalarFloat(
        Prisma.sql`
          SELECT COALESCE(SUM(latest."balanceAfterCents"), 0)::float8 AS "v"
          FROM (
            SELECT DISTINCT ON ("walletId") "walletId", "balanceAfterCents"
            FROM "WalletEntry"
            ORDER BY "walletId", "createdAt" DESC
          ) latest
        `,
        'v',
      ),
      scalarInt(
        Prisma.sql`SELECT COUNT(*)::int AS "v" FROM "PaymentIntent" WHERE purpose = 'WALLET_TOPUP_PIX' AND status = 'EXPIRED' AND "createdAt" >= ${window.from} AND "createdAt" < ${window.to}`,
        'v',
      ),
    ])
    summary.walletTopupCents = walletTopupCents
    summary.walletFloatCents = walletFloatCents
    summary.expiredPixCount = expiredPixCount
  }

  return summary
}
