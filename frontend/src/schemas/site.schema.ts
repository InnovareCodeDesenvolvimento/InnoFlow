import { z } from "zod"

// Espelha backend/src/api/schemas/site.schema.ts.
export const siteFormSchema = z.object({
  // Só usado quando quem cria é ADMIN — ver SiteFormDialog.tsx.
  operatorId: z.string().trim().optional(),
  name: z.string().trim().min(1, "Informe o nome.").max(150),
  addressLine: z.string().trim().min(1, "Informe o endereço.").max(200),
  city: z.string().trim().min(1, "Informe a cidade.").max(100),
  state: z.string().trim().length(2, "Use a sigla da UF (2 letras)."),
  postalCode: z.string().trim().min(5, "CEP inválido.").max(12),
  country: z.string().trim().length(2).default("BR"),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  timezone: z.string().trim().min(1).max(60).default("America/Sao_Paulo"),
  active: z.boolean().optional(),
})
export type SiteFormValues = z.infer<typeof siteFormSchema>
// Tipo de ENTRADA (pré-coerção) — `latitude`/`longitude` chegam como string
// do <input type="number">. Necessário para tipar `useForm` corretamente com
// zodResolver quando o schema usa `z.coerce` (RHF valida o que o campo
// digita, não o que o Zod devolve depois de convertido).
export type SiteFormInput = z.input<typeof siteFormSchema>
