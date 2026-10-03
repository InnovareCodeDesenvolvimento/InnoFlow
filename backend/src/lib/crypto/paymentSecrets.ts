import { env } from '../env'
import { logger } from '../logger'
import { analisarCiphertext, decodeAesGcmKey, decryptAesGcmComChaves, encryptAesGcmV1, keyId } from './aesGcm'

/**
 * Resolve a chave de `PAYMENT_SECRETS_KEY` (env) para cifrar/decifrar os
 * campos `*Ciphertext` do dinheiro real — `PaymentMethod.cieloCardTokenCiphertext`
 * (F5.3) e `PaymentGatewayConfig.*Ciphertext` (F5.5). A chave NUNCA
 * vive no banco (mesmo comentário do model no `schema.prisma`, Cronos).
 *
 * OPCIONAL/sem default no `env.ts` de propósito (mesma lição de
 * `bug-env-eager-todos-entrypoints.md`): ausência não derruba o boot dos 3
 * entrypoints — só quem de fato tenta cifrar/decifrar falha, aqui, com erro
 * claro. Cacheada após a primeira resolução bem-sucedida (mesmo padrão de
 * `getPagamentoPort`/`webhookCieloSecrets.ts`).
 *
 * ROTAÇÃO (F5.7): o formato novo é `v1:<kid>:<base64>` (ver `aesGcm.ts`). `encryptPaymentSecret` SEMPRE grava `v1` com a chave ATUAL;
 * `decryptPaymentSecret` aceita `v1` (escolhe a chave pelo `kid`: a atual ou a de `PAYMENT_SECRETS_KEY_PREVIOUS`) e o formato LEGADO sem prefixo
 * (tenta a atual, depois a anterior). Runbook em `docs/DEPLOY-EASYPANEL.md`; o script `backend/scripts/recifrarSegredosDePagamento.ts` regrava o que
 * ficou com a chave antiga.
 */
let cachedKey: Buffer | null = null
let cachedPrevious: { chave: Buffer | null } | null = null
let avisouPreviousInvalida = false

function getPaymentSecretsKey(): Buffer {
  if (cachedKey) return cachedKey
  if (!env.PAYMENT_SECRETS_KEY) {
    throw new Error('PAYMENT_SECRETS_KEY não configurada — obrigatória para cifrar/decifrar segredos de pagamento (cartão tokenizado). Gere com `openssl rand -base64 32`.')
  }
  cachedKey = decodeAesGcmKey(env.PAYMENT_SECRETS_KEY)
  return cachedKey
}

/**
 * Chave ANTERIOR (rotação) — só decifra. Ausente => `null`. Inválida (não decodifica para 32 bytes) => `null` + erro logado UMA vez: uma chave anterior
 * quebrada NÃO pode derrubar o que a chave atual ainda decifra (só os ciphertexts da chave antiga ficarão ilegíveis, e `secretsDecryptable`/o script avisam).
 */
function getPreviousKey(): Buffer | null {
  if (cachedPrevious) return cachedPrevious.chave
  const bruto = env.PAYMENT_SECRETS_KEY_PREVIOUS
  let chave: Buffer | null = null
  if (bruto) {
    try {
      chave = decodeAesGcmKey(bruto)
    } catch {
      if (!avisouPreviousInvalida) {
        avisouPreviousInvalida = true
        logger.error({ alert: 'payment_secrets_key_previous_invalid' }, '[crypto] PAYMENT_SECRETS_KEY_PREVIOUS não decodifica para 32 bytes — ignorada (só a chave atual decifra)')
      }
    }
  }
  cachedPrevious = { chave }
  return chave
}

/**
 * `PAYMENT_SECRETS_KEY` presente E decodificável para 32 bytes? Não lança — usado pela configuração do
 * gateway (F5.5) para calcular `readiness` e decidir 503 `PAYMENT_SECRETS_KEY_MISSING` ANTES de tentar cifrar.
 */
export function isPaymentSecretsKeyConfigured(): boolean {
  try {
    getPaymentSecretsKey()
    return true
  } catch {
    return false
  }
}

/** Cifra no formato `v1:<kid>:<base64>` com a chave ATUAL. */
export function encryptPaymentSecret(plaintext: string): string {
  return encryptAesGcmV1(plaintext, getPaymentSecretsKey())
}

/** Decifra `v1` (chave escolhida pelo `kid`) ou legado (atual, depois anterior). Lança se nenhuma chave configurada decifra. */
export function decryptPaymentSecret(ciphertext: string): string {
  return decryptAesGcmComChaves(ciphertext, { atual: getPaymentSecretsKey(), anterior: getPreviousKey() })
}

/**
 * Este ciphertext JÁ está no formato novo E cifrado com a chave ATUAL? É o que o script de rotação usa para decidir "nada a fazer" (idempotência).
 * Não decifra nada. Legado (sem prefixo) e `v1` de outra chave => `false`.
 */
export function ciphertextEstaNaChaveAtual(ciphertext: string): boolean {
  const analisado = analisarCiphertext(ciphertext)
  return analisado.formato === 'v1' && analisado.kid === keyId(getPaymentSecretsKey())
}

/** Só para teste — a chave é cacheada por processo; sem isto, testes que mockam `PAYMENT_SECRETS_KEY` em cenários diferentes vazam estado entre casos. */
export function resetPaymentSecretsKeyCacheParaTeste(): void {
  cachedKey = null
  cachedPrevious = null
  avisouPreviousInvalida = false
}
