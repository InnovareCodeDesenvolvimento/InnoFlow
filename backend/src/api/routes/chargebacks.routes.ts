import { Router } from 'express'
import { registrarChargeback } from '../../services/estornos/registrarChargeback'
import { resolverChargeback } from '../../services/estornos/resolverChargeback'
import { desbloquearCartaoPorChargeback } from '../../services/estornos/desbloquearCartaoPorChargeback'
import { listarChargebacks, lerChargeback, lerDossie } from '../../services/estornos/consultasChargebacks'
import { apenasAdmin, atorDe, descreverTentativa, exigirStepUp, requisicaoDe } from '../lib/rotaEstorno'
import { asyncHandler } from '../middleware/asyncHandler'
import { auditCtx } from '../middleware/auditTrail'
import { paymentReversalWriteRateLimit } from '../middleware/rateLimit'
import { validateBody, validateQuery } from '../middleware/validate'
import {
  createChargebackSchema,
  listChargebacksQuerySchema,
  unblockCardSchema,
  updateChargebackSchema,
  type CreateChargebackInput,
  type ListChargebacksQuery,
  type UnblockCardInput,
  type UpdateChargebackInput,
} from '../schemas/paymentReversals.schema'

/**
 * Chargeback manual assistido (L1.8, DL7) — ADMIN-ONLY. Contrato LITERAL: `CreateChargebackRequest`/`CreateChargebackResponse`, `UpdateChargebackRequest`/`ChargebackDTO`,
 * `ChargebackDossier` em `frontend/src/types/api.ts`; a LISTA e a leitura por id são ADITIVAS. O InnoFlow nunca "descobre sozinho" um chargeback (conta Cielo compartilhada, sem
 * webhook nosso): o ADMIN registra o aviso que a Cielo mandou ao dono. Nenhuma rota daqui fala com a Cielo.
 *
 * Dois prefixos de montagem em `app.ts`: `/api/admin/payments` (`paymentChargebacksRouter`) e `/api/admin/chargebacks` (`chargebacksRouter`).
 */

export const paymentChargebacksRouter = Router()

/**
 * `POST /api/admin/payments/:intentId/chargebacks` -> 201 `{ chargebackId, dossierId }`. O contrato NÃO lista step-up nem `currentPassword` aqui (só no PATCH): registrar abre o
 * caso e bloqueia o cartão — é reversível pelo desfecho `WON`, que SIM pede a senha. Rate limit de escrita aplicado.
 */
paymentChargebacksRouter.post(
  '/:intentId/chargebacks',
  ...apenasAdmin,
  paymentReversalWriteRateLimit,
  validateBody(createChargebackSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as CreateChargebackInput
    const paymentIntentId = req.params.intentId
    descreverTentativa(res, 'CHARGEBACK', 'chargeback:registered', 'PaymentIntent', paymentIntentId)
    const resultado = await registrarChargeback({
      paymentIntentId,
      amountCents: body.amountCents,
      notifiedAt: new Date(body.notifiedAt),
      caseReference: body.caseReference,
      reasonCode: body.reasonCode,
      responseDeadline: body.responseDeadline ? new Date(body.responseDeadline) : undefined,
      ator: await atorDe(req),
      requisicao: requisicaoDe(req),
    })
    auditCtx(res).describe({ skip: true })
    res.status(201).json(resultado)
  }),
)

export const chargebacksRouter = Router()

/** `GET /api/admin/chargebacks?outcome=&paymentIntentId=&page=&pageSize=` — lista paginada. ADITIVA. */
chargebacksRouter.get(
  '/',
  ...apenasAdmin,
  validateQuery(listChargebacksQuerySchema),
  asyncHandler(async (req, res) => {
    res.json(await listarChargebacks(req.query as unknown as ListChargebacksQuery))
  }),
)

/** `GET /api/admin/chargebacks/:id` -> `ChargebackDTO`. ADITIVA. */
chargebacksRouter.get(
  '/:id',
  ...apenasAdmin,
  asyncHandler(async (req, res) => {
    res.json(await lerChargeback(req.params.id))
  }),
)

/** `GET /api/admin/chargebacks/:id/dossier` -> JSON do snapshot. Ver o dossiê é auditável (mesmo sendo GET). */
chargebacksRouter.get(
  '/:id/dossier',
  ...apenasAdmin,
  asyncHandler(async (req, res) => {
    const dossie = await lerDossie(req.params.id)
    auditCtx(res).describe({ action: 'CHARGEBACK', actionDetail: 'dossier:view', entityType: 'PaymentReversal', entityId: req.params.id, forceAudit: true, changes: null })
    res.json(dossie)
  }),
)

/** `PATCH /api/admin/chargebacks/:id` -> 200 `ChargebackDTO`. Step-up de senha. */
chargebacksRouter.patch(
  '/:id',
  ...apenasAdmin,
  paymentReversalWriteRateLimit,
  validateBody(updateChargebackSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as UpdateChargebackInput
    const chargebackId = req.params.id
    await exigirStepUp(req, res, 'CHARGEBACK', chargebackId)
    descreverTentativa(res, 'CHARGEBACK', `chargeback:${body.outcome.toLowerCase()}`, 'PaymentReversal', chargebackId)
    const dto = await resolverChargeback({ chargebackId, outcome: body.outcome, debtPolicy: body.debtPolicy, ator: await atorDe(req), requisicao: requisicaoDe(req) })
    auditCtx(res).describe({ skip: true })
    res.json(dto)
  }),
)

/**
 * `POST /api/admin/chargebacks/:id/unblock-card` `{ reason, currentPassword }` -> 200 `ChargebackDTO` (P3, ADITIVA). Devolve o modo cartão ao motorista de um chargeback PERDIDO
 * (LOST/ACCEPTED), caso a caso; step-up de senha, motivo obrigatório (10 a 500), auditoria fail-closed. Não apaga o registro nem altera o dossiê. Erros: 400, 403 `INVALID_CURRENT_PASSWORD`,
 * 404 `NOT_FOUND`, 409 `CHARGEBACK_NOT_LOST` (aberto/ganho: nada a desbloquear), 409 `CARD_ALREADY_UNBLOCKED`.
 */
chargebacksRouter.post(
  '/:id/unblock-card',
  ...apenasAdmin,
  paymentReversalWriteRateLimit,
  validateBody(unblockCardSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as UnblockCardInput
    const chargebackId = req.params.id
    await exigirStepUp(req, res, 'CHARGEBACK', chargebackId)
    descreverTentativa(res, 'CHARGEBACK', 'chargeback:card_unblocked', 'PaymentReversal', chargebackId)
    const dto = await desbloquearCartaoPorChargeback({ chargebackId, reason: body.reason, ator: await atorDe(req), requisicao: requisicaoDe(req) })
    auditCtx(res).describe({ skip: true })
    res.json(dto)
  }),
)
