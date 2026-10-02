import { randomUUID } from 'node:crypto'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { decryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { ConfiguracaoGatewayIndisponivelError } from '../../core/pagamentos/erros'
import { SEGREDO_WEBHOOK_TAMANHO_MINIMO } from '../../core/pagamentos/verificarSegredoWebhook'
import { createLogGate } from '../../lib/rateLimitedLog'
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

/** No máximo 1 aviso por hora por origem: o webhook chega com frequência e o aviso é sobre CONFIGURAÇÃO, não sobre cada notificação. */
const avisarPathTokenFraco = createLogGate(3_600_000)
const avisarHeaderSecretFraco = createLogGate(3_600_000)

export function getCieloWebhookPathToken(): string {
  // F5.7 (B2): token do CAMINHO vindo do env com menos de 32 caracteres — o schema do env aceita >= 8 (não derruba o boot), mas é fraco. Só o TAMANHO vai ao log.
  if (env.CIELO_WEBHOOK_PATH_TOKEN && PATH_TOKEN.length < SEGREDO_WEBHOOK_TAMANHO_MINIMO) {
    avisarPathTokenFraco(() => logger.warn({ envVar: 'CIELO_WEBHOOK_PATH_TOKEN', length: PATH_TOKEN.length, minRecommended: SEGREDO_WEBHOOK_TAMANHO_MINIMO, alert: 'payment_webhook_secret_weak' }, '[pagamentos] CIELO_WEBHOOK_PATH_TOKEN abaixo do tamanho recomendado — gere um novo (openssl rand -hex 24) e atualize no painel da Cielo'))
  }
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
  // F5.7 (B2): segredo do header vindo do env com menos de 32 caracteres (o do banco é validado no PUT). Só o TAMANHO vai ao log.
  if (env.CIELO_WEBHOOK_HEADER_SECRET && HEADER_SECRET_FALLBACK.length < SEGREDO_WEBHOOK_TAMANHO_MINIMO) {
    avisarHeaderSecretFraco(() => logger.warn({ envVar: 'CIELO_WEBHOOK_HEADER_SECRET', length: HEADER_SECRET_FALLBACK.length, minRecommended: SEGREDO_WEBHOOK_TAMANHO_MINIMO, alert: 'payment_webhook_secret_weak' }, '[pagamentos] CIELO_WEBHOOK_HEADER_SECRET abaixo do tamanho recomendado — cadastre um segredo de 32+ caracteres na tela do gateway (ou gere outro para o env) e atualize na Cielo'))
  }
  return HEADER_SECRET_FALLBACK
}
