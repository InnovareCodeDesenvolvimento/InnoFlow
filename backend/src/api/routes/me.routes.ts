import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { redis } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { sendCommand, OcppCommandTimeoutError } from '../../ocpp/commands'
import { recordCommandResult, getCommandResult, isAcceptedCommandResult } from '../../ocpp/commandResultCache'
import { iniciarSessaoRemota } from '../../services/sessao/iniciarSessaoRemota'
import { reconciliarSessaoOrfa } from '../../services/carteira/reconciliarSessaoOrfa'
import { calcularCustoSessao, type TariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { calcularTetoReserva } from '../../core/carteira/calcularTetoReserva'
import { env } from '../../lib/env'
import { toNumber } from '../lib/reportingSql'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { validateBody, validateQuery } from '../middleware/validate'
import { meStartSessionRateLimit } from '../middleware/rateLimit'
import { meStartSessionSchema, meListQuerySchema, type MeStartSessionInput, type MeListQuery } from '../schemas/me.schema'
import { userChannel } from '../../realtime/bus'
import { startSseStream } from './events.routes'

/**
 * PWA do motorista (F6, 2026-09-17) — ver `.claude/agent-memory/nova/
 * decisoes-pwa-motorista.md`. Regra dura, sem exceção, auditável com uma
 * frase: NENHUMA rota deste arquivo lê `userId` de body/query/param — SEMPRE
 * `req.user!.userId`. Recurso de outro motorista => 404 (nunca 403, mesma
 * convenção anti-enumeração do resto da API).
 *
 * `requireRole('DRIVER')` uma vez aqui em cima — admin/operator não têm
 * carteira própria nem sessão própria, não fazem sentido nestas rotas.
 */

const COMMAND_TIMEOUT_MS = 35_000
const START_LOCK_TTL_MS = 30_000
const ACTIVE_SESSION_STATUSES = ['STARTED', 'CHARGING', 'FINISHING'] as const

const router = Router()

router.use(authenticate, requireRole('DRIVER'))

async function getWalletBalanceCents(userId: string): Promise<number> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { id: true } })
  if (!wallet) return 0
  const lastEntry = await prisma.walletEntry.findFirst({ where: { walletId: wallet.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
  return lastEntry?.balanceAfterCents ?? 0
}

function toTariffSummaryFromSnapshot(snapshot: TariffSnapshot, name: string, currency: string) {
  return {
    name,
    model: snapshot.model,
    pricePerKwh: snapshot.pricePerKwh ?? null,
    pricePerMinute: snapshot.pricePerMinute ?? null,
    sessionFeeCents: snapshot.sessionFeeCents ?? null,
    minChargeCents: snapshot.minChargeCents ?? null,
    idleFeePerMinute: snapshot.idleFeePerMinute,
    currency,
  }
}

// ------------------------------------------------------------
// POST /sessions/start
// ------------------------------------------------------------

router.post(
  '/sessions/start',
  meStartSessionRateLimit,
  validateBody(meStartSessionSchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const body = req.body as MeStartSessionInput

    // Lock anti-duplo-toque: duas requisições de start quase simultâneas do
    // MESMO motorista (ex.: usuário toca duas vezes o botão no PWA antes do
    // primeiro 202 voltar) não podem gerar dois AuthToken VIRTUAL/dois
    // RemoteStartTransaction concorrentes. Liberado no `finally` — o lock só
    // protege esta requisição HTTP, não o tempo de resposta do carregador
    // (isso o barramento de comandos já resolve fire-and-forget).
    const lockKey = `me:start:${userId}`
    const lockAcquired = await redis.set(lockKey, '1', 'PX', START_LOCK_TTL_MS, 'NX')
    if (!lockAcquired) {
      throw new AppError('Já existe uma solicitação de início de recarga em andamento. Aguarde alguns segundos.', 409, 'ALREADY_HAS_ACTIVE_SESSION')
    }

    try {
      const activeSession = await prisma.chargingSession.findFirst({
        where: { userId, status: { in: [...ACTIVE_SESSION_STATUSES] } },
        select: { id: true },
      })
      if (activeSession) {
        throw new AppError('Você já tem uma recarga em andamento.', 409, 'ALREADY_HAS_ACTIVE_SESSION', [{ sessionId: activeSession.id }])
      }

      const chargePoint = await prisma.chargePoint.findFirst({ where: { ocppIdentity: body.ocppIdentity, active: true }, select: { id: true } })
      if (!chargePoint) throw new AppError('Carregador não encontrado.', 404, 'CHARGE_POINT_NOT_FOUND')

      const resultado = await iniciarSessaoRemota({
        chargePointId: chargePoint.id,
        chargePointScope: {}, // motorista é conta de rede — carrega em qualquer operador, sem isolamento por operatorId aqui
        connectorId: body.connectorId,
        userId,
      })

      res.status(202).json({
        correlationId: resultado.correlationId,
        status: 'PENDING',
        walletBalanceCents: resultado.walletBalanceCents,
        estimatedMaxCostCents: resultado.estimatedMaxCostCents,
        minChargeCents: resultado.minChargeCents,
      })
    } finally {
      await redis.del(lockKey)
    }
  }),
)

// ------------------------------------------------------------
// GET /sessions/active
// ------------------------------------------------------------

interface ActiveSessionRow {
  id: string
  status: string
  startedAt: Date
  chargePointOcppIdentity: string
  chargePointVendor: string | null
  chargePointModel: string | null
  siteId: string
  siteName: string
  siteAddressLine: string
  siteCity: string
  siteTimezone: string
  connectorNumber: number
  connectorType: string
  connectorMaxPowerKw: string | null
  meterStartWh: number
  chargingEndedAt: Date | null
  tariffSnapshot: Prisma.JsonValue
  lastPowerW: number | null
  lastSoc: number | null
  lastSampleAt: Date | null
  tariffName: string
  tariffCurrency: string
  energyDeliveredWh: number
}

router.get(
  '/sessions/active',
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId

    const rows = await prisma.$queryRaw<ActiveSessionRow[]>(Prisma.sql`
      SELECT cs.id AS "id", cs.status AS "status", cs."startedAt" AS "startedAt",
        cp."ocppIdentity" AS "chargePointOcppIdentity", cp.vendor AS "chargePointVendor", cp.model AS "chargePointModel",
        s.id AS "siteId", s.name AS "siteName", s."addressLine" AS "siteAddressLine", s.city AS "siteCity", s.timezone AS "siteTimezone",
        co."connectorId" AS "connectorNumber", co.type AS "connectorType", co."maxPowerKw"::text AS "connectorMaxPowerKw",
        cs."meterStartWh" AS "meterStartWh", cs."chargingEndedAt" AS "chargingEndedAt", cs."tariffSnapshot" AS "tariffSnapshot",
        cs."lastPowerW" AS "lastPowerW", cs."lastSoc" AS "lastSoc", cs."lastSampleAt" AS "lastSampleAt",
        t.name AS "tariffName", t.currency AS "tariffCurrency",
        GREATEST(0, ROUND(COALESCE(latest_meter.value, cs."meterStartWh") - cs."meterStartWh"))::int AS "energyDeliveredWh"
      FROM "ChargingSession" cs
      JOIN "ChargePoint" cp ON cp.id = cs."chargePointId"
      JOIN "Site" s ON s.id = cs."siteId"
      JOIN "Connector" co ON co.id = cs."connectorId"
      JOIN "Tariff" t ON t.id = cs."tariffId"
      LEFT JOIN LATERAL (
        SELECT ms.value FROM "MeterSample" ms
        WHERE ms."sessionId" = cs.id AND ms.measurand = 'Energy.Active.Import.Register'
        ORDER BY ms.ts DESC LIMIT 1
      ) latest_meter ON true
      WHERE cs."userId" = ${userId} AND cs.status IN ('STARTED', 'CHARGING', 'FINISHING')
      ORDER BY cs."startedAt" DESC
      LIMIT 1
    `)

    const walletBalanceCents = await getWalletBalanceCents(userId)
    const row = rows[0]

    if (!row) {
      res.json({ session: null, walletBalanceCents, generatedAt: new Date().toISOString() })
      return
    }

    const tariffSnapshot = row.tariffSnapshot as unknown as TariffSnapshot
    const energyDeliveredWh = toNumber(row.energyDeliveredWh)

    // MESMA função (`calcularCustoSessao`) que a guarda ao vivo do
    // MeterValues usa (ver `ocpp/handlers/meterValues.ts:runBalanceGuard`) —
    // nunca pode divergir do que decide o auto-stop (regra 6 da Nova).
    const { totalCostCents: estimatedCostCents } = calcularCustoSessao(tariffSnapshot, {
      energyDeliveredWh,
      startedAt: row.startedAt,
      chargingEndedAt: row.chargingEndedAt,
      stoppedAt: new Date(),
      timezone: row.siteTimezone,
    })

    const estimatedMaxCostCents = calcularTetoReserva(
      { pricePerKwh: tariffSnapshot.pricePerKwh, pricePerMinute: tariffSnapshot.pricePerMinute, sessionFeeCents: tariffSnapshot.sessionFeeCents },
      { maxPowerKw: row.connectorMaxPowerKw },
      { pisoCents: env.RESERVA_PISO_CENTS, tetoCents: env.RESERVA_TETO_CENTS },
    )

    res.json({
      session: {
        id: row.id,
        status: row.status,
        startedAt: row.startedAt,
        chargePoint: { ocppIdentity: row.chargePointOcppIdentity, vendor: row.chargePointVendor, model: row.chargePointModel },
        site: { id: row.siteId, name: row.siteName, addressLine: row.siteAddressLine, city: row.siteCity },
        connector: { connectorId: toNumber(row.connectorNumber), type: row.connectorType, maxPowerKw: row.connectorMaxPowerKw },
        energyDeliveredWh,
        lastPowerW: row.lastPowerW,
        lastSoc: row.lastSoc,
        lastSampleAt: row.lastSampleAt,
        estimatedCostCents,
        estimatedMaxCostCents,
        minChargeCents: tariffSnapshot.minChargeCents ?? null,
        tariff: toTariffSummaryFromSnapshot(tariffSnapshot, row.tariffName, row.tariffCurrency),
      },
      walletBalanceCents,
      generatedAt: new Date().toISOString(),
    })
  }),
)

