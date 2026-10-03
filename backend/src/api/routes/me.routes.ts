import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { redis } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { recordCommandResult, getCommandResult } from '../../ocpp/commandResultCache'
import { iniciarSessaoRemota } from '../../services/sessao/iniciarSessaoRemota'
import { pedirParadaSessao } from '../../services/sessao/pedirParadaSessao'
import { listarEstadosSessaoAberta, isSessaoAberta } from '../../core/sessao/estadosSessao'
import { montarClosure } from '../../services/sessao/closureDto'
import { estimarIntervaloAmostragemMs } from '../../services/sessao/intervaloAmostragem'
import { withDeadline } from '../../lib/withDeadline'
import { sqlEstadosSessaoAberta } from '../lib/sessionStatusSql'
import { normalizarJanelaDeCobranca } from '../../core/tarifacao/janelaDeCobranca'
import { calcularCustoSessao, type TariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'
import { calcularTetoReserva } from '../../core/carteira/calcularTetoReserva'
import { apenasDigitos, isValidCpf } from '../../core/pagamentos/validarCpf'
import { valorTopupDentroDoLimite, TOPUP_MIN_AMOUNT_CENTS, TOPUP_MAX_AMOUNT_CENTS } from '../../core/pagamentos/validarValorTopup'
import { getPagamentoPort } from '../../services/pagamentos/pagamentoPortInstance'
import { assertMeioDePagamentoHabilitado } from '../../services/pagamentos/gatewayConfig'
import { criarPaymentIntentNoAmbienteEfetivo } from '../../services/pagamentos/criarIntentNoAmbiente'
import { toMeTopupDto } from '../../services/pagamentos/topupDto'
import { cacheTopupQrImage, getTopupDebtSettledCents, getTopupQrImage } from '../../services/pagamentos/topupEphemeralCache'
import { env } from '../../lib/env'
import { toNumber } from '../lib/reportingSql'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate, requireRole } from '../middleware/auth'
import { validateBody, validateQuery } from '../middleware/validate'
import { meStartSessionRateLimit, meCreateTopupRateLimit, sseConnectRateLimit } from '../middleware/rateLimit'
import { meStartSessionSchema, meListQuerySchema, meCreateTopupSchema, type MeStartSessionInput, type MeListQuery, type MeCreateTopupInput } from '../schemas/me.schema'
import { STATIONS_CHANNEL, userChannel } from '../../realtime/bus'
import { openSseStream } from '../lib/sseStream'
import { sseDeps } from '../lib/sseDefaultDeps'
import mePaymentMethodsRoutes from './mePaymentMethods.routes'

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

