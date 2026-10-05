import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import bcrypt from 'bcryptjs'
import type { ChargePoint, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { sendCommand } from '../../ocpp/commands'
import { iniciarSessaoRemota } from '../../services/sessao/iniciarSessaoRemota'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authenticate } from '../middleware/auth'
import { auditCtx } from '../middleware/auditTrail'
import { operatorScopeWhere, requireOperatorOrAdmin } from '../middleware/tenantScope'
import { requireRecargaRemotaPolicy } from '../middleware/recargaRemotaPolicy'
import { validateBody, validateQuery } from '../middleware/validate'
import { paginationMeta, paginationQuerySchema, type PaginationQuery } from '../schemas/pagination.schema'
import { createChargePointSchema, updateChargePointSchema, type CreateChargePointInput, type UpdateChargePointInput } from '../schemas/chargePoint.schema'
import { isChargePointOnline } from '../../core/estacoes/disponibilidade'
import { diffEntity } from '../../core/auditoria/diffEntity'
import { AUDIT_ALLOWLIST_BY_ENTITY } from '../lib/auditAllowlists'
import {
  changeAvailabilitySchema,
  remoteStartCommandSchema,
  resetCommandSchema,
  triggerMessageSchema,
  unlockCommandSchema,
  type RemoteStartCommandInput,
} from '../schemas/command.schema'
import { notificarRecargaIniciadaPeloSuporte } from '../../services/notificacoes/gatilhos'

const BCRYPT_ROUNDS = 10
const COMMAND_TIMEOUT_MS = 35_000

const router = Router()

router.use(authenticate, requireOperatorOrAdmin)

/**
 * NUNCA devolve `basicAuthSecretHash` — mesmo sendo hash, não tem por que sair da API.
 *
 * `online` (aditivo) é CALCULADO pelo servidor com a regra única `isChargePointOnline` (limiar de `lastSeenAt` + `disconnectedAt`) — o frontend NUNCA deve refazer essa conta
 * a partir de `lastSeenAt` (relógio do navegador diverge do servidor). `lastSeenAt`/`connectedAt`/`disconnectedAt` já iam no JSON (colunas do modelo) e seguem iguais.
 * Vale para TODAS as respostas que usam o DTO (lista, detalhe, criação, edição) — nas duas últimas `online` sai do próprio registro devolvido.
 */
function toChargePointDTO<T extends ChargePoint>(cp: T) {
  const { basicAuthSecretHash: _basicAuthSecretHash, ...rest } = cp
  return { ...rest, online: isChargePointOnline(cp) }
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

    auditCtx(res).describe({
      entityType: 'ChargePoint',
      entityId: cp.id,
      targetOperatorId: cp.operatorId,
      changes: diffEntity(null, cp, AUDIT_ALLOWLIST_BY_ENTITY.ChargePoint),
    })
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

    // `basicAuthSecret`/`basicAuthSecretHash` nunca entram no diff — nem
    // estão na allowlist de ChargePoint (ver auditAllowlists.ts). Trocar a
    // senha só aparece como "algo mudou" indiretamente pelo `updatedAt`, que
    // também não está na allowlist — decisão deliberada: o log de auditoria
    // não precisa provar QUANDO a senha mudou, só quem tinha acesso pra isso.
    auditCtx(res).describe({
      entityType: 'ChargePoint',
      entityId: cp.id,
      targetOperatorId: cp.operatorId,
      changes: diffEntity(existing, cp, AUDIT_ALLOWLIST_BY_ENTITY.ChargePoint),
    })
  }),
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.chargePoint.findFirst({ where: { id: req.params.id, ...operatorScopeWhere(req) } })
    if (!existing) throw new AppError('Charge point não encontrado.', 404, 'NOT_FOUND')
    const cp = await prisma.chargePoint.update({ where: { id: existing.id }, data: { active: false } })
    res.status(204).send()

    auditCtx(res).describe({
      entityType: 'ChargePoint',
      entityId: cp.id,
      targetOperatorId: cp.operatorId,
      changes: diffEntity(existing, cp, AUDIT_ALLOWLIST_BY_ENTITY.ChargePoint),
    })
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

    // Grava a INTENÇÃO (quem pediu o quê, com o correlationId), nunca o
    // resultado — o efeito é assíncrono e o append-only proíbe voltar e
    // atualizar a linha depois. O resultado real mora em `OcppMessage`/log,
    // correlacionado pelo mesmo `correlationId` (ver decisão 4 da Nova).
    auditCtx(res).describe({
      entityType: 'ChargePoint',
      entityId: cp.id,
      targetOperatorId: cp.operatorId,
      action: 'REMOTE_COMMAND',
      actionDetail: method,
      correlationId,
    })
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
//
// F6 (2026-09-17) — núcleo extraído para `services/sessao/iniciarSessaoRemota.ts`
// (reaproveitado por `POST /api/me/sessions/start`, PWA do motorista — ver
// decisoes-pwa-motorista.md §3). Esta rota só resolve o `userId` (o único
// passo que é exclusivo do admin: o motorista pode ser qualquer um, então
// precisa existir/ser DRIVER) e repassa o `operatorScopeWhere(req)` como
// filtro do charge point — mesmo comportamento/contrato de antes, mesmos
// códigos de erro, mesmos campos de resposta.
// ------------------------------------------------------------

router.post(
  '/:id/commands/remote-start',
  requireRecargaRemotaPolicy, // DL4: só ADMIN no lote 1 — ANTES da validação (um 403 não revela o formato do corpo). Regra em core/sessao/politicaRecargaRemota.ts
  validateBody(remoteStartCommandSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as RemoteStartCommandInput

    const user = await prisma.user.findFirst({ where: { id: body.userId, role: 'DRIVER' } })
    if (!user) throw new AppError('Motorista não encontrado.', 404, 'USER_NOT_FOUND')

    const resultado = await iniciarSessaoRemota({
      chargePointId: req.params.id,
      chargePointScope: operatorScopeWhere(req),
      connectorId: body.connectorId,
      userId: user.id,
    })

    res.status(202).json({
      correlationId: resultado.correlationId,
      status: 'PENDING',
      idTag: resultado.idTag,
      walletBalanceCents: resultado.walletBalanceCents,
      estimatedMaxCostCents: resultado.estimatedMaxCostCents,
    })

    // L1.6: transparência — o motorista é avisado por e-mail de que o SUPORTE pediu uma recarga na conta dele (entityId = correlationId; fire-and-forget, depois da resposta).
    notificarRecargaIniciadaPeloSuporte({ userId: user.id, correlationId: resultado.correlationId, chargePointId: req.params.id })

    // entityType/entityId já vêm certos do fallback (path começa com
    // `/api/admin/charge-points`, `:id` é o próprio charge point) — só
    // enriquece com o correlationId e quem foi o motorista-alvo (intenção,
    // não resultado — mesma regra do `dispatchCommand` acima).
    auditCtx(res).describe({
      action: 'REMOTE_COMMAND',
      // L1.5: quem (ator da linha), para quem (userId), POR QUÊ (reason, já aparado/validado) e `correlationId` ficam todos na mesma linha de auditoria.
      actionDetail: `RemoteStartTransaction (userId=${user.id}, reason=${body.reason})`,
      correlationId: resultado.correlationId,
    })
  }),
)

export default router
