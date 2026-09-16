import { z, type ZodType } from 'zod'
import { createRPCError } from 'ocpp-rpc'

/**
 * Schemas Zod PRÓPRIOS para as mensagens OCPP 1.6-J do MVP — deliberadamente
 * não confiamos no validador embutido do `ocpp-rpc` (strictMode/JSON Schema
 * interno da lib). Razão: queremos controle total sobre a mensagem de erro,
 * o código RPC devolvido ao carregador, e a forma dos dados que chegam ao
 * `core/` — sem depender de uma versão de schema que a lib decidiu embutir.
 */

// idTag OCPP 1.6 é limitado a 20 caracteres (IdToken CiString20Type).
export const idTagSchema = z.string().min(1).max(20)

// Datas no protocolo vêm como string ISO8601. Aceitamos qualquer string que
// o `Date` consiga parsear e convertemos para `Date` de verdade — é este
// valor (nunca `Date.now()`) que vira `startedAt`/`ts`/`occurredAt` etc.
export const ocppDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'timestamp OCPP inválido (esperado ISO8601)' })
  .transform((s) => new Date(s))

/**
 * Valida `raw` contra `schema`; em caso de falha, traduz o `ZodError` para um
 * RPCError OCPP ("FormationViolation"/"PropertyConstraintViolation") em vez
 * de deixar o `ZodError` cru estourar para dentro do `ocpp-rpc` (que só sabe
 * coagir `Error` genérico para um erro RPC igualmente genérico).
 */
// `ZodType<T, ZodTypeDef, any>` (em vez de `ZodSchema<T>` = `ZodType<T, ZodTypeDef, T>`)
// de propósito: vários schemas OCPP têm `.transform()` (ex. `ocppDateTime`,
// string -> Date), onde o tipo de ENTRADA diverge do tipo de SAÍDA — com
// `ZodSchema<T>` o TS exige Input===Output===T e rejeita esses schemas.
export function parseOcppParams<T>(schema: ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, action: string): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw createRPCError(
      'FormationViolation',
      `Payload de ${action} inválido: ${result.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`,
      { issues: result.error.issues },
    )
  }
  return result.data
}