const START_LOCK_TTL_MS = 30_000
/** TTL do vínculo "1 pedido de parada em curso por sessão" — igual ao cooldown humano de `pedirParadaSessao` (10 s): passado isso, um novo toque é uma NOVA tentativa legítima. */
const STOP_CORRELATION_TTL_SECONDS = 10
const REDIS_PRAZO_MS = 2_000

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

    // F5.5: cartão desligado na tela do gateway => 409 PAYMENT_METHOD_DISABLED já na porta (sem lock, sem consulta). `iniciarSessaoRemota` repete a checagem (defesa em profundidade); a carteira nunca passa por aqui.
    if (body.payment?.mode === 'CARD') await assertMeioDePagamentoHabilitado('CARD', userId)

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
        where: { userId, status: { in: listarEstadosSessaoAberta() } }, // constante única (inclui FAULTED); STOP_UNCONFIRMED não é "em andamento" para o motorista (D7 decide em iniciarSessaoRemota)
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
        payment: body.payment,
      })

      res.status(202).json({
        correlationId: resultado.correlationId,
        status: 'PENDING',
        paymentMode: resultado.paymentMode,
        walletBalanceCents: resultado.walletBalanceCents,
        estimatedMaxCostCents: resultado.estimatedMaxCostCents,
        authorizedCents: resultado.authorizedCents,
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
  paymentMode: 'WALLET' | 'CARD'
  cardBrand: string | null
  cardLast4: string | null
  cardAuthorizedCents: number | null
  cardCapturedCents: number | null
  cardStatus: string | null
}

/**
 * `payment` (F5.4) — `card` só existe (não-null) quando `paymentMode ===
 * 'CARD'` E o `PaymentIntent` de captura já foi achado (sempre deveria
 * existir nesse caso — `StartTransaction` liga os dois na mesma escrita).
 * Contrato LITERAL de `frontend/src/types/api.ts` (`MeSessionPaymentInfo`,
 * escrito pela Lyra em paralelo — reconciliado, ver
 * `.claude/agent-memory/vega/padrao-reconciliar-contrato-compartilhado-em-paralelo.md`).
 */
function toSessionPaymentInfo(row: {
  paymentMode: 'WALLET' | 'CARD'
  cardBrand: string | null
  cardLast4: string | null
  cardAuthorizedCents: number | null
  cardCapturedCents: number | null
  cardStatus: string | null
}) {
  const card =
    row.paymentMode === 'CARD' && row.cardStatus
      ? { brand: row.cardBrand ?? '', last4: row.cardLast4, authorizedCents: row.cardAuthorizedCents ?? 0, capturedCents: row.cardCapturedCents, status: row.cardStatus }
      : null
  return { mode: row.paymentMode, card }
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
        GREATEST(0, ROUND(COALESCE(latest_meter.value, cs."meterStartWh") - cs."meterStartWh"))::int AS "energyDeliveredWh",
        cs."paymentMode" AS "paymentMode",
        card_payment.brand AS "cardBrand", card_payment.last4 AS "cardLast4",
        card_payment."authorizedCents" AS "cardAuthorizedCents", card_payment."capturedCents" AS "cardCapturedCents", card_payment.status AS "cardStatus"
      FROM "ChargingSession" cs
      JOIN "ChargePoint" cp ON cp.id = cs."chargePointId"
      JOIN "Site" s ON s.id = cs."siteId"
      JOIN "Connector" co ON co.id = cs."connectorId"
      JOIN "Tariff" t ON t.id = cs."tariffId"
      LEFT JOIN LATERAL (
        SELECT ms.value FROM "MeterSample" ms
        WHERE ms."sessionId" = cs.id AND ms."chargePointId" = cs."chargePointId" AND ms.measurand = 'Energy.Active.Import.Register'
        ORDER BY ms.ts DESC LIMIT 1
      ) latest_meter ON true
      LEFT JOIN LATERAL (
        SELECT pi.status AS status, pi."amountAuthorizedCents" AS "authorizedCents", pi."amountCapturedCents" AS "capturedCents", pm.brand AS brand, pm.last4 AS last4
        FROM "PaymentIntent" pi
        LEFT JOIN "PaymentMethod" pm ON pm.id = pi."paymentMethodId"
        WHERE pi."chargingSessionId" = cs.id AND pi.purpose = 'SESSION_CARD_CAPTURE'
        LIMIT 1
      ) card_payment ON true
      WHERE cs."userId" = ${userId} AND cs.status IN (${sqlEstadosSessaoAberta()})
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
    // Janela normalizada: "agora" (servidor) contra `startedAt` (carregador) com o relógio dele adiantado fazia o cálculo LANÇAR e o app tomava 500.
    const janela = normalizarJanelaDeCobranca({ startedAt: row.startedAt, chargingEndedAt: row.chargingEndedAt, stoppedAt: new Date() })
    const { totalCostCents: estimatedCostCents } = calcularCustoSessao(tariffSnapshot, {
      energyDeliveredWh,
      startedAt: janela.startedAt,
      chargingEndedAt: janela.chargingEndedAt,
      stoppedAt: janela.stoppedAt,
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
        paymentMode: row.paymentMode,
        payment: toSessionPaymentInfo(row),
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
        chargePoint: { select: { ocppIdentity: true, lastSeenAt: true, disconnectedAt: true, connectedAt: true } },
        connector: { select: { connectorId: true, type: true } },
        tariff: { select: { name: true, currency: true } },
      },
    })
    if (!session) throw new AppError('Sessão não encontrada.', 404, 'SESSION_NOT_FOUND')

    const [walletEntry, debt, cardIntent] = await Promise.all([
      prisma.walletEntry.findFirst({
        where: { type: 'CHARGE_DEBIT', referenceType: 'CHARGING_SESSION', referenceId: session.id },
        select: { id: true, amountCents: true, balanceAfterCents: true, createdAt: true },
      }),
      prisma.debt.findFirst({
        where: { chargingSessionId: session.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, amountCents: true },
      }),
      session.paymentMode === 'CARD'
        ? prisma.paymentIntent.findFirst({
            where: { chargingSessionId: session.id, purpose: 'SESSION_CARD_CAPTURE' },
            select: { status: true, amountAuthorizedCents: true, amountCapturedCents: true, authorizedAt: true, paymentMethod: { select: { brand: true, last4: true } } },
          })
        : Promise.resolve(null),
    ])

    const tariffSnapshot = session.tariffSnapshot as unknown as TariffSnapshot
    const payment = toSessionPaymentInfo({
      paymentMode: session.paymentMode,
      cardBrand: cardIntent?.paymentMethod?.brand ?? null,
      cardLast4: cardIntent?.paymentMethod?.last4 ?? null,
      cardAuthorizedCents: cardIntent?.amountAuthorizedCents ?? null,
      cardCapturedCents: cardIntent?.amountCapturedCents ?? null,
      cardStatus: cardIntent?.status ?? null,
    })

    res.json({
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      stopReason: session.stopReason,
      site: session.site,
      chargePoint: { ocppIdentity: session.chargePoint.ocppIdentity },
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
      paymentMode: session.paymentMode,
      payment,
      // F5.9: SÓ o que o motorista pode ver. Nunca `lateStop`/`unbilledCostCents`/`stopRequested*` (são do admin). Custos de sessão em confirmação
      // saem `null` (a coluna só é gravada no fechamento) — a UI mostra "em confirmação", nunca 0.
      closure: montarClosure({
        status: session.status,
        paymentMode: session.paymentMode,
        closureSource: session.closureSource,
        meterStopSource: session.meterStopSource,
        unconfirmedAt: session.unconfirmedAt,
        unconfirmedReason: session.unconfirmedReason,
        stoppedAt: session.stoppedAt,
        cardAuthorizedAt: cardIntent?.status === 'AUTHORIZED' ? (cardIntent.authorizedAt ?? null) : null,
        carregador: session.chargePoint,
        intervaloAmostragemMs: session.status === 'STOP_UNCONFIRMED' ? await estimarIntervaloAmostragemMs(prisma, session.id, session.chargePointId) : null,
      }),
    })
  }),
)

