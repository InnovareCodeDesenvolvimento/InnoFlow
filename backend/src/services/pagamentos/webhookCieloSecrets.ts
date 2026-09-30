import { randomUUID } from 'node:crypto'
import { env } from '../../lib/env'

/**
 * Mesmo padrão de `OCPP_NODE_ID` (`ocpp/registry.ts`: `env.OCPP_NODE_ID ||
 * randomUUID()`) — resolvido UMA VEZ por processo, não no schema do
 * `env.ts` (ver comentário lá). Sem configurar `CIELO_WEBHOOK_PATH_TOKEN`/
 * `CIELO_WEBHOOK_HEADER_SECRET`, a rota fica com um segredo aleatório
 * diferente a cada boot — inacessível de fora até alguém configurar de
 * verdade no `.env`/EasyPanel E no painel da Cielo.
 */
const PATH_TOKEN = env.CIELO_WEBHOOK_PATH_TOKEN || randomUUID()
const HEADER_SECRET = env.CIELO_WEBHOOK_HEADER_SECRET || randomUUID()

export function getCieloWebhookPathToken(): string {
  return PATH_TOKEN
}

export function getCieloWebhookHeaderSecret(): string {
  return HEADER_SECRET
}
