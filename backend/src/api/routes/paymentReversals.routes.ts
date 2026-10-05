import { Router } from 'express'
import { registrarEstornoSessao } from '../../services/estornos/registrarEstornoSessao'
import { cancelarEstornoPortal } from '../../services/estornos/cancelarEstornoPortal'
import { confirmarEstornoPortalManual } from '../../services/estornos/confirmarEstornoPortalManual'
import { listarEstornosDaSessao } from '../../services/estornos/consultasEstornos'
import { apenasAdmin, atorDe, descreverTentativa, exigirStepUp, requisicaoDe } from '../lib/rotaEstorno'
import { asyncHandler } from '../middleware/asyncHandler'
import { auditCtx } from '../middleware/auditTrail'
import { paymentReversalWriteRateLimit } from '../middleware/rateLimit'
import { validateBody, validateQuery } from '../middleware/validate'
import { cancelRefundSchema, confirmRefundSchema, createSessionRefundSchema, listRefundsQuerySchema, type ConfirmRefundInput, type CreateSessionRefundInput, type ListRefundsQuery } from '../schemas/paymentReversals.schema'

/**
 * Estorno de sessão (L1.8) — ADMIN-ONLY, escritas com STEP-UP de senha do ADMIN (mesmo mecanismo do gateway, `exigirSenhaAtual`). Contrato LITERAL em
 * `frontend/src/types/api.ts` (`CreateSessionRefundRequest`/`CreateSessionRefundResponse`/`SessionRefundErrorCode`); a LEITURA por sessão e o cancelamento do
 * registro são ADITIVOS (a tela precisa listar o que está pendente). Ordem de erros das escritas: 400 validação -> 403 senha -> 404/409 regra.
 *
 * Dois prefixos de montagem em `app.ts` (cada um com `adminRateLimit`): `/api/admin/sessions` (`sessionRefundsRouter`) e `/api/admin/refunds` (`refundsRouter`).
 * NENHUMA rota daqui fala com a Cielo (DL8). Auditoria: as escritas gravam a própria linha FAIL-CLOSED dentro da transação do dinheiro (`skip` evita o middleware
 * duplicar); senha errada e recusas de regra caem no middleware genérico com `action=REFUND`.
 */

export const sessionRefundsRouter = Router()

/** `POST /api/admin/sessions/:id/refunds` -> 201 `{ refundId, status }`. */
sessionRefundsRouter.post(
  '/:id/refunds',
  ...apenasAdmin,
  paymentReversalWriteRateLimit,
  validateBody(createSessionRefundSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as CreateSessionRefundInput
    const sessionId = req.params.id
    await exigirStepUp(req, res, 'REFUND', null)
    descreverTentativa(res, 'REFUND', body.destination === 'WALLET' ? 'refund:wallet' : 'refund:card_via_portal', 'ChargingSession', sessionId)

    const resultado = await registrarEstornoSessao({
      sessionId,
      amountCents: body.amountCents,
      reason: body.reason,
      destination: body.destination,
      portalReference: body.portalReference,
      ator: await atorDe(req),
      requisicao: requisicaoDe(req),
    })
    auditCtx(res).describe({ skip: true }) // a linha de auditoria JÁ foi gravada (fail-closed, na transação do estorno)
    res.status(201).json(resultado)
  }),
)

/** `GET /api/admin/sessions/:id/refunds` — o que já foi estornado e quanto ainda dá (para a tela da sessão). ADITIVA. */
sessionRefundsRouter.get(
  '/:id/refunds',
  ...apenasAdmin,
  validateQuery(listRefundsQuerySchema),
  asyncHandler(async (req, res) => {
    const filtro = req.query as unknown as ListRefundsQuery
    const r = await listarEstornosDaSessao(req.params.id)
    const items = filtro.status ? r.items.filter((i) => i.status === filtro.status) : r.items
    res.json({ ...r, items })
  }),
)

export const refundsRouter = Router()

/**
 * `POST /api/admin/refunds/:id/confirm` -> 200 `{ refundId, status: "CONFIRMED", confirmedManually: true, proofReference }`. ADITIVA. Só devolução no cartão ainda `PENDING_CONFIRMATION`
 * (estorno parcial ou venda fora da janela de reconsulta, que o job nunca confirma). 409 `REFUND_NOT_CONFIRMABLE` no resto.
 */
refundsRouter.post(
  '/:id/confirm',
  ...apenasAdmin,
  paymentReversalWriteRateLimit,
  validateBody(confirmRefundSchema),
  asyncHandler(async (req, res) => {
    const refundId = req.params.id
    const { proofReference } = req.body as ConfirmRefundInput
    await exigirStepUp(req, res, 'REFUND', refundId)
    descreverTentativa(res, 'REFUND', 'refund:manually_confirmed', 'PaymentReversal', refundId)
    const resultado = await confirmarEstornoPortalManual({ refundId, proofReference, ator: await atorDe(req), requisicao: requisicaoDe(req) })
    auditCtx(res).describe({ skip: true })
    res.json(resultado)
  }),
)

/** `POST /api/admin/refunds/:id/cancel` -> 200 `{ refundId, status: "CANCELLED" }`. ADITIVA. Só devolução no cartão ainda `PENDING_CONFIRMATION`. */
refundsRouter.post(
  '/:id/cancel',
  ...apenasAdmin,
  paymentReversalWriteRateLimit,
  validateBody(cancelRefundSchema),
  asyncHandler(async (req, res) => {
    const refundId = req.params.id
    await exigirStepUp(req, res, 'REFUND', refundId)
    descreverTentativa(res, 'REFUND', 'refund:cancelled', 'PaymentReversal', refundId)
    const resultado = await cancelarEstornoPortal({ refundId, ator: await atorDe(req), requisicao: requisicaoDe(req) })
    auditCtx(res).describe({ skip: true })
    res.json(resultado)
  }),
)