// ------------------------------------------------------------
// GET /sessions — histórico paginado
// ------------------------------------------------------------

interface SessionListSqlRow {
  id: string
  status: string
  startedAt: Date
  stoppedAt: Date | null
  siteName: string
  ocppIdentity: string
  connectorId: number
  energyDeliveredWh: number | null
  totalCostCents: number | null
}

router.get(
  '/sessions',
  validateQuery(meListQuerySchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const { page, pageSize } = req.query as unknown as MeListQuery

    const [items, countRows] = await Promise.all([
      prisma.$queryRaw<SessionListSqlRow[]>(Prisma.sql`
        SELECT cs.id AS "id", cs.status AS "status", cs."startedAt" AS "startedAt", cs."stoppedAt" AS "stoppedAt",
          s.name AS "siteName", cp."ocppIdentity" AS "ocppIdentity", co."connectorId" AS "connectorId",
          cs."energyDeliveredWh" AS "energyDeliveredWh", cs."totalCostCents" AS "totalCostCents"
        FROM "ChargingSession" cs
        JOIN "Site" s ON s.id = cs."siteId"
        JOIN "ChargePoint" cp ON cp.id = cs."chargePointId"
        JOIN "Connector" co ON co.id = cs."connectorId"
        WHERE cs."userId" = ${userId}
        ORDER BY cs."startedAt" DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `),
      prisma.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS "total" FROM "ChargingSession" cs WHERE cs."userId" = ${userId}`),
    ])

    res.json({
      items: items.map((row) => ({
        id: row.id,
        status: row.status,
        startedAt: row.startedAt,
        stoppedAt: row.stoppedAt,
        siteName: row.siteName,
        ocppIdentity: row.ocppIdentity,
        connectorId: toNumber(row.connectorId),
        energyDeliveredWh: row.energyDeliveredWh,
        totalCostCents: row.totalCostCents,
      })),
      total: toNumber(countRows[0]?.total),
      page,
      pageSize,
    })
  }),
)

// ------------------------------------------------------------
// GET /sessions/:id — recibo completo
// ------------------------------------------------------------

router.get(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId

    const session = await prisma.chargingSession.findFirst({
      where: { id: req.params.id, userId },
      include: {
        site: { select: { name: true, addressLine: true, city: true } },
        chargePoint: { select: { ocppIdentity: true } },
        connector: { select: { connectorId: true, type: true } },
        tariff: { select: { name: true, currency: true } },
      },
    })
    if (!session) throw new AppError('Sessão não encontrada.', 404, 'SESSION_NOT_FOUND')

    const [walletEntry, debt] = await Promise.all([
      prisma.walletEntry.findFirst({
        where: { type: 'CHARGE_DEBIT', referenceType: 'CHARGING_SESSION', referenceId: session.id },
        select: { id: true, amountCents: true, balanceAfterCents: true, createdAt: true },
      }),
      prisma.debt.findFirst({
        where: { chargingSessionId: session.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, amountCents: true },
      }),
    ])

    const tariffSnapshot = session.tariffSnapshot as unknown as TariffSnapshot

    res.json({
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      stopReason: session.stopReason,
      site: session.site,
      chargePoint: session.chargePoint,
      connector: session.connector,
      energyDeliveredWh: session.energyDeliveredWh,
      idleSeconds: session.idleSeconds,
      energyCostCents: session.energyCostCents,
      timeCostCents: session.timeCostCents,
      idleFeeCents: session.idleFeeCents,
      sessionFeeCents: session.sessionFeeCents,
      minChargeAdjustmentCents: session.minChargeAdjustmentCents,
      totalCostCents: session.totalCostCents,
      tariff: toTariffSummaryFromSnapshot(tariffSnapshot, session.tariff.name, session.tariff.currency),
      walletEntry: walletEntry ?? null,
      debt: debt ?? null,
    })
  }),
)

// ------------------------------------------------------------
// POST /sessions/:id/stop
// ------------------------------------------------------------

router.post(
  '/sessions/:id/stop',
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId

    const session = await prisma.chargingSession.findFirst({ where: { id: req.params.id, userId } })
    if (!session) throw new AppError('Sessão não encontrada.', 404, 'SESSION_NOT_FOUND')
    if (!ACTIVE_SESSION_STATUSES.includes(session.status as (typeof ACTIVE_SESSION_STATUSES)[number])) {
      throw new AppError('Sessão não está ativa.', 409, 'SESSION_NOT_ACTIVE')
    }

    const correlationId = randomUUID()
    logger.info({ sessionId: session.id, chargePointId: session.chargePointId, userId, correlationId }, '[api][me] stop de sessão disparado')

    sendCommand(session.chargePointId, 'RemoteStopTransaction', { transactionId: session.ocppTransactionId }, { timeoutMs: COMMAND_TIMEOUT_MS })
      .then(async (result) => {
        logger.info({ sessionId: session.id, correlationId, result }, '[api][me] stop de sessão concluído')
        const accepted = isAcceptedCommandResult(result)
        if (!accepted) {
          // Achado real em produção, 17/09/2026: um `RemoteStopTransaction`
          // rejeitado quase sempre significa "o carregador não reconhece
          // mais esta transação" (ex.: reconectou entre o start e o stop —
          // o simulador Solidstudio VCP não preserva transactionId através
          // de uma reconexão). Sem isto, a sessão ficava presa em STARTED
          // pra sempre e o motorista via a tela de "parando a recarga..."
          // girando eternamente, já que o `StopTransaction` real nunca
          // chegaria de um carregador que já esqueceu a transação. MESMA
          // reconciliação usada no boot (`reconciliarSessaoOrfa`) — closes
          // com a última leitura de medidor conhecida.
          await reconciliarSessaoOrfa(session.id).catch((err) =>
            logger.error({ err, sessionId: session.id, correlationId }, '[api][me] falha ao reconciliar sessão após stop rejeitado'),
          )
        }
        return recordCommandResult(correlationId, accepted ? 'ACCEPTED' : 'REJECTED')
      })
      .catch(async (err) => {
        logger.error({ err, sessionId: session.id, correlationId }, '[api][me] stop de sessão falhou')
        const timedOut = err instanceof OcppCommandTimeoutError
        // Timeout é ambíguo (pode só estar lento) — não reconcilia à força.
        // Qualquer outra falha de transporte é tratada como "carregador
        // inalcançável", mesmo caso de reconciliar.
        if (!timedOut) {
          await reconciliarSessaoOrfa(session.id).catch((reconcileErr) =>
            logger.error({ err: reconcileErr, sessionId: session.id, correlationId }, '[api][me] falha ao reconciliar sessão após stop com erro'),
          )
        }
        return recordCommandResult(correlationId, timedOut ? 'TIMEOUT' : 'REJECTED')
      })
      .catch((err) => logger.error({ err, correlationId }, '[api][me] falha ao gravar resultado do comando em Redis (não bloqueante)'))

    res.status(202).json({ correlationId, status: 'PENDING' })
  }),
)

// ------------------------------------------------------------
// GET /commands/:correlationId — conserta o 202 cego
// ------------------------------------------------------------

router.get(
  '/commands/:correlationId',
  asyncHandler(async (req, res) => {
    const status = (await getCommandResult(req.params.correlationId)) ?? 'PENDING'
    res.json({ status })
  }),
)

// ------------------------------------------------------------
// GET /wallet
// ------------------------------------------------------------

router.get(
  '/wallet',
  validateQuery(meListQuerySchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const { page, pageSize } = req.query as unknown as MeListQuery

    const wallet = await prisma.wallet.findUnique({ where: { userId } })
    const openDebtAgg = await prisma.debt.aggregate({ where: { userId, status: 'OPEN' }, _sum: { amountCents: true } })

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
  }),
)

/**
 * `GET /api/me/events` — canal SSE do motorista. Assina SÓ o próprio canal
 * (`ui:ev:user:{userId}`) — `wallet.updated`/`session.metrics`/
 * `session.started`/`session.stopped` do próprio motorista, nunca de outro
 * (fronteira multi-tenant na assinatura, ver `realtime/bus.ts`). Mesma
 * mecânica de heartbeat/headers do painel admin (`events.routes.ts`).
 */
router.get('/events', (req, res) => {
  startSseStream(req, res, [userChannel(req.user!.userId)])
})

export default router
