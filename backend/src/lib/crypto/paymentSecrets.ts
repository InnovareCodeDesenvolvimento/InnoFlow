import { env } from '../env'
import { decodeAesGcmKey, decryptAesGcm, encryptAesGcm } from './aesGcm'

/**
 * Resolve a chave de `PAYMENT_SECRETS_KEY` (env) para cifrar/decifrar os
 * campos `*Ciphertext` do dinheiro real — `PaymentMethod.cieloCardTokenCiphertext`
 * (F5.3) e, depois, `PaymentGatewayConfig.*Ciphertext` (F5.5). A chave NUNCA
 * vive no banco (mesmo comentário do model no `schema.prisma`, Cronos).
 *
 * OPCIONAL/sem default no `env.ts` de propósito (mesma lição de
 * `bug-env-eager-todos-entrypoints.md`): ausência não derruba o boot dos 3
 * entrypoints — só quem de fato tenta cifrar/decifrar falha, aqui, com erro
 * claro. Cacheada após a primeira resolução bem-sucedida (mesmo padrão de
 * `getPagamentoPort`/`webhookCieloSecrets.ts`).
 */
let cachedKey: Buffer | null = null

function getPaymentSecretsKey(): Buffer {
  if (cachedKey) return cachedKey
  if (!env.PAYMENT_SECRETS_KEY) {
    throw new Error('PAYMENT_SECRETS_KEY não configurada — obrigatória para cifrar/decifrar segredos de pagamento (cartão tokenizado). Gere com `openssl rand -base64 32`.')
  }
  cachedKey = decodeAesGcmKey(env.PAYMENT_SECRETS_KEY)
  return cachedKey
}

export function encryptPaymentSecret(plaintext: string): string {
  return encryptAesGcm(plaintext, getPaymentSecretsKey())
}

export function decryptPaymentSecret(ciphertext: string): string {
  return decryptAesGcm(ciphertext, getPaymentSecretsKey())
}

/** Só para teste — a chave é cacheada por processo; sem isto, testes que mockam `PAYMENT_SECRETS_KEY` em cenários diferentes vazam estado entre casos. */
export function resetPaymentSecretsKeyCacheParaTeste(): void {
  cachedKey = null
}
