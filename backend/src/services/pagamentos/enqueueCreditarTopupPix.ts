import { createQueue, CREDITAR_TOPUP_PIX_QUEUE_NAME, type CreditarTopupPixJobData } from '../../worker/queues'

/**
 * Enfileira o processamento de um webhook da Cielo já gravado em
 * `WebhookEvent` — mesmo padrão de `services/carteira/liquidarSessao.ts`
 * (`enqueueLiquidarSessaoRetry`). Nunca lança: falha ao enfileirar não pode
 * derrubar a resposta 200 já decidida para a Cielo (o `catch` de quem chama
 * já loga o suficiente) — o varredor de expiração é a rede de segurança se
 * este enqueue se perder.
 */
export async function enqueueCreditarTopupPix(webhookEventId: string): Promise<void> {
  const queue = createQueue(CREDITAR_TOPUP_PIX_QUEUE_NAME)
  try {
    const jobData: CreditarTopupPixJobData = { webhookEventId }
    await queue.add('creditar', jobData, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    })
  } finally {
    await queue.close()
  }
}
