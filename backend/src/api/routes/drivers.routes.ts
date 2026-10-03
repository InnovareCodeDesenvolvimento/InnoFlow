import { Router } from 'express'
import { sqlEstadosSessaoAberta } from '../lib/sessionStatusSql'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { toNumber } from '../lib/reportingSql'
import { escapeLike } from '../lib/sqlLike'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { auditCtx } from '../middleware/auditTrail'
import { requireOperatorOrAdmin } from '../middleware/tenantScope'
import { validateBody, validateQuery } from '../middleware/validate'
import {
  driversListQuerySchema,
  driverWalletQuerySchema,
  walletAdjustmentSchema,
  type DriversListQuery,
  type DriverWalletQuery,
  type WalletAdjustmentInput,
} from '../schemas/driver.schema'
import { ajustarCarteiraTransacional, SaldoInsuficienteError } from '../../services/carteira/walletLedger'

/**
 * Motorista é conta de rede (não pertence a um `operatorId`) — ver PROGRESSO.md
 * §Decisões em aberto item 9. Por isso NÃO há filtro `operatorId` nas queries
 * abaixo (não existe coluna para filtrar): o isolamento multi-tenant aqui é
 * outro — `search` OBRIGATÓRIO (>= 3 chars) para OPERATOR, para impedir que
 * ele baixe a base inteira de motoristas da rede, só ache o que está no
 * poste dele agora. ADMIN lista tudo sem essa exigência.
 */
const MIN_SEARCH_LENGTH_FOR_OPERATOR = 3

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

interface DriverListSqlRow {
  id: string
  name: string
  email: string
  createdAt: Date
  walletBalanceCents: number
  openDebtCents: number
  activeSessionId: string | null
}