// ------------------------------------------------------------
// POST /sessions/:id/stop
// ------------------------------------------------------------

/**
 * Vincula UM correlationId ao pedido de parada em curso da sessão (SET NX com TTL curto). `novo=false` => já havia um pedido nos últimos
 * `STOP_CORRELATION_TTL_SECONDS` s: devolve o id dele. Redis fora => segue como pedido novo (parar a recarga vale mais que a deduplicação).
 */
async function adquirirCorrelacaoDeParada(sessionId: string, proposto: string): Promise<{ correlationId: string; novo: boolean }> {
  const chave = `me:stop-corr:${sessionId}`
  try {
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      if ((await withDeadline(redis.set(chave, proposto, 'EX', STOP_CORRELATION_TTL_SECONDS, 'NX'), REDIS_PRAZO_MS, 'vínculo do pedido de parada')) === 'OK') return { correlationId: proposto, novo: true }
      const existente = await withDeadline(redis.get(chave), REDIS_PRAZO_MS, 'vínculo do pedido de parada')
      if (existente) return { correlationId: existente, novo: false }
      // a chave expirou entre o SET e o GET: tenta de novo uma vez
    }
  } catch (err) {
    logger.warn({ err, sessionId }, '[api][me] vínculo do pedido de parada indisponível (Redis) — seguindo sem deduplicar')
  }
  return { correlationId: proposto, novo: true }
}

