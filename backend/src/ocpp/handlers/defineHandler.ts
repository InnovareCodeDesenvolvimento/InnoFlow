import type { ZodType, ZodTypeDef } from 'zod'
import type { IHandlersOption } from 'ocpp-rpc'
import { parseOcppParams } from '../schemas/common'
import { withIdempotency } from '../idempotency'
import type { OcppHandlerCtx } from '../context'

/**
 * Fábrica de handler OCPP — junta em um lugar só as três coisas que TODO
 * handler do MVP precisa fazer (regra da Nova, ver decisoes-arquitetura-ocpp):
 * 1. Validar o payload com Zod próprio (nunca o schema embutido da lib).
 * 2. Rodar dentro de `withIdempotency` — log bruto + dedupe por
 *    `(chargePointId, ocppMessageId)`.
 * 3. Devolver exatamente o formato que `client.handle()` espera.
 */
export function defineOcppHandler<TParams, TResult extends Record<string, unknown>>(
  action: string,
  schema: ZodType<TParams, ZodTypeDef, unknown>,
  handler: (data: TParams, ctx: OcppHandlerCtx) => Promise<TResult>,
) {
  return (args: IHandlersOption, ctx: OcppHandlerCtx): Promise<TResult> => {
    const { params, messageId } = args
    if (!messageId) {
      throw new Error(`[ocpp] mensagem ${action} chegou sem messageId — impossível garantir idempotência`)
    }

    return withIdempotency<TResult>({
      chargePointId: ctx.chargePointId,
      operatorId: ctx.operatorId,
      ocppMessageId: messageId,
      action,
      rawPayload: params,
      run: () => {
        const data = parseOcppParams(schema, params, action)
        return handler(data, ctx)
      },
    })
  }
}
