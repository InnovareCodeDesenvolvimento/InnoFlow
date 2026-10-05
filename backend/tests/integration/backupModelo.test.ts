/**
 * Modelo de dados do backup automático (migration `20261006120000_backup_automatico`): o banco impõe o que a aplicação promete — singleton, faixas, segredo sempre
 * cifrado, chave+impressão digital juntas, BackupRun com código de erro (nunca texto livre). Só tentativas INVÁLIDAS e linhas de BackupRun com id próprio: não toca o
 * estado da `BackupConfig` global (as suítes rodam em paralelo no mesmo Postgres), então pode usar o banco compartilhado.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/lib/prisma'

afterAll(async () => {
  await prisma.$disconnect()
})

async function recusa(sql: string, esperado: string): Promise<void> {
  let mensagem = ''
  try {
    await prisma.$executeRawUnsafe(sql)
  } catch (e) {
    mensagem = e instanceof Error ? e.message : String(e)
  }
  expect(mensagem, `deveria ser recusado: ${sql}`).toContain(esperado)
}

describe('BackupConfig (singleton) — o banco recusa estado inválido', () => {
  it('a migration já semeia a linha id=1, desligada e com os padrões', async () => {
    const c = await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
    expect(c.enabled).toBe(false)
    expect(c.hourLocal).toBe(3)
    expect(c.frequencyDays).toBe(1)
    expect(c.retentionCount).toBe(7)
    expect(c.alertAfterHours).toBe(36)
    expect(c.destination).toBeNull()
    expect(c.encryptionKeyCiphertext).toBeNull()
  })

  it('só existe a linha id=1', async () => {
    await recusa(`INSERT INTO "BackupConfig" ("id", "updatedAt") VALUES (2, NOW())`, 'backup_config_singleton')
  })

  it('hora fora de 0..23, frequência fora de {1,2,7}, retenção fora de 1..365, alerta fora de 6..720', async () => {
    await recusa(`UPDATE "BackupConfig" SET "hourLocal" = 24 WHERE "id" = 1`, 'backup_config_hour')
    await recusa(`UPDATE "BackupConfig" SET "hourLocal" = -1 WHERE "id" = 1`, 'backup_config_hour')
    await recusa(`UPDATE "BackupConfig" SET "frequencyDays" = 3 WHERE "id" = 1`, 'backup_config_frequency')
    await recusa(`UPDATE "BackupConfig" SET "retentionCount" = 0 WHERE "id" = 1`, 'backup_config_retention')
    await recusa(`UPDATE "BackupConfig" SET "retentionCount" = 366 WHERE "id" = 1`, 'backup_config_retention')
    await recusa(`UPDATE "BackupConfig" SET "alertAfterHours" = 5 WHERE "id" = 1`, 'backup_config_alert_after')
  })

  it('segredo em texto puro NUNCA entra (os 5 campos cifrados exigem o prefixo v1:)', async () => {
    for (const col of ['s3AccessKeyCiphertext', 's3SecretKeyCiphertext', 'driveOauthClientSecretCiphertext', 'driveOauthRefreshTokenCiphertext']) {
      await recusa(`UPDATE "BackupConfig" SET "${col}" = 'AKIAEXEMPLOEMTEXTOPURO' WHERE "id" = 1`, 'backup_config_secrets_are_ciphertext')
    }
    await recusa(`UPDATE "BackupConfig" SET "encryptionKeyCiphertext" = 'abc', "encryptionKeyFingerprint" = '630dcd29' WHERE "id" = 1`, 'backup_config_secrets_are_ciphertext')
  })

  it('chave e impressão digital andam juntas (uma sem a outra é recusada)', async () => {
    await recusa(`UPDATE "BackupConfig" SET "encryptionKeyFingerprint" = '630dcd29' WHERE "id" = 1`, 'backup_config_key_pair')
    await recusa(`UPDATE "BackupConfig" SET "encryptionKeyCiphertext" = 'v1:aaaaaaaa:xxxx' WHERE "id" = 1`, 'backup_config_key_pair')
  })

  it('destino só aceita S3 ou DRIVE', async () => {
    await recusa(`UPDATE "BackupConfig" SET "destination" = 'FTP' WHERE "id" = 1`, 'BackupDestination')
  })
})

describe('BackupRun — histórico com CÓDIGO de erro, nunca texto livre', () => {
  const ids: string[] = []
  const novoId = () => {
    const id = `bkprun_${Math.random().toString(36).slice(2, 12)}`
    ids.push(id)
    return id
  }
  afterAll(async () => {
    await prisma.backupRun.deleteMany({ where: { id: { in: ids } } })
  })

  it('nasce QUEUED, sem datas de execução', async () => {
    const r = await prisma.backupRun.create({ data: { id: novoId(), trigger: 'MANUAL' } })
    expect(r.status).toBe('QUEUED')
    expect(r.startedAt).toBeNull()
    expect(r.finishedAt).toBeNull()
    expect(r.errorCode).toBeNull()
  })

  it('FALHOU exige errorCode; errorCode só em FALHOU; terminal exige finishedAt', async () => {
    const t = new Date()
    await expect(prisma.backupRun.create({ data: { id: novoId(), trigger: 'SCHEDULED', status: 'FAILED', finishedAt: t } })).rejects.toThrow(/backup_run_error_code_iff_failed/)
    await expect(prisma.backupRun.create({ data: { id: novoId(), trigger: 'SCHEDULED', status: 'SUCCESS', finishedAt: t, errorCode: 'DUMP' } })).rejects.toThrow(/backup_run_error_code_iff_failed/)
    await expect(prisma.backupRun.create({ data: { id: novoId(), trigger: 'SCHEDULED', status: 'SUCCESS' } })).rejects.toThrow(/backup_run_finished_when_terminal/)
    await expect(prisma.backupRun.create({ data: { id: novoId(), trigger: 'SCHEDULED', status: 'RUNNING', finishedAt: t } })).rejects.toThrow(/backup_run_finished_when_terminal/)
    const ok = await prisma.backupRun.create({ data: { id: novoId(), trigger: 'SCHEDULED', status: 'FAILED', finishedAt: t, errorCode: 'KEY' } })
    expect(ok.errorCode).toBe('KEY')
  })

  it('checksum só em hex minúsculo de 64 caracteres; tamanho não negativo', async () => {
    const t = new Date()
    await expect(prisma.backupRun.create({ data: { id: novoId(), trigger: 'MANUAL', status: 'SUCCESS', finishedAt: t, checksumSha256: 'ABC' } })).rejects.toThrow(/backup_run_checksum_hex/)
    await expect(prisma.backupRun.create({ data: { id: novoId(), trigger: 'MANUAL', status: 'SUCCESS', finishedAt: t, sizeBytes: BigInt(-1) } })).rejects.toThrow(/backup_run_size_nonneg/)
    const ok = await prisma.backupRun.create({ data: { id: novoId(), trigger: 'MANUAL', status: 'SUCCESS', finishedAt: t, sizeBytes: BigInt(123), checksumSha256: 'a'.repeat(64) } })
    expect(ok.sizeBytes).toBe(BigInt(123))
  })
})
