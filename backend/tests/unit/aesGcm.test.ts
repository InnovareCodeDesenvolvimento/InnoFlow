import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decodeAesGcmKey, decryptAesGcm, encryptAesGcm, InvalidPaymentSecretsKeyError, MalformedCiphertextError } from '../../src/lib/crypto/aesGcm'

/**
 * Puro — sem `env`, sem `logger` (ver comentário de `aesGcm.ts`): NENHUMA
 * env dummy necessária para este arquivo, diferente do resto da suíte de
 * pagamentos (ver `.claude/agent-memory/vega/sandbox-sem-docker-innoelektron.md`).
 */

const CHAVE_32_BYTES = randomBytes(32)

describe('encryptAesGcm / decryptAesGcm', () => {
  it('round-trip: decifra exatamente o que foi cifrado', () => {
    const plaintext = 'cardtoken-real-super-secreto-abc123'
    const ciphertext = encryptAesGcm(plaintext, CHAVE_32_BYTES)
    expect(ciphertext).not.toContain(plaintext)
    expect(decryptAesGcm(ciphertext, CHAVE_32_BYTES)).toBe(plaintext)
  })

  it('dois textos iguais cifrados com a mesma chave geram ciphertexts DIFERENTES (IV aleatório, nunca reutilizado)', () => {
    const plaintext = 'mesmo-texto'
    const a = encryptAesGcm(plaintext, CHAVE_32_BYTES)
    const b = encryptAesGcm(plaintext, CHAVE_32_BYTES)
    expect(a).not.toBe(b)
    expect(decryptAesGcm(a, CHAVE_32_BYTES)).toBe(plaintext)
    expect(decryptAesGcm(b, CHAVE_32_BYTES)).toBe(plaintext)
  })

  it('decifrar com a chave ERRADA falha (auth tag não bate) — nunca devolve texto truncado/errado', () => {
    const ciphertext = encryptAesGcm('segredo', CHAVE_32_BYTES)
    const chaveErrada = randomBytes(32)
    expect(() => decryptAesGcm(ciphertext, chaveErrada)).toThrow()
  })

  it('ciphertext adulterado (1 byte trocado) falha ao decifrar — GCM detecta adulteração', () => {
    const ciphertext = encryptAesGcm('segredo-integro', CHAVE_32_BYTES)
    const buf = Buffer.from(ciphertext, 'base64')
    buf[buf.length - 1] ^= 0xff // flip do último byte (parte do ciphertext, não do IV/tag)
    const adulterado = buf.toString('base64')
    expect(() => decryptAesGcm(adulterado, CHAVE_32_BYTES)).toThrow()
  })

  it('ciphertext malformado (curto demais) -> MalformedCiphertextError', () => {
    const curto = Buffer.from('abc').toString('base64')
    expect(() => decryptAesGcm(curto, CHAVE_32_BYTES)).toThrow(MalformedCiphertextError)
  })

  it('chave com tamanho errado -> InvalidPaymentSecretsKeyError (cifrar E decifrar)', () => {
    const chave16Bytes = randomBytes(16)
    expect(() => encryptAesGcm('x', chave16Bytes)).toThrow(InvalidPaymentSecretsKeyError)
    const ciphertext = encryptAesGcm('x', CHAVE_32_BYTES)
    expect(() => decryptAesGcm(ciphertext, chave16Bytes)).toThrow(InvalidPaymentSecretsKeyError)
  })
})

describe('decodeAesGcmKey', () => {
  it('decodifica uma chave base64 de 32 bytes corretamente', () => {
    const key = decodeAesGcmKey(CHAVE_32_BYTES.toString('base64'))
    expect(key.length).toBe(32)
    expect(key.equals(CHAVE_32_BYTES)).toBe(true)
  })

  it('chave base64 que decodifica para tamanho diferente de 32 bytes -> InvalidPaymentSecretsKeyError', () => {
    expect(() => decodeAesGcmKey(randomBytes(16).toString('base64'))).toThrow(InvalidPaymentSecretsKeyError)
  })
})
