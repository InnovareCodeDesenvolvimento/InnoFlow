import { z } from 'zod'

export const tariffAssignmentScopeEnum = z.enum(['CONNECTOR', 'CHARGE_POINT', 'SITE', 'OPERATOR'])

/** Qual campo de referência cada `scope` exige — os outros dois têm que ficar ausentes. */
const TARGET_FIELD_BY_SCOPE: Record<z.infer<typeof tariffAssignmentScopeEnum>, 'connectorId' | 'chargePointId' | 'siteId' | null> = {
  CONNECTOR: 'connectorId',
  CHARGE_POINT: 'chargePointId',
  SITE: 'siteId',
  OPERATOR: null,
}

const TARGET_FIELDS = ['connectorId', 'chargePointId', 'siteId'] as const

const baseTariffAssignmentSchema = z.object({
  operatorId: z.string().cuid().optional(), // ADMIN only — idem tariff/site.schema
  tariffId: z.string().cuid(),
  scope: tariffAssignmentScopeEnum,
  connectorId: z.string().cuid().optional(),
  chargePointId: z.string().cuid().optional(),
  siteId: z.string().cuid().optional(),
  priority: z.number().int().min(0).default(0),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
})

/**
 * `resolveActiveTariff` (`ocpp/tariffResolution.ts`) confia cegamente no
 * campo do escopo declarado (`scope=CONNECTOR` -> olha só `connectorId`) —
 * por isso o schema tem que garantir, na entrada, que exatamente o campo
 * certo veio preenchido e os outros dois vieram ausentes. Uma
 * TariffAssignment "CONNECTOR" carregando também um `siteId` de outro site
 * seria ambígua e nunca detectada depois, porque a query de resolução nem
 * olha esse campo extra.
 */
function checkScopeTarget(data: { scope: z.infer<typeof tariffAssignmentScopeEnum>; connectorId?: string; chargePointId?: string; siteId?: string }, ctx: z.RefinementCtx) {
  const requiredField = TARGET_FIELD_BY_SCOPE[data.scope]

  for (const field of TARGET_FIELDS) {
    const present = data[field] !== undefined
    const shouldBePresent = field === requiredField
    if (shouldBePresent && !present) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} é obrigatório quando scope=${data.scope}.` })
    }
    if (!shouldBePresent && present) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} não deve ser informado quando scope=${data.scope}.` })
    }
  }
}

function checkValidityWindow(data: { validFrom?: Date; validTo?: Date | null }, ctx: z.RefinementCtx) {
  if (data.validFrom && data.validTo && data.validTo <= data.validFrom) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validTo'], message: 'validTo deve ser posterior a validFrom.' })
  }
}

export const createTariffAssignmentSchema = baseTariffAssignmentSchema.superRefine((data, ctx) => {
  checkScopeTarget(data, ctx)
  checkValidityWindow(data, ctx)
})

// scope/connectorId/chargePointId/siteId são imutáveis após criados — mudar
// o alvo de uma atribuição é semanticamente criar outra (evita o mesmo tipo
// de ambiguidade que `checkScopeTarget` previne na criação). Só reapontar
// para outra tarifa, reordenar prioridade ou ajustar a janela de validade.
export const updateTariffAssignmentSchema = z
  .object({
    tariffId: z.string().cuid().optional(),
    priority: z.number().int().min(0).optional(),
    validFrom: z.coerce.date().optional(),
    validTo: z.coerce.date().nullable().optional(),
  })
  .superRefine((data, ctx) => checkValidityWindow(data, ctx))

export const tariffAssignmentQuerySchema = z.object({
  tariffId: z.string().cuid().optional(),
  siteId: z.string().cuid().optional(),
  chargePointId: z.string().cuid().optional(),
  connectorId: z.string().cuid().optional(),
  scope: tariffAssignmentScopeEnum.optional(),
})

export type CreateTariffAssignmentInput = z.infer<typeof createTariffAssignmentSchema>
export type UpdateTariffAssignmentInput = z.infer<typeof updateTariffAssignmentSchema>
export type TariffAssignmentFilterQuery = z.infer<typeof tariffAssignmentQuerySchema>
