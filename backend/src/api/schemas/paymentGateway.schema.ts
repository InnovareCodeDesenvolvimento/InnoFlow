import { z } from 'zod'
import { SEGREDO_WEBHOOK_TAMANHO_MINIMO } from '../../core/pagamentos/verificarSegredoWebhook'

/**
 * `PUT /api/admin/payment-gateway` (F5.5) — contrato literal de `UpdatePaymentGatewayConfigRequest`
 * (`frontend/src/types/api.ts`). Campo ausente = "não mexer". `.strict()`: campo desconhecido é 400 (nada de
 * ignorar em silêncio um typo como `merchantkey`). Segredos nunca são trimados/alterados além de `trim()` de
 * bordas — colar com espaço/quebra de linha no fim é o erro mais comum e quebraria a autenticação na Cielo.
 */
export const updatePaymentGatewayConfigSchema = z
  .object({
    environment: z.enum(['sandbox', 'production']).optional(),
    merchantId: z.string().trim().min(1).max(128).optional(),
    merchantKey: z.string().trim().min(1).max(512).optional(),
    sopClientId: z.string().trim().min(1).max(256).optional(),
    sopClientSecret: z.string().trim().min(1).max(512).optional(),
    // Mínimo 32 (B2, F5.7): é a única autenticação do webhook — o gerador da tela (frontend) já faz 40 caracteres.
    webhookHeaderSecret: z.string().trim().min(SEGREDO_WEBHOOK_TAMANHO_MINIMO, `O segredo do webhook precisa ter ao menos ${SEGREDO_WEBHOOK_TAMANHO_MINIMO} caracteres.`).max(256).optional(),
    cardEnabled: z.boolean().optional(),
    pixEnabled: z.boolean().optional(),
    confirmProduction: z.literal(true).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((k) => k !== 'confirmProduction'), { message: 'Informe ao menos um campo para alterar.' })

export type UpdatePaymentGatewayConfigInput = z.infer<typeof updatePaymentGatewayConfigSchema>
