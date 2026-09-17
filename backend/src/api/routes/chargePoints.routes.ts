import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import bcrypt from 'bcryptjs'
import type { ChargePoint, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { sendCommand } from '../../ocpp/commands'
import { resolveActiveTariff } from '../../ocpp/tariffResolution'
import { avaliarInicioSessao } from '../../core/carteira/avaliarInicioSessao'
import { calcularTetoReserva } from '../../core/carteira/calcularTetoReserva'
import { CHARGE_POINT_ONLINE_THRESHOLD_MS } from '../services/dashboardService'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { operatorScopeWhere, requireOperatorOrAdmin } from '../middleware/tenantScope'
import { validateBody, validateQuery } from '../middleware/validate'
import { paginationMeta, paginationQuerySchema, type PaginationQuery } from '../schemas/pagination.schema'
import { createChargePointSchema, updateChargePointSchema, type CreateChargePointInput, type UpdateChargePointInput } from '../schemas/chargePoint.schema'
import {
  changeAvailabilitySchema,
  remoteStartCommandSchema,
  resetCommandSchema,
  triggerMessageSchema,
  unlockCommandSchema,
  type RemoteStartCommandInput,
} from '../schemas/command.schema'

const BCRYPT_ROUNDS = 10
const COMMAND_TIMEOUT_MS = 35_000

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

/** NUNCA devolve `basicAuthSecretHash` — mesmo sendo hash, não tem por que sair da API. */
function toChargePointDTO<T extends ChargePoint>(cp: T) {
  const { basicAuthSecretHash: _basicAuthSecretHash, ...rest } = cp
  return rest
}

router.get(
  '/',
  validateQuery(paginationQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as PaginationQuery
    const where = operatorScopeWhere(req)

    const [items, total] = await Promise.all([
      prisma.chargePoint.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { connectors: true, site: { select: { id: true, name: true } } },
      }),
      prisma.chargePoint.count({ where }),
    ])

    res.json({ items: items.map(toChargePointDTO), meta: paginationMeta(page, pageSize, total) })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const cp = await prisma.chargePoint.findFirst({
      where: { id: req.params.id, ...operatorScopeWhere(req) },
      include: { connectors: true, site: { select: { id: true, name: true } } },
    })
    if (!cp) throw new AppError('Charge point não encontrado.', 404, 'NOT_FOUND')
    res.json(toChargePointDTO(cp))
  }),
)

router.post(
  '/',
  validateBody(createChargePointSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as CreateChargePointInput

    const site = await prisma.site.findFirst({ where: { id: body.siteId, ...operatorScopeWhere(req) } })
    if (!site) throw new AppError('Site não encontrado.', 404, 'NOT_FOUND')

    const basicAuthSecretHash = await bcrypt.hash(body.basicAuthSecret, BCRYPT_ROUNDS)

    const cp = await prisma.chargePoint.create({
      data: {
        // operatorId é reescrito por trigger a partir de site.operatorId de
        // qualquer forma — mandamos o valor já resolvido só para satisfazer
        // o tipo obrigatório do Prisma (ver schema-innoelektron.md).
        operatorId: site.operatorId,
        siteId: site.id,
        ocppIdentity: body.ocppIdentity,
        vendor: body.vendor,
        model: body.model,
        serialNumber: body.serialNumber,
        firmwareVersion: body.firmwareVersion,
        basicAuthSecretHash,
      },
    })

    res.status(201).json(toChargePointDTO(cp))
  }),
)

router.patch(
  '/:id',
  validateBody(updateChargePointSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.chargePoint.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Charge point não encontrado.', 404, 'NOT_FOUND')

    const { basicAuthSecret, ...rest } = req.body as UpdateChargePointInput
    const data: Prisma.ChargePointUpdateInput = { ...rest }
    if (basicAuthSecret) data.basicAuthSecretHash = await bcrypt.hash(basicAuthSecret, BCRYPT_ROUNDS)

    const cp = await prisma.chargePoint.update({ where: { id: existing.id }, data })
    res.json(toChargePointDTO(cp))
  }),
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.chargePoint.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Charge point não encontrado.', 404, 'NOT_FOUND')
    await prisma.chargePoint.update({ where: { id: existing.id }, data: { active: false } })
    res.status(204).send()
  }),
)

// ------------------------------------------------------------
// Comandos remotos — 202 assíncrono via barramento Redis do gateway OCPP.
// ------------------------------------------------------------

async function requireOwnedChargePoint(req: Request): Promise<ChargePoint> {
  const cp = await prisma.chargePoint.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
  if (!cp) throw new AppError('Charge point não encontrado.', 404, 'NOT_FOUND')
  return cp
}

/**
 * Dispara o comando e responde 202 IMEDIATAMENTE — não bloqueia a resposta
 * HTTP esperando o carregador responder (pode levar até ~35s, ver
 * commands.ts). O resultado fica só no log por enquanto; consumo em tempo
 * real pelo frontend é via SSE (stub em `src/api/sse/`, ainda não fiado a
 * isto — pendência explícita no handoff desta fase para a Lyra/F4).
 */
function dispatchCommand(req: Request, res: Response, method: string, params: Record<string, unknown>): Promise<void> {
  return requireOwnedChargePoint(req).then((cp) => {
    const correlationId = randomUUID()
    logger.info({ chargePointId: cp.id, method, correlationId }, '[api] comando remoto disparado')

    sendCommand(cp.id, method, params, { timeoutMs: COMMAND_TIMEOUT_MS })
      .then((result) => logger.info({ chargePointId: cp.id, method, correlationId, result }, '[api] comando remoto concluído'))
      .catch((err) => logger.error({ err, chargePointId: cp.id, method, correlationId }, '[api] comando remoto falhou'))

    res.status(202).json({ correlationId, status: 'PENDING' })
  })
}

