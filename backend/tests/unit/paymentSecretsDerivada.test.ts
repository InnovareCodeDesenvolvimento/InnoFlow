import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// env e logger MOCKADOS (mesmo padrão de paymentSecretsRotacao.test.ts): variamos JWT_SECRET / PAYMENT_SECRETS_KEY / _PREVIOUS por teste, sem Postgres/Redis.
const envFake = vi.hoisted(() => ({
  LOG_LEVEL: 'silent',
  JWT_SECRET: undefined as string | undefined,
  PAYMENT_SECRETS_KEY: undefined as string | undefined,
  PAYMENT_SECRETS_KEY_PREVIOUS: undefined as string | undefined,
}))
vi.mock('../../src/lib/env', () => ({ env: envFake }))
const loggerFake = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../../src/lib/logger', () => ({ logger: loggerFake }))

import { derivarChaveDoSegredo, encryptAesGcm, keyId, resetCacheDaChaveDerivadaParaTeste, SALT_DA_CHAVE_DERIVADA, UnknownKeyIdError } from '../../src/lib/crypto/aesGcm'
import {
  ciphertextEstaNaChaveAtual,
  decifrarSegredoOuNull,
  decryptPaymentSecret,
  encryptPaymentSecret,
  isPaymentSecretsKeyConfigured,
  modoDaChaveMestra,
  resetPaymentSecretsKeyCacheParaTeste,
} from '../../src/lib/crypto/paymentSecrets'

/**
 * MUDANÇA DELIBERADA (05/10/2026, decisão do dono: "como no InnoChat"): a chave-mestra dos segredos em repouso é DERIVADA do `JWT_SECRET` (scrypt + salt fixo próprio do InnoFlow);
 * `PAYMENT_SECRETS_KEY` virou override opcional. Aqui: derivação estável, fail-closed sem exceção, override, migração derivada<->override. Sem banco, sem Redis.
 */

const JWT_A = 'jwt-secret-de-teste-com-mais-de-32-caracteres!'
const JWT_B = 'OUTRO-jwt-secret-de-teste-com-mais-de-32-caracteres'
const SEGREDO = 'merchantkey-super-secreta-do-gateway-123'
const b64 = (k: Buffer) => k.toString('base64')

beforeEach(() => {
  envFake.JWT_SECRET = JWT_A
  envFake.PAYMENT_SECRETS_KEY = undefined
  envFake.PAYMENT_SECRETS_KEY_PREVIOUS = undefined
  resetPaymentSecretsKeyCacheParaTeste()
  loggerFake.error.mockClear()
  loggerFake.warn.mockClear()
})

describe('derivação da chave a partir do JWT_SECRET (aesGcm.ts, puro)', () => {
  it('SALT FIXO do InnoFlow e vetor conhecido: mudar o salt (ou o KDF) invalida todo segredo já cifrado — este teste existe para NÃO deixar isso passar em silêncio', () => {
    expect(SALT_DA_CHAVE_DERIVADA).toBe('innoflow:lib/crypto:aes-256-gcm:v1')
    expect(derivarChaveDoSegredo(JWT_A)!.toString('hex')).toBe('1517879dcf804d8f1004bae5d2b14fa24ca32d7b7f61bcbfef64ba9a02d0b2f6')
    // o salt do InnoChat dá OUTRA chave: o mesmo segredo nos dois sistemas não pode abrir os segredos do outro
    expect(derivarChaveDoSegredo(JWT_A)!.toString('hex')).not.toBe('b1b8488d0026a3905d1abb6cb08ba660d7fc30f827c537218fdd9c34c65baeab')
  })

  it('estável: mesmo segredo => mesma chave (32 bytes); segredos diferentes => chaves diferentes', () => {
    resetCacheDaChaveDerivadaParaTeste()
    const a1 = derivarChaveDoSegredo(JWT_A)!
    resetCacheDaChaveDerivadaParaTeste()
    const a2 = derivarChaveDoSegredo(JWT_A)!
    expect(a1.length).toBe(32)
    expect(a1.equals(a2)).toBe(true)
    expect(derivarChaveDoSegredo(JWT_B)!.equals(a1)).toBe(false)
  })

  it('scrypt CACHEADO: a 2ª chamada com o mesmo segredo devolve o MESMO Buffer (não recalcula ~100 ms a cada decifragem)', () => {
    resetCacheDaChaveDerivadaParaTeste()
    const primeira = derivarChaveDoSegredo(JWT_A)
    const segunda = derivarChaveDoSegredo(JWT_A)
    expect(segunda).toBe(primeira) // identidade do objeto
    // trocar o segredo troca o cache (e não devolve a chave do segredo anterior)
    const outra = derivarChaveDoSegredo(JWT_B)
    expect(outra).not.toBe(primeira)
    expect(outra!.equals(primeira!)).toBe(false)
  })

  it('segredo ausente/curto (< 16) => null, sem lançar', () => {
    expect(derivarChaveDoSegredo(undefined)).toBeNull()
    expect(derivarChaveDoSegredo('')).toBeNull()
    expect(derivarChaveDoSegredo('curto-demais')).toBeNull()
  })
})

