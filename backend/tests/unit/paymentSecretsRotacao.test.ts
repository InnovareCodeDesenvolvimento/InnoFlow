import { createHash, randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// env e logger MOCKADOS (mesmo padrão de pagamentoPortInstance.test.ts): variamos PAYMENT_SECRETS_KEY / _PREVIOUS por teste, sem Postgres/Redis.
const envFake = vi.hoisted(() => ({
  LOG_LEVEL: 'silent',
  PAYMENT_SECRETS_KEY: undefined as string | undefined,
  PAYMENT_SECRETS_KEY_PREVIOUS: undefined as string | undefined,
}))
vi.mock('../../src/lib/env', () => ({ env: envFake }))
const loggerFake = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../../src/lib/logger', () => ({ logger: loggerFake }))

import {
  analisarCiphertext,
  CIPHERTEXT_V1_PREFIX,
  decryptAesGcmComChaves,
  encryptAesGcm,
  encryptAesGcmV1,
  keyId,
  MalformedCiphertextError,
  UnknownKeyIdError,
} from '../../src/lib/crypto/aesGcm'
import { ciphertextEstaNaChaveAtual, decryptPaymentSecret, encryptPaymentSecret, isPaymentSecretsKeyConfigured, resetPaymentSecretsKeyCacheParaTeste } from '../../src/lib/crypto/paymentSecrets'

/**
 * F5.7 — formato versionado `v1:<kid>:<base64>` + rotação de chave (atual / anterior / legado). Sem env real, sem banco.
 */

const CHAVE_A = randomBytes(32)
const CHAVE_B = randomBytes(32)
const CHAVE_C = randomBytes(32)
const b64 = (k: Buffer) => k.toString('base64')
const SEGREDO = 'cardtoken-ou-merchantkey-super-secreto-123'

describe('formato v1 (aesGcm.ts, puro)', () => {
  it('encryptAesGcmV1 grava `v1:<kid>:<base64>`; o kid é o SHA-256 da chave (8 hex) — nunca a chave nem o texto', () => {
    const c = encryptAesGcmV1(SEGREDO, CHAVE_A)
    expect(c).toMatch(/^v1:[0-9a-f]{8}:[A-Za-z0-9+/]+=*$/)
    const [prefixo, kid] = c.split(':')
    expect(prefixo).toBe(CIPHERTEXT_V1_PREFIX)
    expect(kid).toBe(createHash('sha256').update(CHAVE_A).digest('hex').slice(0, 8))
    expect(kid).toBe(keyId(CHAVE_A))
    expect(c).not.toContain(SEGREDO)
    expect(c).not.toContain(b64(CHAVE_A))
    expect(keyId(CHAVE_B)).not.toBe(keyId(CHAVE_A))
  })

  it('IV novo a cada cifra: dois ciphertexts v1 do mesmo texto diferem, e ambos decifram', () => {
    const a = encryptAesGcmV1(SEGREDO, CHAVE_A)
    const b = encryptAesGcmV1(SEGREDO, CHAVE_A)
    expect(a).not.toBe(b)
    expect(decryptAesGcmComChaves(a, { atual: CHAVE_A })).toBe(SEGREDO)
    expect(decryptAesGcmComChaves(b, { atual: CHAVE_A })).toBe(SEGREDO)
  })

  it('v1 escolhe a chave PELO kid: cifrado com a antiga decifra via `anterior`, mesmo com a atual configurada', () => {
    const doAntigo = encryptAesGcmV1(SEGREDO, CHAVE_A)
    expect(decryptAesGcmComChaves(doAntigo, { atual: CHAVE_B, anterior: CHAVE_A })).toBe(SEGREDO)
    const doNovo = encryptAesGcmV1(SEGREDO, CHAVE_B)
    expect(decryptAesGcmComChaves(doNovo, { atual: CHAVE_B, anterior: CHAVE_A })).toBe(SEGREDO)
  })

  it('v1 de uma chave que NÃO está configurada => UnknownKeyIdError (com o kid, nunca chave/texto)', () => {
    const c = encryptAesGcmV1(SEGREDO, CHAVE_C)
    try {
      decryptAesGcmComChaves(c, { atual: CHAVE_B, anterior: CHAVE_A })
      expect.unreachable('devia ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownKeyIdError)
      expect((err as UnknownKeyIdError).kid).toBe(keyId(CHAVE_C))
      expect((err as Error).message).not.toContain(SEGREDO)
      expect((err as Error).message).not.toContain(b64(CHAVE_C))
    }
    expect(() => decryptAesGcmComChaves(c, { atual: CHAVE_B })).toThrow(UnknownKeyIdError)
  })

  it('LEGADO (sem prefixo): decifra com a atual; se não bate, tenta a anterior; sem nenhuma que bata, lança', () => {
    const legadoA = encryptAesGcm(SEGREDO, CHAVE_A) // formato de antes da F5.7
    expect(analisarCiphertext(legadoA)).toEqual({ formato: 'legado', corpo: legadoA })
    expect(decryptAesGcmComChaves(legadoA, { atual: CHAVE_A })).toBe(SEGREDO)
    expect(decryptAesGcmComChaves(legadoA, { atual: CHAVE_B, anterior: CHAVE_A })).toBe(SEGREDO)
    expect(() => decryptAesGcmComChaves(legadoA, { atual: CHAVE_B })).toThrow()
    expect(() => decryptAesGcmComChaves(legadoA, { atual: CHAVE_B, anterior: CHAVE_C })).toThrow()
  })

  it('v1 adulterado (corpo) falha no auth tag; versão desconhecida e prefixo mal formado => MalformedCiphertextError', () => {
    const c = encryptAesGcmV1(SEGREDO, CHAVE_A)
    const [p, kid, corpo] = c.split(':') as [string, string, string]
    const buf = Buffer.from(corpo, 'base64')
    buf[buf.length - 1] ^= 0xff
    expect(() => decryptAesGcmComChaves(`${p}:${kid}:${buf.toString('base64')}`, { atual: CHAVE_A })).toThrow()
    expect(() => decryptAesGcmComChaves(`v2:${kid}:${corpo}`, { atual: CHAVE_A })).toThrow(MalformedCiphertextError)
    expect(() => decryptAesGcmComChaves(`v1:${kid}`, { atual: CHAVE_A })).toThrow(MalformedCiphertextError)
    expect(() => decryptAesGcmComChaves(`v1:${kid}:`, { atual: CHAVE_A })).toThrow(MalformedCiphertextError)
    expect(() => decryptAesGcmComChaves(`v1:ZZZZZZZZ:${corpo}`, { atual: CHAVE_A })).toThrow(MalformedCiphertextError)
    expect(() => decryptAesGcmComChaves(`v1:${kid}:${corpo}:extra`, { atual: CHAVE_A })).toThrow(MalformedCiphertextError)
  })
})

describe('paymentSecrets.ts (env: PAYMENT_SECRETS_KEY / PAYMENT_SECRETS_KEY_PREVIOUS)', () => {
  beforeEach(() => {
    envFake.PAYMENT_SECRETS_KEY = b64(CHAVE_A)
    envFake.PAYMENT_SECRETS_KEY_PREVIOUS = undefined
    resetPaymentSecretsKeyCacheParaTeste()
    loggerFake.error.mockClear()
  })

  it('encryptPaymentSecret SEMPRE grava v1 com a chave ATUAL; round-trip', () => {
    const c = encryptPaymentSecret(SEGREDO)
    expect(c.startsWith(`v1:${keyId(CHAVE_A)}:`)).toBe(true)
    expect(decryptPaymentSecret(c)).toBe(SEGREDO)
    expect(ciphertextEstaNaChaveAtual(c)).toBe(true)
  })

  it('ROTAÇÃO: chave nova em PAYMENT_SECRETS_KEY + antiga em _PREVIOUS => v1 antigo, v1 novo e LEGADO antigo decifram; o que se grava depois é v1 da chave nova', () => {
    const v1Antigo = encryptPaymentSecret(SEGREDO) // gravado com A
    const legadoAntigo = encryptAesGcm(SEGREDO, CHAVE_A) // gravado com A antes da F5.7

    envFake.PAYMENT_SECRETS_KEY = b64(CHAVE_B)
    envFake.PAYMENT_SECRETS_KEY_PREVIOUS = b64(CHAVE_A)
    resetPaymentSecretsKeyCacheParaTeste()

    expect(decryptPaymentSecret(v1Antigo)).toBe(SEGREDO)
    expect(decryptPaymentSecret(legadoAntigo)).toBe(SEGREDO)
    const novo = encryptPaymentSecret('outro-segredo')
    expect(novo.startsWith(`v1:${keyId(CHAVE_B)}:`)).toBe(true)
    expect(decryptPaymentSecret(novo)).toBe('outro-segredo')
    // quem está na chave antiga NÃO conta como "na atual" (é o que o script de rotação regrava)
    expect(ciphertextEstaNaChaveAtual(v1Antigo)).toBe(false)
    expect(ciphertextEstaNaChaveAtual(legadoAntigo)).toBe(false)
    expect(ciphertextEstaNaChaveAtual(novo)).toBe(true)
  })

  it('sem _PREVIOUS (rotação sem a chave antiga): o antigo NÃO decifra (v1 => UnknownKeyIdError; legado => erro do auth tag) — o que a tela mostra como secretsDecryptable=false', () => {
    const v1Antigo = encryptPaymentSecret(SEGREDO)
    const legadoAntigo = encryptAesGcm(SEGREDO, CHAVE_A)
    envFake.PAYMENT_SECRETS_KEY = b64(CHAVE_B)
    resetPaymentSecretsKeyCacheParaTeste()
    expect(() => decryptPaymentSecret(v1Antigo)).toThrow(UnknownKeyIdError)
    expect(() => decryptPaymentSecret(legadoAntigo)).toThrow()
  })

  it('_PREVIOUS inválida é IGNORADA (log de erro uma vez) e NÃO derruba o que a chave atual decifra', () => {
    const atual = encryptPaymentSecret(SEGREDO)
    envFake.PAYMENT_SECRETS_KEY_PREVIOUS = b64(randomBytes(16)) // 16 bytes: inválida
    resetPaymentSecretsKeyCacheParaTeste()
    expect(decryptPaymentSecret(atual)).toBe(SEGREDO)
    expect(decryptPaymentSecret(atual)).toBe(SEGREDO)
    const avisos = loggerFake.error.mock.calls.filter((c) => (c[0] as { alert?: string }).alert === 'payment_secrets_key_previous_invalid')
    expect(avisos).toHaveLength(1)
    expect(JSON.stringify(loggerFake.error.mock.calls)).not.toContain(envFake.PAYMENT_SECRETS_KEY_PREVIOUS)
  })

  it('isPaymentSecretsKeyConfigured só depende da chave ATUAL (a anterior é opcional)', () => {
    expect(isPaymentSecretsKeyConfigured()).toBe(true)
    envFake.PAYMENT_SECRETS_KEY = undefined
    resetPaymentSecretsKeyCacheParaTeste()
    expect(isPaymentSecretsKeyConfigured()).toBe(false)
    expect(() => encryptPaymentSecret(SEGREDO)).toThrow(/PAYMENT_SECRETS_KEY/)
  })
})