router.post(
  '/:id/commands/reset',
  validateBody(resetCommandSchema),
  asyncHandler((req, res) => dispatchCommand(req, res, 'Reset', req.body as Record<string, unknown>)),
)

router.post(
  '/:id/commands/unlock',
  validateBody(unlockCommandSchema),
  asyncHandler((req, res) => dispatchCommand(req, res, 'UnlockConnector', req.body as Record<string, unknown>)),
)

router.post(
  '/:id/commands/change-availability',
  validateBody(changeAvailabilitySchema),
  asyncHandler((req, res) => dispatchCommand(req, res, 'ChangeAvailability', req.body as Record<string, unknown>)),
)

router.post(
  '/:id/commands/trigger-message',
  validateBody(triggerMessageSchema),
  asyncHandler((req, res) => dispatchCommand(req, res, 'TriggerMessage', req.body as Record<string, unknown>)),
)

// ------------------------------------------------------------
// F4 (2026-09-17) — remote-start real: reaproveita a MESMA decisão de
// negócio do OCPP Authorize/StartTransaction (`avaliarInicioSessao`) ANTES
// de disparar o comando, porque aqui é o admin decidindo por um motorista —
// o carregador não tem chance de recusar por saldo/dívida sozinho (o idTag
// que vamos mandar é um AuthToken VIRTUAL recém-criado, sempre ACCEPTED).
// ------------------------------------------------------------

router.post(
  '/:id/commands/remote-start',
  validateBody(remoteStartCommandSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as RemoteStartCommandInput

    const chargePoint = await prisma.chargePoint.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!chargePoint) throw new AppError('Charge point não encontrado.', 404, 'CHARGE_POINT_NOT_FOUND')

    const connector = await prisma.connector.findUnique({
      where: { chargePointId_connectorId: { chargePointId: chargePoint.id, connectorId: body.connectorId } },
    })
    if (!connector) throw new AppError('Conector não encontrado.', 404, 'CONNECTOR_NOT_FOUND')

    const user = await prisma.user.findFirst({ where: { id: body.userId, role: 'DRIVER' } })
    if (!user) throw new AppError('Motorista não encontrado.', 404, 'USER_NOT_FOUND')

    const online = chargePoint.lastSeenAt !== null && Date.now() - chargePoint.lastSeenAt.getTime() < CHARGE_POINT_ONLINE_THRESHOLD_MS
    if (!online) throw new AppError('Charge point está offline.', 409, 'CHARGE_POINT_OFFLINE')

    if (connector.status !== 'AVAILABLE') throw new AppError('Conector ocupado.', 409, 'CONNECTOR_BUSY')

    const [openDebt, wallet] = await Promise.all([
      prisma.debt.findFirst({ where: { userId: user.id, status: 'OPEN' }, select: { id: true } }),
      prisma.wallet.findUnique({ where: { userId: user.id }, select: { id: true } }),
    ])

    let walletBalanceCents = 0
    if (wallet) {
      const lastEntry = await prisma.walletEntry.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        select: { balanceAfterCents: true },
      })
      walletBalanceCents = lastEntry?.balanceAfterCents ?? 0
    }

    const resultado = avaliarInicioSessao({
      token: { status: 'ACCEPTED', expiresAt: null, userId: user.id },
      now: new Date(),
      openDebt: !!openDebt,
      walletBalanceCents,
      minStartBalanceCents: env.WALLET_MIN_START_BALANCE_CENTS,
    })

    if (resultado.decision !== 'Accepted') {
      if (resultado.reason === 'OPEN_DEBT') throw new AppError('Motorista tem dívida em aberto.', 409, 'DRIVER_HAS_OPEN_DEBT')
      throw new AppError('Saldo insuficiente para iniciar a recarga.', 409, 'INSUFFICIENT_BALANCE')
    }

    const tariff = await resolveActiveTariff(connector, chargePoint)
    const estimatedMaxCostCents = calcularTetoReserva(
      { pricePerKwh: tariff.pricePerKwh?.toString() ?? null, pricePerMinute: tariff.pricePerMinute?.toString() ?? null, sessionFeeCents: tariff.sessionFeeCents },
      { maxPowerKw: connector.maxPowerKw?.toString() ?? null },
      { pisoCents: env.RESERVA_PISO_CENTS, tetoCents: env.RESERVA_TETO_CENTS },
    )

    // idTag VIRTUAL fresco por disparo — evita janela de reuso entre
    // remote-starts concorrentes do mesmo motorista. Limite de 20 chars do
    // protocolo (CiString20Type) — ver `ocpp/schemas/common.ts`.
    const idTag = `V${randomUUID().replace(/-/g, '')}`.slice(0, 20)
    await prisma.authToken.create({ data: { idTag, type: 'VIRTUAL', userId: user.id, status: 'ACCEPTED' } })

    const correlationId = randomUUID()
    logger.info({ chargePointId: chargePoint.id, connectorId: body.connectorId, userId: user.id, idTag, correlationId }, '[api] remote-start disparado')

    sendCommand(chargePoint.id, 'RemoteStartTransaction', { connectorId: body.connectorId, idTag }, { timeoutMs: COMMAND_TIMEOUT_MS })
      .then((result) => logger.info({ chargePointId: chargePoint.id, correlationId, result }, '[api] remote-start concluído'))
      .catch((err) => logger.error({ err, chargePointId: chargePoint.id, correlationId }, '[api] remote-start falhou'))

    res.status(202).json({ correlationId, status: 'PENDING', idTag, walletBalanceCents, estimatedMaxCostCents })
  }),
)

export default router
