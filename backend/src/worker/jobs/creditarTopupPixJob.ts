import { Worker, type Job } from 'bullmq'
import { createRedisConnection } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { prisma } from '../../lib/prisma'
import { creditarTopupPix } from '../../services/pagamentos/creditarTopupPix'
import { getPagamentoPort } from '../../services/pagamentos/pagamentoPortInstance'
import { emitTopupUpdated, emitWalletUpdated } from '../../realtime/emit'
import { CREDITAR_TOPUP_PIX_QUEUE_NAME, type CreditarTopupPixJobData } from '../queues'

/**
 * Processa o webhook da Cielo já gravado em `WebhookEvent`
 * (`api/routes/webhooksCielo.routes.ts`). `creditarTopupPix` já é
 * idempotente por construção — reprocessar o mesmo job (retry do BullMQ,
 * reentrega, ou webhook duplicado da própria Cielo) nunca credita duas
 * vezes.
 */
export function startCreditarTopupPixWorker(): Worker<CreditarTopupPixJobData> {
  const worker = new Worker<CreditarTopupPixJobData>(
    CREDITAR_TOPUP_PIX_QUEUE_NAME,
    async (job: Job<CreditarTopupPixJobData>) => {
      const webhookEvent = await prisma.webhookEvent.findUnique({ where: { id: job.data.webhookEventId } })
      if (!webhookEvent) {
        logger.warn({ webhookEventId: job.data.webhookEventId }, '[worker][creditar-topup-pix] WebhookEvent não encontrado — nada a fazer')
        return
      }
      if (webhookEvent.processedAt) {
        return // já processado (reentrega tardia do BullMQ) — idempotência de nível de evento
      }
      if (!webhookEvent.paymentIntentId) {
        // PaymentId desconhecido no momento em que o webhook chegou (ver
        // rota) — nada a creditar por este evento; o varredor de expiração
        // continua sendo a rede de segurança para o intent real, se existir.
        await prisma.webhookEvent.update({ where: { id: webhookEvent.id }, data: { processedAt: new Date() } })
        return
      }

      try {
        const resultado = await creditarTopupPix(webhookEvent.paymentIntentId, getPagamentoPort())
        if (resultado) {
          await Promise.all([emitWalletUpdated(resultado.userId, resultado.balanceAfterCents), emitTopupUpdated(resultado.userId, resultado.paymentIntentId, 'PAID')]).catch((err) =>
            logger.error({ err, webhookEventId: webhookEvent.id }, '[worker][creditar-topup-pix] falha ao publicar eventos de tempo real (não bloqueante)'),
          )
        }
        await prisma.webhookEvent.update({ where: { id: webhookEvent.id }, data: { processedAt: new Date() } })
      } catch (err) {
        await prisma.webhookEvent
          .update({ where: { id: webhookEvent.id }, data: { attempts: { increment: 1 }, processingError: err instanceof Error ? err.message : String(err) } })
          .catch((updateErr) => logger.error({ err: updateErr, webhookEventId: webhookEvent.id }, '[worker][creditar-topup-pix] falha ao gravar processingError (não bloqueante)'))
        throw err // deixa o BullMQ reagendar o retry
      }
    },
    { connection: createRedisConnection(), concurrency: 5 },
  )

  worker.on('failed', (job, err) => {
    logger.error({ err, webhookEventId: job?.data.webhookEventId, attemptsMade: job?.attemptsMade }, '[worker][creditar-topup-pix] job falhou')
  })
  worker.on('completed', (job) => {
    logger.info({ webhookEventId: job.data.webhookEventId }, '[worker][creditar-topup-pix] job concluído')
  })

  logger.info('[worker][creditar-topup-pix] worker ativo')
  return worker
}