router.post(
  '/sessions/:id/stop',
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId

    const session = await prisma.chargingSession.findFirst({ where: { id: req.params.id, userId } })
    if (!session) throw new AppError('Sessão não encontrada.', 404, 'SESSION_NOT_FOUND')
    // Aberta (inclui FAULTED) pode parar; STOP_UNCONFIRMED e STOPPED => 409 (o motorista não "para" o que o servidor já tratou como encerrado).
    if (!isSessaoAberta(session.status)) {
      throw new AppError('Sessão não está ativa.', 409, 'SESSION_NOT_ACTIVE')
    }

    // Duplo toque: um pedido de parada em curso por sessão. O 2º toque recebe o MESMO correlationId do 1º (o polling do PWA resolve com o
    // resultado real do comando em curso) em vez de um correlationId novo que ninguém jamais resolveria.
    const proposto = randomUUID()
    const vinculo = await adquirirCorrelacaoDeParada(session.id, proposto)
    if (!vinculo.novo) {
      logger.info({ sessionId: session.id, userId, correlationId: vinculo.correlationId }, '[api][me] stop duplicado (duplo toque) — devolvendo o correlationId do pedido em curso')
      res.status(202).json({ correlationId: vinculo.correlationId, status: 'PENDING' })
      return
    }
    const correlationId = proposto
    logger.info({ sessionId: session.id, chargePointId: session.chargePointId, userId, correlationId }, '[api][me] stop de sessão disparado')

    // F5.9: ponto ÚNICO de RemoteStop (`pedirParadaSessao`). Um `Rejected`/erro de transporte NÃO fecha mais a sessão com dinheiro (era o
    // `reconciliarSessaoOrfa`, defeito M5/M6): ela vira STOP_UNCONFIRMED e o StopTransaction do carregador — ou o watchdog, depois da
    // janela — decide. Timeout só registra.
    pedirParadaSessao({ sessionId: session.id, solicitante: 'DRIVER' })
      .then((resultado) => {
        logger.info({ sessionId: session.id, correlationId, resultado }, '[api][me] stop de sessão concluído')
        if (!resultado.registrado) {
          // Não houve comando NOVO por este pedido, e deixar o correlationId PENDING para sempre era o defeito: EM_COOLDOWN = outro pedido de parada
          // (guarda/watchdog/admin) acabou de sair e já cobre este; NAO_ABERTA/CONDICAO_MUDOU = a sessão fechou no meio. Nos dois casos o objetivo
          // do toque ("parar") está atendido ou em curso — resultado coerente: ACCEPTED. O PWA relê a sessão (estado real) de qualquer forma.
          return recordCommandResult(correlationId, 'ACCEPTED', userId)
        }
        return recordCommandResult(correlationId, resultado.comando === 'ACCEPTED' ? 'ACCEPTED' : resultado.comando === 'TIMEOUT' ? 'TIMEOUT' : 'REJECTED', userId)
      })
      .catch((err) => logger.error({ err, sessionId: session.id, correlationId }, '[api][me] stop de sessão falhou'))

    res.status(202).json({ correlationId, status: 'PENDING' })
  }),
)

// ------------------------------------------------------------
// GET /commands/:correlationId — conserta o 202 cego
// ------------------------------------------------------------

router.get(
  '/commands/:correlationId',
  asyncHandler(async (req, res) => {
    const status = (await getCommandResult(req.params.correlationId, req.user!.userId)) ?? 'PENDING'
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

// ------------------------------------------------------------
// POST /wallet/topups — gera um Pix real (F5.2, 2026-09-30)
// ------------------------------------------------------------

router.post(
  '/wallet/topups',
  meCreateTopupRateLimit,
  validateBody(meCreateTopupSchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const { amountCents, cpf } = req.body as MeCreateTopupInput

    // F5.5: admin pode desligar o Pix na tela do gateway — só bloqueia COMEÇOS novos (QR já gerado continua pagável/creditável).
    await assertMeioDePagamentoHabilitado('PIX', userId)

    // Faixa de valor e CPF respondem com `code` ESPECÍFICO (contrato de
    // `frontend/src/lib/topupAmount.ts`), por isso são checados aqui — não
    // no schema Zod, que cairia em `VALIDATION_ERROR` genérico.
    if (!valorTopupDentroDoLimite(amountCents)) {
      throw new AppError('Valor fora do permitido para recarga.', 400, 'TOPUP_AMOUNT_OUT_OF_RANGE', [{ minCents: TOPUP_MIN_AMOUNT_CENTS, maxCents: TOPUP_MAX_AMOUNT_CENTS }])
    }
    const cpfDigits = cpf ? apenasDigitos(cpf) : undefined
    if (cpfDigits && !isValidCpf(cpfDigits)) {
      throw new AppError('CPF inválido.', 400, 'INVALID_CPF')
    }

    const pendingCount = await prisma.paymentIntent.count({ where: { userId, purpose: 'WALLET_TOPUP_PIX', status: 'PENDING' } })
    if (pendingCount >= env.TOPUP_PIX_MAX_PENDING_PER_USER) {
      throw new AppError('Você já tem uma recarga Pix aguardando pagamento.', 409, 'TOO_MANY_PENDING_TOPUPS')
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
    if (!user) throw new AppError('Usuário não encontrado.', 404, 'NOT_FOUND') // não deveria acontecer com JWT válido

    const wallet = (await prisma.wallet.findUnique({ where: { userId } })) ?? (await prisma.wallet.create({ data: { userId } }))

    // F5.7 (M4a): o intent nasce com o ambiente EFETIVO explícito — a coluna tem DEFAULT SANDBOX, e esquecer isto em produção rotularia dinheiro real como teste.
    // F5.8 (M4c): o ambiente é lido SOB LOCK, na transação do INSERT, serializado com a troca de ambiente do PUT do gateway (ver `criarIntentNoAmbiente.ts`) — não do cache.
    const intent = await criarPaymentIntentNoAmbienteEfetivo({
      purpose: 'WALLET_TOPUP_PIX',
      provider: 'CIELO_PIX',
      userId,
      walletId: wallet.id,
      amountRequestedCents: amountCents,
      status: 'CREATED',
    })

    const expiresInSeconds = env.PIX_TOPUP_EXPIRES_MINUTES * 60
    let resultadoPix
    try {
      resultadoPix = await (await getPagamentoPort()).criarPix({
        merchantOrderId: intent.id,
        amountRequestedCents: amountCents,
        cliente: { name: user.name, identity: cpfDigits ?? null },
        expiresInSeconds,
      })
    } catch (err) {
      logger.error({ err, intentId: intent.id }, '[api][me] falha ao criar Pix na Cielo')
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'FAILED', failureReason: 'Falha ao criar cobrança Pix no gateway de pagamento.' } })
      throw new AppError('O Pix está indisponível no momento. Tente novamente em instantes.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
    }

    const updated = await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        cieloPaymentId: resultadoPix.providerPaymentId,
        pixQrCode: resultadoPix.qrCodeString,
        pixExpiresAt: resultadoPix.expiresAt,
        status: 'PENDING',
      },
    })

    if (resultadoPix.qrCodeBase64Image) {
      await cacheTopupQrImage(intent.id, resultadoPix.qrCodeBase64Image).catch((err) => logger.error({ err, intentId: intent.id }, '[api][me] falha ao cachear imagem do QR (não bloqueante)'))
    }

    logger.info({ intentId: intent.id, amountCents }, '[api][me] Pix de recarga criado')
    res.status(201).json(toMeTopupDto(updated, resultadoPix.qrCodeBase64Image ?? null, 0))
  }),
)

