import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'

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
// Chave-mestra DERIVADA de um segredo do ambiente (decisão do dono, 05/10/2026: "como no InnoChat")
// ----------------------------------------------------------------------------------------------
//
// O InnoChat guarda a chave dos segredos em repouso DERIVADA do `AUTH_SECRET` (`scryptSync(secret, SALT_FIXO, 32)`), para o deploy ter só as variáveis essenciais. O InnoFlow faz o mesmo
// com o `JWT_SECRET`. `PAYMENT_SECRETS_KEY` virou OVERRIDE opcional (ver `paymentSecrets.ts`). CONSEQUÊNCIA OPERACIONAL: trocar o `JWT_SECRET` faz todo segredo já cifrado deixar de
// decifrar (vira AUSENTE, fail-closed) e precisa ser recadastrado — e, no InnoFlow, derruba as sessões e deixa ilegíveis os cartões salvos dos motoristas. Runbook: docs/DEPLOY-EASYPANEL.md.

/**
 * Salt FIXO e PRÓPRIO do InnoFlow — só estica o segredo em material de chave (não precisa ser secreto: a segurança é do `JWT_SECRET`). NÃO ALTERE: invalida todo segredo já cifrado.
 * (O InnoChat usa outro salt, de propósito: o mesmo segredo nos dois sistemas não pode dar a mesma chave.)
 */
export const SALT_DA_CHAVE_DERIVADA = 'innoflow:lib/crypto:aes-256-gcm:v1'

/** Mínimo do segredo-fonte — o mesmo piso do `env.ts` para o `JWT_SECRET` (produção exige 32). */
export const TAMANHO_MINIMO_DO_SEGREDO_FONTE = 16

// scryptSync é intencionalmente caro (~100 ms): deriva UMA vez por valor de segredo. O cache é chaveado pelo próprio segredo, então um teste que troque o `JWT_SECRET` não precisa de reset.
let derivadaEmCache: { segredo: string; chave: Buffer } | null = null

/** Chave AES-256 derivada de `segredo` via scrypt com o salt fixo do InnoFlow. `null` se o segredo for ausente/curto (nunca lança por isso). Determinística: mesmo segredo => mesma chave. */
export function derivarChaveDoSegredo(segredo: string | null | undefined): Buffer | null {
  if (!segredo || segredo.length < TAMANHO_MINIMO_DO_SEGREDO_FONTE) return null
  if (!derivadaEmCache || derivadaEmCache.segredo !== segredo) {
    derivadaEmCache = { segredo, chave: scryptSync(segredo, SALT_DA_CHAVE_DERIVADA, KEY_LENGTH_BYTES) }
  }
  return derivadaEmCache.chave
}

/** Só para teste: provar que o scrypt é cacheado (e não recalculado a cada decifragem). */
export function resetCacheDaChaveDerivadaParaTeste(): void {
  derivadaEmCache = null
}

// ----------------------------------------------------------------------------------------------
// Formato VERSIONADO + rotação de chave (F5.7)
// ----------------------------------------------------------------------------------------------
//
// `v1:<kid>:<base64(iv+tag+ct)>` — o mesmo corpo de `encryptAesGcm`, precedido da versão do formato e do `kid` (identificador da CHAVE que cifrou:
// os 8 primeiros hex do SHA-256 da chave — nunca a chave, e 32 bits de um hash de 256 bits aleatórios não ajudam ninguém a recuperá-la). Serve para
// ROTACIONAR a chave-mestra (modo override `PAYMENT_SECRETS_KEY`, ou voltar ao derivado do `JWT_SECRET`) sem perder os segredos já gravados: a chave nova cifra tudo o que for gravado dali em diante (sempre `v1` com a atual),
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

/**
 * Nenhuma das chaves disponíveis tem o `kid` do ciphertext — a chave que o cifrou foi trocada/perdida. Na prática: o `JWT_SECRET` (de onde a chave-mestra é DERIVADA) mudou,
 * ou `PAYMENT_SECRETS_KEY` (override opcional) mudou/foi removida sem `PAYMENT_SECRETS_KEY_PREVIOUS`.
 */
export class UnknownKeyIdError extends Error {
  constructor(readonly kid: string) {
    super(`Ciphertext cifrado com a chave de id "${kid}", que não está disponível (JWT_SECRET trocado, ou PAYMENT_SECRETS_KEY / PAYMENT_SECRETS_KEY_PREVIOUS ausente).`)
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
  /** Outras chaves que só DECIFRAM (ex.: a derivada do `JWT_SECRET` quando a atual é o override `PAYMENT_SECRETS_KEY`). Tentadas depois de `anterior`. */
  outras?: readonly Buffer[]
}

/**
 * Decifra qualquer formato. `v1`: escolhe a chave pelo `kid` (atual, anterior ou das `outras`; nenhuma bate => `UnknownKeyIdError`). Legado: tenta a atual e, se o auth tag
 * não bater, cada uma das demais — nunca devolve texto parcial. Lança o erro nativo de `crypto` (o da primeira tentativa) quando NENHUMA chave decifra.
 */
export function decryptAesGcmComChaves(ciphertext: string, chaves: ChavesDeDecifragem): string {
  const analisado = analisarCiphertext(ciphertext)
  const candidatas = [chaves.atual, chaves.anterior, ...(chaves.outras ?? [])].filter((c): c is Buffer => Boolean(c))
  if (analisado.formato === 'v1') {
    for (const chave of candidatas) {
      if (keyId(chave) === analisado.kid) return decryptAesGcm(analisado.corpo, chave)
    }
    throw new UnknownKeyIdError(analisado.kid)
  }
  let primeiroErro: unknown
  for (const chave of candidatas) {
    try {
      return decryptAesGcm(analisado.corpo, chave)
    } catch (err) {
      primeiroErro ??= err
    }
  }
  throw primeiroErro
}
