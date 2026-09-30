import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { verificarSegredoWebhookConstante } from '../../core/pagamentos/verificarSegredoWebhook'
import { getCieloWebhookHeaderSecret, getCieloWebhookPathToken } from '../../services/pagamentos/webhookCieloSecrets'
import { enqueueCreditarTopupPix } from '../../services/pagamentos/enqueueCreditarTopupPix'
import { asyncHandler } from '../middleware/asyncHandler'
import { AppError } from '../middleware/errorHandler'
import { validateBody } from '../middleware/validate'
import { webhookCieloBodySchema, type WebhookCieloBody } from '../schemas/webhookCielo.schema'

/**
 * `POST /api/webhooks/cielo/:pathToken` — rota PÚBLICA (sem `authenticate`,
 * fora de `/api/admin` — não passa pelo `auditTrail()`). Webhook = DICA,
 * NUNCA verdade (decisão §3 da Nova): grava a caixa de entrada
 * (`WebhookEvent`), responde 200 na hora, e o processamento REAL
 * (reconsultar a Cielo antes de creditar) vai para o worker
 * (`worker/jobs/creditarTopupPixJob.ts`).
 *
 * Dois segredos com papéis DIFERENTES:
 * - `pathToken` (segmento da URL) é só ROTEAMENTO — comparação simples
 *   (`===`). Não é o mecanismo de defesa: ele aparece em log de acesso,
 *   histórico de proxy, etc.
 * - Header estático (nome combinado no painel da Cielo, valor em
 *   `CIELO_WEBHOOK_HEADER_SECRET`) é o segredo DE VERDADE — comparado em
 *   TEMPO CONSTANTE (`verificarSegredoWebhookConstante`).
 */
const router = Router()

const WEBHOOK_SECRET_HEADER_NAME = 'x-innoelektron-webhook-secret'

router.post(
  '/:pathToken',
  validateBody(webhookCieloBodySchema),
  asyncHandler(async (req, res) => {
    if (req.params.pathToken !== getCieloWebhookPathToken()) {
      // 404 (não 401): não confirma nem nega que "existe uma rota de webhook
      // aqui" para quem não sabe o token — mesma filosofia anti-enumeração
      // do resto da API.
      throw new AppError('Rota não encontrada.', 404, 'NOT_FOUND')
    }

    const headerSecret = req.header(WEBHOOK_SECRET_HEADER_NAME)
    if (!verificarSegredoWebhookConstante(headerSecret, getCieloWebhookHeaderSecret())) {
      logger.warn({ paymentId: (req.body as WebhookCieloBody).PaymentId }, '[webhook][cielo] segredo do header ausente/inválido — rejeitado')
      throw new AppError('Não autorizado.', 401, 'UNAUTHORIZED')
    }

    const body = req.body as WebhookCieloBody
    logger.info({ paymentId: body.PaymentId, changeType: body.ChangeType }, '[webhook][cielo] notificação recebida')

    // PaymentId/evento desconhecido AINDA recebe 200 (só com log) — nunca
    // devolver erro para a Cielo por um PaymentId que não reconhecemos, ou
    // ela reenvia em rajada (tempestade de retentativa).
    const intent = await prisma.paymentIntent.findUnique({ where: { cieloPaymentId: body.PaymentId }, select: { id: true } })

    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        provider: 'CIELO',
        externalId: body.PaymentId,
        changeType: body.ChangeType,
        paymentIntentId: intent?.id ?? null,
        payload: body,
      },
    })

    if (intent) {
      await enqueueCreditarTopupPix(webhookEvent.id).catch((err) =>
        logger.error({ err, webhookEventId: webhookEvent.id }, '[webhook][cielo] falha ao enfileirar processamento — o varredor de expiração ainda cobre este intent mais tarde'),
      )
    } else {
      logger.warn({ paymentId: body.PaymentId }, '[webhook][cielo] PaymentId desconhecido — evento gravado, nada a processar')
    }

    res.status(200).json({ received: true })
  }),
)

export default router
