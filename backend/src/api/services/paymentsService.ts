import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import type { ReportingScope } from '../lib/reportingScope'
import type { PeriodWindow } from '../lib/reportingWindow'
import { periodConditions, tenantConditions, toNumber, whereSql } from '../lib/reportingSql'
import type { PaymentsReportQuery } from '../schemas/reporting.schema'

/**
 * Identidade de conciliação (regra 6 da Nova, ver memória de retaguarda):
 * `expectedCents` (= faturamento) DEVE bater com `accountedCents` (=
 * capturas de cartão + débitos de carteira + dívida aberta). NUNCA
 * ajustado — `differenceCents !== 0` é bug real, exposto no número.
 */
export interface PaymentsReconciliation {
  revenueCents: number
  cardCapturedCents: number
  walletDebitCents: number
  /** Rede inteira, NUNCA escopado por operador — `WALLET_TOPUP_PIX` não tem operatorId no schema. `null` para OPERATOR. */
  walletTopupPixCents: number | null
  openDebtCents: number
  /** Informativo — NÃO entra em `accountedCents`. Ver `fetchFailedAttemptsCents`. */
  failedAttemptsCents: number
  expectedCents: number
  accountedCents: number
  differenceCents: number
}

async function scalarFloat(sql: Prisma.Sql, field: string): Promise<number> {
  const rows = await prisma.$queryRaw<Record<string, number>[]>(sql)
  return Math.round(toNumber(rows[0]?.[field]))
}

export async function getPaymentsReconciliation(scope: ReportingScope, window: PeriodWindow, isAdmin: boolean): Promise<PaymentsReconciliation> {
  const sessionWhere = whereSql([...tenantConditions(scope, 'cs'), ...periodConditions('cs', window.from, window.to)])
  const stoppedSessionWhere = whereSql([Prisma.sql`cs.status = 'STOPPED'`, ...tenantConditions(scope, 'cs'), ...periodConditions('cs', window.from, window.to)])

  const [revenueCents, cardCapturedCents, walletDebitCents, openDebtCents, failedAttemptsCents] = await Promise.all([
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
    // failedAttemptsCents = soma de amountRequestedCents de tentativas de
    // captura de cartão que NÃO deram certo (DENIED/FAILED/CANCELLED/
    // VOIDED/EXPIRED) + valor estornado (WalletEntry REFUND ligado a
    // sessão) no período/escopo. É só INFORMATIVO (quanto dinheiro "não
    // entrou de primeira" ou voltou) — nunca soma em accountedCents, senão
    // quebraria a identidade expectedCents === accountedCents.
    (async () => {
      const [failedRequestedCents, refundedCents] = await Promise.all([
        scalarFloat(
          Prisma.sql`
            SELECT COALESCE(SUM(pi."amountRequestedCents"), 0)::float8 AS "v"
            FROM "PaymentIntent" pi JOIN "ChargingSession" cs ON cs.id = pi."chargingSessionId"
            WHERE pi.purpose = 'SESSION_CARD_CAPTURE' AND pi.status IN ('DENIED', 'FAILED', 'CANCELLED', 'VOIDED', 'EXPIRED') AND ${sessionWhere}
          `,
          'v',
        ),
        scalarFloat(
          Prisma.sql`
            SELECT COALESCE(SUM(we."amountCents"), 0)::float8 AS "v"
            FROM "WalletEntry" we JOIN "ChargingSession" cs ON cs.id = we."referenceId"
            WHERE we.type = 'REFUND' AND we."referenceType" = 'CHARGING_SESSION' AND ${sessionWhere}
          `,
          'v',
        ),
      ])
      return failedRequestedCents + refundedCents
    })(),
  ])

  const expectedCents = revenueCents
  const accountedCents = cardCapturedCents + walletDebitCents + openDebtCents
  const differenceCents = expectedCents - accountedCents

  let walletTopupPixCents: number | null = null
  if (isAdmin) {
    // Float Pix da REDE — não escopado por operador (WALLET_TOPUP_PIX não
    // tem operatorId no schema, a carteira é do motorista, não de um
    // operador). Ver [[innoelektron-retaguarda-relatorios-api]].
    walletTopupPixCents = await scalarFloat(
      Prisma.sql`SELECT COALESCE(SUM("amountCents"), 0)::float8 AS "v" FROM "WalletEntry" WHERE type = 'TOPUP_PIX' AND "createdAt" >= ${window.from} AND "createdAt" < ${window.to}`,
      'v',
    )
  }

  return {
    revenueCents,
    cardCapturedCents,
    walletDebitCents,
    walletTopupPixCents,
    openDebtCents,
    failedAttemptsCents,
    expectedCents,
    accountedCents,
    differenceCents,
  }
}