describe('modo padrão: SEM PAYMENT_SECRETS_KEY, a chave vem do JWT_SECRET', () => {
  it('ida e volta; v1:<kid da derivada>; modo "derivada"; isPaymentSecretsKeyConfigured true', () => {
    expect(isPaymentSecretsKeyConfigured()).toBe(true)
    expect(modoDaChaveMestra()).toBe('derivada')
    const c = encryptPaymentSecret(SEGREDO)
    expect(c.startsWith(`v1:${keyId(derivarChaveDoSegredo(JWT_A)!)}:`)).toBe(true)
    expect(c).not.toContain(SEGREDO)
    expect(decryptPaymentSecret(c)).toBe(SEGREDO)
    expect(decifrarSegredoOuNull(c)).toBe(SEGREDO)
    expect(ciphertextEstaNaChaveAtual(c)).toBe(true)
  })

  it('JWT_SECRET TROCADO => os segredos salvos viram AUSENTES: decifrarSegredoOuNull = null (nunca lança), decryptPaymentSecret lança erro TIPADO sem o conteúdo, nada vai ao log', () => {
    const v1 = encryptPaymentSecret(SEGREDO)
    const legado = encryptAesGcm(SEGREDO, derivarChaveDoSegredo(JWT_A)!)

    envFake.JWT_SECRET = JWT_B
    expect(decifrarSegredoOuNull(v1)).toBeNull()
    expect(decifrarSegredoOuNull(legado)).toBeNull()
    expect(() => decryptPaymentSecret(v1)).toThrow(UnknownKeyIdError)
    expect(() => decryptPaymentSecret(legado)).toThrow()
    try {
      decryptPaymentSecret(v1)
    } catch (err) {
      const texto = `${(err as Error).name} ${(err as Error).message}`
      expect(texto).not.toContain(SEGREDO)
      expect(texto).not.toContain(JWT_A)
      expect(texto).not.toContain(JWT_B)
    }
    expect(ciphertextEstaNaChaveAtual(v1)).toBe(false)
    // voltar ao JWT_SECRET antigo traz tudo de volta (a recuperação mais simples e a primeira a tentar)
    envFake.JWT_SECRET = JWT_A
    expect(decifrarSegredoOuNull(v1)).toBe(SEGREDO)
    expect(decifrarSegredoOuNull(legado)).toBe(SEGREDO)
    const tudoLogado = JSON.stringify([loggerFake.error.mock.calls, loggerFake.warn.mock.calls, loggerFake.info.mock.calls])
    expect(tudoLogado).not.toContain(SEGREDO)
    expect(tudoLogado).not.toContain(JWT_A)
    expect(tudoLogado).not.toContain(JWT_B)
  })

  it('NUNCA lança em decifrarSegredoOuNull: vazio, lixo, versão desconhecida, prefixo mal formado, truncado, adulterado => null', () => {
    const v1 = encryptPaymentSecret(SEGREDO)
    const [p, kid, corpo] = v1.split(':') as [string, string, string]
    const buf = Buffer.from(corpo, 'base64')
    const adulterado = Buffer.from(buf)
    adulterado[adulterado.length - 1] ^= 0xff
    const ruins: Array<string | null | undefined> = [
      null,
      undefined,
      '',
      'lixo',
      'v1:xx',
      `v2:${kid}:${corpo}`,
      `${p}:ZZZZZZZZ:${corpo}`,
      `${p}:${kid}:${buf.subarray(0, 10).toString('base64')}`, // truncado
      `${p}:${kid}:${adulterado.toString('base64')}`, // auth tag não bate
      `${p}:${kid}:`,
      'enc:v1:abc', // formato do InnoChat não é o nosso
    ]
    for (const ruim of ruins) expect(() => decifrarSegredoOuNull(ruim)).not.toThrow()
    for (const ruim of ruins) expect(decifrarSegredoOuNull(ruim)).toBeNull()
  })

  it('sem JWT_SECRET (e sem override): chave-mestra INDISPONÍVEL — não configurada, cifrar lança (mensagem cita JWT_SECRET, sem valor), decifrar devolve null', () => {
    const c = encryptPaymentSecret(SEGREDO)
    envFake.JWT_SECRET = undefined
    expect(modoDaChaveMestra()).toBe('indisponivel')
    expect(isPaymentSecretsKeyConfigured()).toBe(false)
    expect(() => encryptPaymentSecret(SEGREDO)).toThrow(/JWT_SECRET/)
    expect(decifrarSegredoOuNull(c)).toBeNull()
    envFake.JWT_SECRET = 'curto'
    expect(isPaymentSecretsKeyConfigured()).toBe(false)
  })
})

