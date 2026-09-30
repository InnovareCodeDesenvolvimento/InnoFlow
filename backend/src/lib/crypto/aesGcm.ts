import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM puro — sem `env`, sem `logger`, sem nada além de `node:crypto`.
 * De propósito SEPARADO de `paymentSecretsKey.ts`/`paymentSecrets.ts`
 * (que resolvem a chave a partir de `PAYMENT_SECRETS_KEY`): importar `env.ts`
 * dispara a validação EAGER de TODAS as envs (ver
 * `.claude/agent-memory/vega/bug-env-eager-todos-entrypoints.md`) — um teste
 * unitário deste arquivo não precisa de `DATABASE_URL`/`REDIS_URL`/
 * `JWT_SECRET` dummy só para testar cifra/decifra.
 *
 * Formato do ciphertext: base64 de `iv (12 bytes) || authTag (16 bytes) ||
 * ciphertext` concatenados — EXATAMENTE o formato documentado no comentário
 * do model `PaymentGatewayConfig` em `prisma/schema.prisma` (Cronos, F5.1):
 * "AES-256-GCM, base64 de iv+authTag+ciphertext". Reaproveitado por
 * `PaymentMethod.cieloCardTokenCiphertext` (F5.3) e, depois, pelos campos
 * `*Ciphertext` de `PaymentGatewayConfig` (F5.5) — MESMA função, não duas
 * implementações divergentes do mesmo formato.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH_BYTES = 32 // AES-256
const IV_LENGTH_BYTES = 12 // recomendado pelo NIST para GCM
const AUTH_TAG_LENGTH_BYTES = 16

export class InvalidPaymentSecretsKeyError extends Error {
  constructor(actualLength: number) {
    super(`Chave inválida: esperado ${KEY_LENGTH_BYTES} bytes (AES-256) após decodificar base64, veio ${actualLength}. Gere com \`openssl rand -base64 32\`.`)
    this.name = 'InvalidPaymentSecretsKeyError'
  }
}

export class MalformedCiphertextError extends Error {
  constructor(reason: string) {
    super(`Ciphertext malformado/corrompido: ${reason}`)
    this.name = 'MalformedCiphertextError'
  }
}

/** Decodifica e valida uma chave base64 — usada tanto pela resolução de env quanto pelos testes (chave "errada" de propósito). */
export function decodeAesGcmKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64')
  if (key.length !== KEY_LENGTH_BYTES) throw new InvalidPaymentSecretsKeyError(key.length)
  return key
}

/** Cifra `plaintext` (UTF-8) com a chave dada (32 bytes). Um IV aleatório novo a cada chamada — nunca reutilizar IV com a mesma chave (quebra a garantia do GCM). */
export function encryptAesGcm(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_LENGTH_BYTES) throw new InvalidPaymentSecretsKeyError(key.length)
  const iv = randomBytes(IV_LENGTH_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64')
}

/** Decifra um ciphertext gerado por `encryptAesGcm` com a MESMA chave. Lança `MalformedCiphertextError` (formato) ou o erro nativo de `crypto` (auth tag não bate — chave errada ou dado adulterado) — nunca devolve texto truncado/parcial. */
export function decryptAesGcm(ciphertextBase64: string, key: Buffer): string {
  if (key.length !== KEY_LENGTH_BYTES) throw new InvalidPaymentSecretsKeyError(key.length)
  const buf = Buffer.from(ciphertextBase64, 'base64')
  if (buf.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES) {
    throw new MalformedCiphertextError(`tamanho ${buf.length} menor que iv+authTag (${IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES})`)
  }
  const iv = buf.subarray(0, IV_LENGTH_BYTES)
  const authTag = buf.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES)
  const ciphertext = buf.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
