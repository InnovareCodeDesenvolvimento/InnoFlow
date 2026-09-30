import { z } from 'zod'

/**
 * Corpo do "Post de Notificação" da Cielo (webhook) — formato mínimo e
 * estável da API 3.0: `PaymentId` (o `PaymentId` que identifica o pagamento
 * na Cielo) e `ChangeType` (1 status, 5 cancelamento negado, 7 chargeback,
 * 25 estorno parcial — ver comentário do model `WebhookEvent`). NUNCA
 * confiamos em mais nada do corpo (decisão §3 da Nova: o corpo é só uma
 * DICA, sempre reconsultamos a Cielo antes de agir) — por isso o schema é
 * enxuto de propósito, sem tentar validar campos que não vamos usar.
 */
export const webhookCieloBodySchema = z.object({
  PaymentId: z.string().trim().min(1).max(64),
  ChangeType: z.coerce.number().int(),
})
export type WebhookCieloBody = z.infer<typeof webhookCieloBodySchema>