describe('override opcional: PAYMENT_SECRETS_KEY definida e válida manda, exatamente como antes', () => {
  const OVERRIDE = randomBytes(32)

  it('com override válido: grava com o kid do override (não o da derivada); round-trip; modo "override"', () => {
    envFake.PAYMENT_SECRETS_KEY = b64(OVERRIDE)
    expect(modoDaChaveMestra()).toBe('override')
    const c = encryptPaymentSecret(SEGREDO)
    expect(c.startsWith(`v1:${keyId(OVERRIDE)}:`)).toBe(true)
    expect(c.startsWith(`v1:${keyId(derivarChaveDoSegredo(JWT_A)!)}:`)).toBe(false)
    expect(decryptPaymentSecret(c)).toBe(SEGREDO)
  })

  it('override NÃO depende do JWT_SECRET: trocar o JWT_SECRET não apaga o que está na chave do override (é o caminho de "trocar o JWT_SECRET sem perder segredos")', () => {
    envFake.PAYMENT_SECRETS_KEY = b64(OVERRIDE)
    const c = encryptPaymentSecret(SEGREDO)
    envFake.JWT_SECRET = JWT_B
    expect(decifrarSegredoOuNull(c)).toBe(SEGREDO)
  })

  it('MIGRAÇÃO derivada => override: o que foi cifrado ANTES do override (chave derivada) segue legível — a derivada vira só-decifra automática — e NÃO conta como "na chave atual" (o script recifra)', () => {
    const antes = encryptPaymentSecret(SEGREDO) // derivada
    const legadoAntes = encryptAesGcm(SEGREDO, derivarChaveDoSegredo(JWT_A)!)
    envFake.PAYMENT_SECRETS_KEY = b64(OVERRIDE)
    expect(decifrarSegredoOuNull(antes)).toBe(SEGREDO)
    expect(decifrarSegredoOuNull(legadoAntes)).toBe(SEGREDO)
    expect(ciphertextEstaNaChaveAtual(antes)).toBe(false)
    expect(ciphertextEstaNaChaveAtual(encryptPaymentSecret(SEGREDO))).toBe(true)
    // ...mas se o JWT_SECRET também mudou, o que ainda estava na derivada ANTIGA se perde (por isso o runbook manda recifrar ANTES de trocar)
    envFake.JWT_SECRET = JWT_B
    expect(decifrarSegredoOuNull(antes)).toBeNull()
  })

  it('VOLTA ao derivado: remover o override mantendo-o em _PREVIOUS decifra o que ficou nele; sem _PREVIOUS fica ilegível (fail-closed)', () => {
    envFake.PAYMENT_SECRETS_KEY = b64(OVERRIDE)
    const doOverride = encryptPaymentSecret(SEGREDO)
    envFake.PAYMENT_SECRETS_KEY = undefined
    expect(modoDaChaveMestra()).toBe('derivada')
    expect(decifrarSegredoOuNull(doOverride)).toBeNull()
    envFake.PAYMENT_SECRETS_KEY_PREVIOUS = b64(OVERRIDE)
    expect(decifrarSegredoOuNull(doOverride)).toBe(SEGREDO)
  })

  it('override DEFINIDO MAS INVÁLIDO => FAIL-CLOSED: chave-mestra indisponível (NÃO cai para a derivada em silêncio), erro logado UMA vez, sem o valor', () => {
    const c = encryptPaymentSecret(SEGREDO) // derivada, antes do override quebrado
    const lixo = 'isto-nao-e-base64-de-32-bytes'
    envFake.PAYMENT_SECRETS_KEY = lixo
    resetPaymentSecretsKeyCacheParaTeste()
    expect(modoDaChaveMestra()).toBe('indisponivel')
    expect(isPaymentSecretsKeyConfigured()).toBe(false)
    expect(() => encryptPaymentSecret(SEGREDO)).toThrow(/PAYMENT_SECRETS_KEY/)
    expect(decifrarSegredoOuNull(c)).toBeNull()
    expect(decifrarSegredoOuNull(c)).toBeNull()
    const avisos = loggerFake.error.mock.calls.filter((x) => (x[0] as { alert?: string }).alert === 'payment_secrets_key_invalid')
    expect(avisos).toHaveLength(1)
    expect(JSON.stringify(loggerFake.error.mock.calls)).not.toContain(lixo)
  })
})
