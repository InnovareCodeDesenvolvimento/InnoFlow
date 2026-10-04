import { z } from "zod"
import { TARIFF_ASSIGNMENT_SCOPES } from "@/types/api"

/**
 * Espelha `backend/src/api/schemas/tariffAssignment.schema.ts`, em linguagem de formulário:
 *  - o servidor exige EXATAMENTE o campo de alvo do escopo (`connectorId` | `chargePointId` | `siteId`; `OPERATOR` não tem) e
 *    recusa os outros dois — aqui isso vira UM campo `targetId` que `buildCreatePayload` distribui no campo certo, então a
 *    combinação inválida nem consegue ser montada pela tela;
 *  - `priority`: inteiro >= 0 (padrão 0);
 *  - vigência opcional como DATA (`YYYY-MM-DD`); o servidor exige `validTo` posterior a `validFrom`.
 */
export const tariffAssignmentFormSchema = z
  .object({
    tariffId: z.string().min(1, "Selecione a tarifa."),
    scope: z.enum(TARIFF_ASSIGNMENT_SCOPES, { message: "Selecione onde a tarifa vale." }),
    targetId: z.string().optional(),
    priority: z.coerce.number({ message: "Informe a prioridade." }).int("Use um número inteiro.").min(0, "A prioridade não pode ser negativa.").default(0),
    validFrom: z.string().optional(),
    validTo: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scope !== "OPERATOR" && !data.targetId) {
      const message = { CONNECTOR: "Selecione a tomada.", CHARGE_POINT: "Selecione o carregador.", SITE: "Selecione o local." }[data.scope]
      ctx.addIssue({ code: "custom", path: ["targetId"], message })
    }
    if (data.validFrom && data.validTo && data.validTo < data.validFrom) {
      ctx.addIssue({ code: "custom", path: ["validTo"], message: "A data final não pode ser anterior à inicial." })
    }
  })

export type TariffAssignmentFormValues = z.infer<typeof tariffAssignmentFormSchema>
export type TariffAssignmentFormInput = z.input<typeof tariffAssignmentFormSchema>
