import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

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

// ----------------------------------------------------------------------------------------------
// Formato VERSIONADO + rotação de chave (F5.7)
// ----------------------------------------------------------------------------------------------
//
// `v1:<kid>:<base64(iv+tag+ct)>` — o mesmo corpo de `encryptAesGcm`, precedido da versão do formato e do `kid` (identificador da CHAVE que cifrou:
// os 8 primeiros hex do SHA-256 da chave — nunca a chave, e 32 bits de um hash de 256 bits aleatórios não ajudam ninguém a recuperá-la). Serve para
// ROTACIONAR `PAYMENT_SECRETS_KEY` sem perder os segredos já gravados: a chave nova cifra tudo o que for gravado dali em diante (sempre `v1` com a atual),
// a antiga fica em `PAYMENT_SECRETS_KEY_PREVIOUS` só para DECIFRAR, e `backend/scripts/recifrarSegredosDePagamento.ts` regrava o que ficou com a antiga.
// Ciphertext LEGADO (sem prefixo — tudo o que foi gravado até a F5.7) continua decifrando: tenta a chave atual e depois a anterior. O base64 padrão
// não contém ':', então a presença do prefixo `v1:` é inequívoca.

export const CIPHERTEXT_V1_PREFIX = 'v1'
const KID_HEX_LENGTH = 8

/** Identificador PÚBLICO da chave (não é segredo): 8 primeiros hex do SHA-256 da chave de 32 bytes. */
export function keyId(key: Buffer): string {
  if (key.length !== KEY_LENGTH_BYTES) throw new InvalidPaymentSecretsKeyError(key.length)
  return createHash('sha256').update(key).digest('hex').slice(0, KID_HEX_LENGTH)
}

/** Nenhuma das chaves configuradas tem o `kid` do ciphertext — a chave que o cifrou foi trocada/perdida (ou `PAYMENT_SECRETS_KEY_PREVIOUS` não foi configurada na rotação). */
export class UnknownKeyIdError extends Error {
  constructor(readonly kid: string) {
    super(`Ciphertext cifrado com a chave de id "${kid}", que não está configurada (PAYMENT_SECRETS_KEY / PAYMENT_SECRETS_KEY_PREVIOUS).`)
    this.name = 'UnknownKeyIdError'
  }
}

/** Cifra no formato `v1:<kid>:<base64>` com a chave dada (a ATUAL). */
export function encryptAesGcmV1(plaintext: string, key: Buffer): string {
  return `${CIPHERTEXT_V1_PREFIX}:${keyId(key)}:${encryptAesGcm(plaintext, key)}`
}

export type CiphertextAnalisado = { formato: 'v1'; kid: string; corpo: string } | { formato: 'legado'; corpo: string }

/** Classifica o ciphertext SEM decifrar. Versão desconhecida (`v2:...`) ou `v1` mal formado => `MalformedCiphertextError`. */
export function analisarCiphertext(ciphertext: string): CiphertextAnalisado {
  if (!ciphertext.includes(':')) return { formato: 'legado', corpo: ciphertext }
  const partes = ciphertext.split(':')
  if (partes[0] !== CIPHERTEXT_V1_PREFIX) throw new MalformedCiphertextError(`versão de formato desconhecida "${partes[0]!.slice(0, 8)}"`)
  if (partes.length !== 3 || !new RegExp(`^[0-9a-f]{${KID_HEX_LENGTH}}$`).test(partes[1]!) || !partes[2]) throw new MalformedCiphertextError('prefixo v1 mal formado')
  return { formato: 'v1', kid: partes[1]!, corpo: partes[2]! }
}

export interface ChavesDeDecifragem {
  atual: Buffer
  anterior?: Buffer | null
}

/**
 * Decifra qualquer formato. `v1`: escolhe a chave pelo `kid` (atual ou anterior; nenhuma bate => `UnknownKeyIdError`). Legado: tenta a atual e, se o auth tag
 * não bater, a anterior (se houver) — nunca devolve texto parcial. Lança o erro nativo de `crypto` quando NENHUMA chave decifra.
 */
export function decryptAesGcmComChaves(ciphertext: string, chaves: ChavesDeDecifragem): string {
  const analisado = analisarCiphertext(ciphertext)
  if (analisado.formato === 'v1') {
    for (const chave of [chaves.atual, chaves.anterior]) {
      if (chave && keyId(chave) === analisado.kid) return decryptAesGcm(analisado.corpo, chave)
    }
    throw new UnknownKeyIdError(analisado.kid)
  }
  try {
    return decryptAesGcm(analisado.corpo, chaves.atual)
  } catch (err) {
    if (!chaves.anterior) throw err
    return decryptAesGcm(analisado.corpo, chaves.anterior)
  }
}
