import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { criarBancoProprio } from './helpers/bancoProprio'

/**
 * Rotação de `PAYMENT_SECRETS_KEY` (F5.7) COBRE a `BackupConfig`: credenciais do S3, segredo/refresh token do Google e a CÓPIA CIFRADA da chave do backup usam a MESMA chave dos
 * pagamentos. Sem isto, depois de rotacionar e remover `PAYMENT_SECRETS_KEY_PREVIOUS`, o agendador não decifraria nada de madrugada (backup parado, sem erro na rotação).
 * Banco próprio (singleton global + a re-cifragem varre tabelas inteiras).
 */
const CHAVE_A = randomBytes(32) // antiga
const CHAVE_B = randomBytes(32) // atual
const SEGREDOS = {
  s3AccessKeyCiphertext: 'AKIAROTACAOMARCADOR1',
  s3SecretKeyCiphertext: 'segredo-s3-rotacao-marcador',
  driveOauthClientSecretCiphertext: 'segredo-do-app-google-rotacao',
  driveOauthRefreshTokenCiphertext: 'refresh-token-rotacao-marcador',
  encryptionKeyCiphertext: 'a'.repeat(64), // a chave do backup, em hex
} as const

describe('a rotação da chave de pagamentos cobre os segredos do backup', () => {
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let prisma: typeof import('../../src/lib/prisma').prisma
  let redisMod: typeof import('../../src/lib/redis')
  let aes: typeof import('../../src/lib/crypto/aesGcm')
  let sec: typeof import('../../src/lib/crypto/paymentSecrets')
  let rot: typeof import('../../src/services/pagamentos/recifrarSegredos')
  let cfgSvc: typeof import('../../src/services/backup/configBackup')

  beforeAll(async () => {
    banco = await criarBancoProprio('bkrot')
    process.env.PAYMENT_SECRETS_KEY = CHAVE_B.toString('base64')
    process.env.PAYMENT_SECRETS_KEY_PREVIOUS = CHAVE_A.toString('base64')
    const [p, r, a, s, ro, c] = await Promise.all([
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/crypto/aesGcm'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/recifrarSegredos'),
      import('../../src/services/backup/configBackup'),
    ])
    prisma = p.prisma
    redisMod = r
    aes = a
    sec = s
    rot = ro
    cfgSvc = c
    const dados = Object.fromEntries(Object.entries(SEGREDOS).map(([coluna, valor]) => [coluna, aes.encryptAesGcmV1(valor, CHAVE_A)]))
    await prisma.backupConfig.update({ where: { id: 1 }, data: { ...dados, encryptionKeyFingerprint: '630dcd29', destination: 'S3', s3Endpoint: 'https://s3.exemplo.com', s3Bucket: 'b' } })
  }, 120_000)

  afterAll(async () => {
    delete process.env.PAYMENT_SECRETS_KEY_PREVIOUS
    await prisma?.$disconnect()
    redisMod?.redis.disconnect()
    await banco?.descartar()
  })

  const alvoBackup = (r: Awaited<ReturnType<typeof rot.recifrarSegredosDePagamento>>) => r.alvos.filter((a) => a.alvo.startsWith('BackupConfig.'))

  it('DRY-RUN: as 5 colunas do backup aparecem como "a re-cifrar" e NADA é gravado', async () => {
    const antes = await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
    const r = await rot.recifrarSegredosDePagamento({ apply: false, prisma })
    const alvos = alvoBackup(r)
    expect(alvos.map((a) => a.alvo).sort()).toEqual(Object.keys(SEGREDOS).map((c) => `BackupConfig.${c}`).sort())
    for (const a of alvos) expect(a, a.alvo).toMatchObject({ total: 1, aRecifrar: 1, recifrados: 0, ilegiveis: 0, jaNaChaveAtual: 0 })
    expect(dump(await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } }))).toBe(dump(antes))
  })

  it('APPLY: re-cifra com a chave ATUAL (o texto continua o mesmo), preserva updatedAt, é idempotente — e SEM a chave anterior o backup ainda funciona', async () => {
    const antes = await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
    const r = await rot.recifrarSegredosDePagamento({ apply: true, prisma })
    for (const a of alvoBackup(r)) expect(a, a.alvo).toMatchObject({ recifrados: 1, ilegiveis: 0, alteradosDuranteExecucao: 0 })
    expect(r.totais.ilegiveis).toBe(0)

    const depois = await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime()) // re-cifrar não é "alteração de configuração"
    for (const [coluna, valor] of Object.entries(SEGREDOS)) {
      const novo = (depois as unknown as Record<string, string>)[coluna]!
      expect(novo, coluna).not.toBe((antes as unknown as Record<string, string>)[coluna])
      expect(sec.ciphertextEstaNaChaveAtual(novo), coluna).toBe(true)
      expect(sec.decryptPaymentSecret(novo), coluna).toBe(valor)
    }

    // Idempotente.
    const de_novo = await rot.recifrarSegredosDePagamento({ apply: true, prisma })
    expect(alvoBackup(de_novo).every((a) => a.recifrados === 0 && a.aRecifrar === 0 && a.jaNaChaveAtual === 1)).toBe(true)

    // Tira a chave ANTERIOR (como manda o runbook depois da rotação): tudo continua legível só com a atual — é o que o agendador precisa de madrugada.
    delete process.env.PAYMENT_SECRETS_KEY_PREVIOUS
    ;(await import('../../src/lib/env')).env.PAYMENT_SECRETS_KEY_PREVIOUS = undefined
    sec.resetPaymentSecretsKeyCacheParaTeste()
    const linha = await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
    expect(cfgSvc.toBackupConfigDto(linha).secretsReadable).toBe(true)
    // A cópia da chave do backup decifra (hex do dono) e a impressão digital confere? (a de teste é fictícia: só conferimos a decifragem)
    expect(sec.decryptPaymentSecret(linha.encryptionKeyCiphertext!)).toBe(SEGREDOS.encryptionKeyCiphertext)
    expect(cfgSvc.lerSegredoDaConfig(linha.s3SecretKeyCiphertext, 's3SecretKey')).toBe(SEGREDOS.s3SecretKeyCiphertext)
  })

  it('valor ilegível (corrompido) é CONTADO e nunca apagado — a rotação só fecha com ilegíveis = 0', async () => {
    await prisma.backupConfig.update({ where: { id: 1 }, data: { s3SecretKeyCiphertext: 'v1:00000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })
    const r = await rot.recifrarSegredosDePagamento({ apply: true, prisma })
    expect(r.alvos.find((a) => a.alvo === 'BackupConfig.s3SecretKeyCiphertext')).toMatchObject({ total: 1, ilegiveis: 1, recifrados: 0 })
    expect(r.totais.ilegiveis).toBe(1)
    expect((await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).s3SecretKeyCiphertext).toBe('v1:00000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect(rot.formatarRelatorio(r)).toContain('ATENÇÃO')
    expect(rot.formatarRelatorio(r)).not.toContain('AKIAROTACAO')
  })
})

const dump = (v: unknown): string => JSON.stringify(v)