// ------------------------------------------------------------
// GET /wallet/topups/:id
// ------------------------------------------------------------

router.get(
  '/wallet/topups/:id',
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId

    const intent = await prisma.paymentIntent.findFirst({ where: { id: req.params.id, userId, purpose: 'WALLET_TOPUP_PIX' } })
    if (!intent) throw new AppError('Recarga não encontrada.', 404, 'TOPUP_NOT_FOUND')

    const [qrCodeImageBase64, debtSettledCents] = await Promise.all([getTopupQrImage(intent.id), getTopupDebtSettledCents(intent.id)])

    res.json(toMeTopupDto(intent, qrCodeImageBase64, debtSettledCents))
  }),
)

// ------------------------------------------------------------
// /payment-methods — cadastro de cartão (F5.3, D1: SAQ A-EP). Sub-router
// próprio (`mePaymentMethods.routes.ts`) — este arquivo já estava grande, e
// o rate limit de cadastro/tokenização é mais apertado que o resto de `/me`
// (aplicado DENTRO do sub-router, não aqui).
// ------------------------------------------------------------
router.use('/payment-methods', mePaymentMethodsRoutes)

/**
 * `GET /api/me/events` — canal SSE do motorista. Assina o PRÓPRIO canal
 * (`ui:ev:user:{userId}`) — `wallet.updated`/`session.metrics`/
 * `session.started`/`session.stopped` do próprio motorista, nunca de outro
 * (fronteira multi-tenant na assinatura, ver `realtime/bus.ts`) — E o canal
 * PÚBLICO de estações (`ui:ev:stations`, `chargepoint.status` de qualquer
 * carregador, para o mapa "eletropostos perto de mim" atualizar sozinho).
 * Este stream continua exigindo login (`authenticate` + `requireRole('DRIVER')`
 * do router): NÃO existe SSE público sem autenticação. Os canais op/admin
 * não são tocados aqui. Mesma mecânica de heartbeat/headers do painel admin
 * (`events.routes.ts`).
 */
router.get('/events', sseConnectRateLimit, (req, res) => {
  openSseStream(sseDeps, req, res, [userChannel(req.user!.userId), STATIONS_CHANNEL])
})

export default router