router.get(
  '/',
  validateQuery(driversListQuerySchema),
  asyncHandler(async (req, res) => {
    const { search, page, pageSize } = req.query as unknown as DriversListQuery
    const isAdmin = req.user!.role === 'ADMIN'

    if (!isAdmin && (!search || search.length < MIN_SEARCH_LENGTH_FOR_OPERATOR)) {
      throw new AppError(`Operadores precisam informar "search" com pelo menos ${MIN_SEARCH_LENGTH_FOR_OPERATOR} caracteres.`, 400, 'VALIDATION_ERROR')
    }

    // Nome: fuzzy (ILIKE com wildcard). E-mail: exato, mas case-insensitive
    // (ILIKE sem wildcard = igualdade sem diferenciar maiúsculas).
    // O termo é ESCAPADO (`%`, `_` e a barra invertida): sem isso `?search=%%%` era um curinga e o
    // OPERATOR listava a rede inteira, contornando o mínimo de 3 caracteres (Órion M9).
    const searchCondition = search ? Prisma.sql`AND (u.name ILIKE ${`%${escapeLike(search)}%`} OR u.email ILIKE ${escapeLike(search)})` : Prisma.empty

    const [items, countRows] = await Promise.all([
      prisma.$queryRaw<DriverListSqlRow[]>(Prisma.sql`
        SELECT u.id AS "id", u.name AS "name", u.email AS "email", u."createdAt" AS "createdAt",
          COALESCE(w_last."balanceAfterCents", 0) AS "walletBalanceCents",
          COALESCE(debt_sum.total, 0)::int AS "openDebtCents",
          active_session.id AS "activeSessionId"
        FROM "User" u
        LEFT JOIN "Wallet" wal ON wal."userId" = u.id
        LEFT JOIN LATERAL (
          SELECT we."balanceAfterCents" FROM "WalletEntry" we WHERE we."walletId" = wal.id ORDER BY we."createdAt" DESC LIMIT 1
        ) w_last ON true
        LEFT JOIN LATERAL (
          SELECT SUM(d."amountCents")::int AS total FROM "Debt" d WHERE d."userId" = u.id AND d.status = 'OPEN'
        ) debt_sum ON true
        LEFT JOIN LATERAL (
          SELECT cs.id FROM "ChargingSession" cs WHERE cs."userId" = u.id AND cs.status IN (${sqlEstadosSessaoAberta()}) ORDER BY cs."startedAt" DESC LIMIT 1
        ) active_session ON true
        WHERE u.role = 'DRIVER' ${searchCondition}
        ORDER BY u."createdAt" DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `),
      prisma.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS "total" FROM "User" u WHERE u.role = 'DRIVER' ${searchCondition}`),
    ])

    res.json({
      items: items.map((row) => ({
        id: row.id,
        name: row.name,
        // Chave OMITIDA (nunca `null`) para OPERATOR — LGPD, mesma regra do
        // detalhe de sessão (`reportsService.getSessionDetail`).
        ...(isAdmin ? { email: row.email } : {}),
        walletBalanceCents: toNumber(row.walletBalanceCents),
        openDebtCents: toNumber(row.openDebtCents),
        activeSessionId: row.activeSessionId,
        createdAt: row.createdAt,
      })),
      total: toNumber(countRows[0]?.total),
      page,
      pageSize,
    })
  }),
)

/**
 * `GET /:id/wallet` — SEM escopo de operador (ver cabeçalho do arquivo):
 * qualquer OPERATOR/ADMIN autenticado pode consultar o saldo de um motorista
 * que já localizou (ex.: via `GET /` com `search`). Só o AJUSTE manual
 * (`POST .../wallet/entries`, abaixo) é ADMIN-only.
 */
router.get(
  '/:id/wallet',
  validateQuery(driverWalletQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as DriverWalletQuery

    const driver = await prisma.user.findFirst({ where: { id: req.params.id, role: 'DRIVER' } })
    if (!driver) throw new AppError('Motorista não encontrado.', 404, 'NOT_FOUND')

    const wallet = await prisma.wallet.findUnique({ where: { userId: driver.id } })
    const openDebtAgg = await prisma.debt.aggregate({ where: { userId: driver.id, status: 'OPEN' }, _sum: { amountCents: true } })

    let entries: Awaited<ReturnType<typeof prisma.walletEntry.findMany>> = []
    let total = 0
    let balanceCents = 0

    if (wallet) {
      const [rows, count, lastEntry] = await Promise.all([
        prisma.walletEntry.findMany({ where: { walletId: wallet.id }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
        prisma.walletEntry.count({ where: { walletId: wallet.id } }),
        prisma.walletEntry.findFirst({ where: { walletId: wallet.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } }),
      ])
      entries = rows
      total = count
      balanceCents = lastEntry?.balanceAfterCents ?? 0
    }

    res.json({
      driverId: driver.id,
      driverName: driver.name,
      balanceCents,
      openDebtCents: openDebtAgg._sum.amountCents ?? 0,
      entries: entries.map((e) => ({
        id: e.id,
        type: e.type,
        amountCents: e.amountCents,
        balanceAfterCents: e.balanceAfterCents,
        referenceType: e.referenceType,
        referenceId: e.referenceId,
        description: e.description,
        createdAt: e.createdAt,
      })),
      total,
      page,
      pageSize,
    })

    // Decisão do dono: ver o EXTRATO de um motorista específico é auditável
    // (mesmo sendo GET) — listagem geral (`GET /`, acima) não é, só este
    // drill-down por indivíduo.
    auditCtx(res).describe({ entityType: 'Wallet', entityId: driver.id, forceAudit: true })
  }),
)

/**
 * `POST /:id/wallet/entries` — ADMIN ONLY (crédito/débito manual, decisão do
 * dono: teto de R$ 5.000 por lançamento — `WALLET_ADJUSTMENT_MAX_CENTS`,
 * validado no schema Zod). `requireRole('ADMIN')` aqui em cima do
 * `requireOperatorOrAdmin` do router — só esta rota do arquivo é ADMIN-only,
 * as outras duas são OPERATOR+ADMIN.
 */
router.post(
  '/:id/wallet/entries',
  requireRole('ADMIN'),
  validateBody(walletAdjustmentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as WalletAdjustmentInput

    const driver = await prisma.user.findFirst({ where: { id: req.params.id, role: 'DRIVER' } })
    if (!driver) throw new AppError('Motorista não encontrado.', 404, 'NOT_FOUND')

    // Ator completo (email/name — o JWT só carrega userId/role/operatorId) —
    // consulta única, aceitável dado o baixo volume desta rota (ação
    // discricionária do ADMIN, não um evento de sessão em massa).
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.userId }, select: { email: true, name: true } })

    try {
      const { entry } = await ajustarCarteiraTransacional({
        userId: driver.id,
        amountCents: body.amountCents,
        description: body.description,
        createdByUserId: req.user!.userId,
        actor: { userId: req.user!.userId, role: req.user!.role, email: actor.email, name: actor.name, operatorId: req.user!.operatorId ?? null },
        request: {
          method: req.method,
          path: req.originalUrl.split('?')[0],
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          // `req.id` do pino-http é NÚMERO, mas `AuditLog.requestId` é `String?`:
          // passar o número cru faz o Prisma rejeitar o INSERT da auditoria
          // (PrismaClientValidationError) — e como esta gravação é FAIL-CLOSED
          // (mesma transação do WalletEntry), o ajuste manual de saldo dava
          // 500 SEMPRE e revertia tudo. Mesmo bug já corrigido em
          // `auditTrail.ts` e `auth.routes.ts` (17/09); este ponto ficou de
          // fora e só apareceu na 1ª execução contra Postgres real (19/09).
          requestId: (req as { id?: string | number }).id != null ? String((req as { id?: string | number }).id) : null,
        },
      })

      res.status(201).json({
        id: entry.id,
        type: entry.type,
        amountCents: entry.amountCents,
        balanceAfterCents: entry.balanceAfterCents,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        description: entry.description,
        createdAt: entry.createdAt,
      })

      // A linha de auditoria JÁ foi gravada (fail-closed, dentro da MESMA
      // transação do WalletEntry, ver walletLedger.ts) — `skip` evita o
      // middleware genérico duplicar.
      auditCtx(res).describe({ skip: true })
    } catch (err) {
      if (err instanceof SaldoInsuficienteError) throw new AppError(err.message, 409, 'INSUFFICIENT_BALANCE')
      throw err
    }
  }),
)

export default router
