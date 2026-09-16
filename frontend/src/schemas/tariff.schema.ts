import { z } from "zod"
import { TARIFF_MODELS } from "@/types/api"

/**
 * Espelha backend/src/api/schemas/tariff.schema.ts — com uma diferença
 * deliberada: no formulário, `sessionFeeCents`/`minChargeCents`/
 * `idleFeePerMinute` são digitados em REAIS (mais natural para quem
 * preenche) e convertidos para centavos só no submit (ver TariffForm.tsx,
 * `reaisToCents`). O contrato da API continua em centavos inteiros.
 */
export const tariffFormSchema = z.object({
  // Só usado quando quem cria é ADMIN — ver TariffFormDialog.tsx.
  operatorId: z.string().trim().optional(),
  name: z.string().trim().min(1, "Informe o nome da tarifa.").max(100),
  model: z.enum(TARIFF_MODELS, { message: "Selecione o modelo de cobrança." }),
  pricePerKwh: z.coerce.number().min(0).optional(),
  pricePerMinute: z.coerce.number().min(0).optional(),
  sessionFeeReais: z.coerce.number().min(0).optional(),
  minChargeReais: z.coerce.number().min(0).optional(),
  idleFeePerMinuteReais: z.coerce.number().min(0).default(0),
  idleGracePeriodSeconds: z.coerce.number().int().min(0).default(0),
  currency: z.string().trim().length(3).default("BRL"),
  active: z.boolean().optional(),
})
export type TariffFormValues = z.infer<typeof tariffFormSchema>
export type TariffFormInput = z.input<typeof tariffFormSchema>
