import { randomUUID } from 'node:crypto'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { decryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { ConfiguracaoGatewayIndisponivelError } from '../../core/pagamentos/erros'
import { getConfigEfetiva } from './gatewayConfig'

/**
 * Nome do header (minúsculo, como o Node entrega) em que a Cielo deve ecoar o segredo — constante do
 * servidor, mostrada na tela do gateway (`webhookHeaderName`) e lida por `webhooksCielo.routes.ts`.
 */
export const WEBHOOK_SECRET_HEADER_NAME = 'x-innoelektron-webhook-secret'

/**
 * Mesmo padrão de `OCPP_NODE_ID` (`ocpp/registry.ts`: `env.OCPP_NODE_ID || randomUUID()`) — resolvido UMA VEZ
 * por processo, não no schema do `env.ts` (ver comentário lá). Sem configurar `CIELO_WEBHOOK_PATH_TOKEN`, a
 * rota fica com um token aleatório diferente a cada boot — inacessível de fora até alguém configurar de
 * verdade no `.env`/EasyPanel E no painel da Cielo. O caminho do webhook continua SÓ no env do servidor.
 */
const PATH_TOKEN = env.CIELO_WEBHOOK_PATH_TOKEN || randomUUID()
const HEADER_SECRET_FALLBACK = env.CIELO_WEBHOOK_HEADER_SECRET || randomUUID()

export function getCieloWebhookPathToken(): string {
  return PATH_TOKEN
}

/**
 * Segredo do header, na precedência F5.5: BANCO (decifrado na hora) > `CIELO_WEBHOOK_HEADER_SECRET` > aleatório
 * por processo (inalcançável de fora — fail-closed). Se há segredo no banco e ele NÃO decifra, lança
 * `ConfiguracaoGatewayIndisponivelError` (a rota responde 503): cair para o env/aleatório aqui aceitaria ou
 * rejeitaria um segredo que NÃO é o que o dono cadastrou na Cielo — e o webhook é só uma "dica" (o worker
 * reconsulta a Cielo), então recusar temporariamente é seguro, a Cielo reenvia.
 */
export async function getCieloWebhookHeaderSecret(): Promise<string> {
  const { linha } = await getConfigEfetiva()
  if (linha?.webhookHeaderSecretCiphertext) {
    try {
      return decryptPaymentSecret(linha.webhookHeaderSecretCiphertext)
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), alert: 'payment_webhook_secret_decrypt_failed' }, '[pagamentos] não foi possível decifrar o segredo do webhook salvo no banco — webhook recusado (fail-closed)')
      throw new ConfiguracaoGatewayIndisponivelError('falha ao decifrar o segredo do webhook', { cause: err })
    }
  }
  return HEADER_SECRET_FALLBACK
}
