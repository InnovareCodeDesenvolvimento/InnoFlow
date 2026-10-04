import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { verificarSegredoWebhookConstante } from '../../core/pagamentos/verificarSegredoWebhook'
import { ehPingDeValidacaoDaCielo } from '../../core/pagamentos/pingWebhookCielo'
import { getCieloWebhookHeaderSecret, getCieloWebhookPathToken, WEBHOOK_SECRET_HEADER_NAME } from '../../services/pagamentos/webhookCieloSecrets'
import { enqueueCreditarTopupPix } from '../../services/pagamentos/enqueueCreditarTopupPix'
import { asyncHandler } from '../middleware/asyncHandler'
import { ConfiguracaoGatewayIndisponivelError } from '../../core/pagamentos/erros'
import { AppError } from '../middleware/errorHandler'
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
 * - Header estático (nome combinado no painel da Cielo; valor salvo na tela do
 *   gateway (banco, F5.5) ou, na falta, em `CIELO_WEBHOOK_HEADER_SECRET`) é o segredo DE VERDADE — comparado em
 *   TEMPO CONSTANTE (`verificarSegredoWebhookConstante`).
 */
const router = Router()

/** S-4: tempo constante (o token do caminho é a 1ª barreira da rota pública). Tamanhos diferentes => falso sem comparar. */
function tokenDoCaminhoConfere(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido, 'utf8')
  const b = Buffer.from(esperado, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

router.post(
  '/:pathToken',
  asyncHandler(async (req, res) => {
    if (!tokenDoCaminhoConfere(req.params.pathToken, getCieloWebhookPathToken())) {
      // 404 (não 401): não confirma nem nega que "existe uma rota de webhook
      // aqui" para quem não sabe o token — mesma filosofia anti-enumeração
      // do resto da API.
      throw new AppError('Rota não encontrada.', 404, 'NOT_FOUND')
    }

    // PING de validação da URL (C1.4, F26): a Cielo testa a URL ao salvá-la, com um POST sem PaymentId/ChangeType, e exige 200. Vem DEPOIS do
    // token do caminho (quem não o conhece segue recebendo 404) e ANTES da validação do corpo (que daria 400). Nada é lido nem gravado: não há
    // o que processar. Um PaymentId presente porém malformado NÃO é ping — cai na validação abaixo e dá 400.
    if (ehPingDeValidacaoDaCielo(req.body)) {
      logger.info('[webhook][cielo] ping de validação da URL (sem PaymentId/ChangeType) — respondido 200, nada a processar')
      res.status(200).json({ received: true })
      return
    }

    const headerSecret = req.header(WEBHOOK_SECRET_HEADER_NAME)
    let segredoEsperado: string
    try {
      segredoEsperado = await getCieloWebhookHeaderSecret()
    } catch (err) {
      // Config ilegível/segredo não decifra: 503 (a Cielo reenvia) — nunca aceitar/rejeitar contra um segredo que não é o cadastrado.
      if (err instanceof ConfiguracaoGatewayIndisponivelError) throw new AppError('Serviço temporariamente indisponível.', 503, 'SERVICE_UNAVAILABLE')
      throw err
    }
    if (!verificarSegredoWebhookConstante(headerSecret, segredoEsperado)) {
      logger.warn('[webhook][cielo] segredo do header ausente/inválido — rejeitado')
      throw new AppError('Não autorizado.', 401, 'UNAUTHORIZED')
    }

    const body: WebhookCieloBody = webhookCieloBodySchema.parse(req.body)
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
