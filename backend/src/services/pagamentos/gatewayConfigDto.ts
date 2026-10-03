import { calcularReadiness, montarWebhookUrl, type AmbienteGateway, type ReadinessMeio } from '../../core/pagamentos/configGateway'
import type { ConfigEfetiva } from './gatewayConfig'
import { WEBHOOK_SECRET_HEADER_NAME } from './webhookCieloSecrets'

/** Espelha `PaymentGatewayConfigDTO` de `frontend/src/types/api.ts` (contrato literal, F5.5). Segredos NUNCA aparecem — só `...Set`. */
export interface PaymentGatewayConfigDto {
  source: 'database' | 'env'
  environment: AmbienteGateway
  merchantId: string | null
  merchantKeySet: boolean
  sopClientId: string | null
  sopClientSecretSet: boolean
  webhookHeaderSecretSet: boolean
  webhookUrl: string | null
  webhookHeaderName: string
  cardEnabled: boolean
  pixEnabled: boolean
  readiness: { card: ReadinessMeio; pix: ReadinessMeio }
  /** M3: `true` = segredos salvos no banco decifram agora; `false` = ao menos um não decifra (gateway em 503); `null` = não há segredo salvo no banco. */
  secretsDecryptable: boolean | null
  /** ALTO-2: ambiente efetivo SANDBOX em servidor `NODE_ENV=production` — Pix/cartão só para os testadores do servidor. */
  sandboxRestricted: boolean
  updatedAt: string | null
}

export function toPaymentGatewayConfigDto(config: ConfigEfetiva, publicBaseUrl: string | null, derivados: { secretsDecryptable: boolean | null; sandboxRestricted: boolean }): PaymentGatewayConfigDto {
  const { estado, envGateway } = config
  return {
    source: estado.source,
    environment: estado.environment,
    merchantId: estado.merchantId,
    merchantKeySet: estado.temMerchantKey,
    sopClientId: estado.sopClientId,
    sopClientSecretSet: estado.temSopClientSecret,
    webhookHeaderSecretSet: estado.temWebhookHeaderSecret,
    webhookUrl: montarWebhookUrl(publicBaseUrl, envGateway.webhookPathToken),
    webhookHeaderName: WEBHOOK_SECRET_HEADER_NAME,
    cardEnabled: estado.cardEnabled,
    pixEnabled: estado.pixEnabled,
    readiness: calcularReadiness(estado, envGateway),
    secretsDecryptable: derivados.secretsDecryptable,
    sandboxRestricted: derivados.sandboxRestricted,
    updatedAt: estado.updatedAt ? estado.updatedAt.toISOString() : null,
  }
}