// ------------------------------------------------------------
// GET /api/admin/reports/payments — items: listagem paginada de
// PaymentIntent (funcionalidade nova, não existia antes desta rodada).
// ------------------------------------------------------------

export interface PaymentListRow {
  id: string
  purpose: string
  provider: string
  status: string
  amountRequestedCents: number
  amountCapturedCents: number | null
  userName: string
  chargingSessionId: string | null
  siteId: string | null
  siteName: string | null
  createdAt: Date
}

/**
 * Escopo multi-tenant de PaymentIntent: `operatorId` é coluna própria
 * (nula em WALLET_TOPUP_PIX, que não pertence a nenhum operador — some da
 * listagem quando o escopo tem operatorId, propositalmente). `siteId`/
 * `chargePointId` do escopo não existem em PaymentIntent — vêm via join
 * com ChargingSession (LEFT, porque recarga de carteira não tem sessão).
 */
function paymentIntentTenantConditions(scope: ReportingScope): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = []
  if (scope.operatorId) conditions.push(Prisma.sql`pi."operatorId" = ${scope.operatorId}`)
  if (scope.siteId) conditions.push(Prisma.sql`cs."siteId" = ${scope.siteId}`)
  if (scope.chargePointId) conditions.push(Prisma.sql`cs."chargePointId" = ${scope.chargePointId}`)
  return conditions
}

function paymentsFilterConditions(filters: Pick<PaymentsReportQuery, 'provider' | 'status'>): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = []
  if (filters.provider) conditions.push(Prisma.sql`pi.provider = ${filters.provider}`)
  if (filters.status) conditions.push(Prisma.sql`pi.status = ${filters.status}`)
  return conditions
}

const PAYMENTS_FROM = Prisma.sql`
  FROM "PaymentIntent" pi
  JOIN "User" u ON u.id = pi."userId"
  LEFT JOIN "ChargingSession" cs ON cs.id = pi."chargingSessionId"
  LEFT JOIN "Site" s ON s.id = cs."siteId"
`

export async function getPaymentsReportPage(
  scope: ReportingScope,
  window: PeriodWindow,
  filters: Pick<PaymentsReportQuery, 'provider' | 'status'>,
  page: number,
  pageSize: number,
): Promise<{ items: PaymentListRow[]; total: number }> {
  // PaymentIntent não tem `startedAt` (regra da sessão) — o período aqui
  // ancora em `pi."createdAt"` (quando a TENTATIVA de pagamento foi criada),
  // única data que toda linha (inclusive recarga de carteira sem sessão) tem.
  const where = whereSql([
    Prisma.sql`pi."createdAt" >= ${window.from}`,
    Prisma.sql`pi."createdAt" < ${window.to}`,
    ...paymentIntentTenantConditions(scope),
    ...paymentsFilterConditions(filters),
  ])

  const [items, countRows] = await Promise.all([
    prisma.$queryRaw<PaymentListRow[]>(Prisma.sql`
      SELECT pi.id AS "id", pi.purpose AS "purpose", pi.provider AS "provider", pi.status AS "status",
        pi."amountRequestedCents" AS "amountRequestedCents", pi."amountCapturedCents" AS "amountCapturedCents",
        u.name AS "userName", pi."chargingSessionId" AS "chargingSessionId",
        cs."siteId" AS "siteId", s.name AS "siteName", pi."createdAt" AS "createdAt"
      ${PAYMENTS_FROM}
      WHERE ${where}
      ORDER BY pi."createdAt" DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `),
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS "total" ${PAYMENTS_FROM} WHERE ${where}`),
  ])

  return { items, total: toNumber(countRows[0]?.total) }
}
