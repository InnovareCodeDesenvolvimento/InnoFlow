/** Sobe só o `env.ts` num processo próprio (Íris, rodada 2): imprime BOOT-OK se o `loadEnv` aceitou a configuração; em produção com segredo de webhook curto o processo SAI com código 1. */
import { env } from '../../../src/lib/env'

console.log(`BOOT-OK node_env=${env.NODE_ENV} timeout=${env.CIELO_TIMEOUT_MS} query_timeout=${env.CIELO_QUERY_TIMEOUT_MS}`)
process.exit(0)
