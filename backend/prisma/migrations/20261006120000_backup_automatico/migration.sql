-- Backup automático do banco (porte do InnoChat): configuração SINGLETON ("BackupConfig") + histórico de execuções ("BackupRun").
-- Aditiva: só CREATE TYPE/TABLE/INDEX e a linha singleton; não toca em nenhuma tabela existente.
-- Segredos (access/secret key do S3, client secret e refresh token do Google, cópia da chave do backup) ficam CIFRADOS (AES-256-GCM, formato v1:<kid>:<base64>,
-- chave PAYMENT_SECRETS_KEY — que vive só em env, nunca no banco). Formato do ARQUIVO cifrado: docs/BACKUP-FORMATO.md.

CREATE TYPE "BackupTrigger" AS ENUM ('SCHEDULED', 'MANUAL', 'VERIFY');
CREATE TYPE "BackupRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED');
CREATE TYPE "BackupDestination" AS ENUM ('S3', 'DRIVE');

CREATE TABLE "BackupConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,

    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMPTZ(3),
    "hourLocal" INTEGER NOT NULL DEFAULT 3,
    "frequencyDays" INTEGER NOT NULL DEFAULT 1,
    "retentionCount" INTEGER NOT NULL DEFAULT 7,
    "alertAfterHours" INTEGER NOT NULL DEFAULT 36,

    "destination" "BackupDestination",

    "s3Endpoint" TEXT,
    "s3Region" TEXT,
    "s3Bucket" TEXT,
    "s3Prefix" TEXT,
    "s3AccessKeyCiphertext" TEXT,
    "s3SecretKeyCiphertext" TEXT,

    "driveOauthClientId" TEXT,
    "driveOauthClientSecretCiphertext" TEXT,
    "driveOauthRefreshTokenCiphertext" TEXT,
    "driveOauthEmail" TEXT,
    "driveOauthFolderId" TEXT,
    "driveOauthConnectedAt" TIMESTAMPTZ(3),
    "driveOauthConnectedById" TEXT,
    "oauthStateNonce" TEXT,
    "oauthStateExpiresAt" TIMESTAMPTZ(3),
    "oauthStateAdminId" TEXT,

    "encryptionKeyFingerprint" TEXT,
    "encryptionKeyCiphertext" TEXT,
    "encryptionKeyCreatedAt" TIMESTAMPTZ(3),
    "encryptionKeyShownAt" TIMESTAMPTZ(3),

    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastAttemptAt" TIMESTAMPTZ(3),
    "runningSince" TIMESTAMPTZ(3),
    "lastStaleAlertAt" TIMESTAMPTZ(3),

    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BackupConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,

    "trigger" "BackupTrigger" NOT NULL,
    "status" "BackupRunStatus" NOT NULL DEFAULT 'QUEUED',
    "destination" "BackupDestination",

    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,

    "fileName" TEXT,
    "objectKey" TEXT,
    "sizeBytes" BIGINT,
    "checksumSha256" TEXT,
    "tablesWithData" INTEGER,
    "encryptionKeyFingerprint" TEXT,

    "errorCode" TEXT,
    "createdById" TEXT,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackupRun_createdAt_idx" ON "BackupRun"("createdAt" DESC);
CREATE INDEX "BackupRun_trigger_createdAt_idx" ON "BackupRun"("trigger", "createdAt" DESC);
CREATE INDEX "BackupRun_status_idx" ON "BackupRun"("status");

-- Singleton de verdade (só a linha id = 1) e valores válidos reforçados no banco, não só na aplicação.
ALTER TABLE "BackupConfig"
  ADD CONSTRAINT "backup_config_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "backup_config_hour" CHECK ("hourLocal" BETWEEN 0 AND 23),
  ADD CONSTRAINT "backup_config_frequency" CHECK ("frequencyDays" IN (1, 2, 7)),
  ADD CONSTRAINT "backup_config_retention" CHECK ("retentionCount" BETWEEN 1 AND 365),
  ADD CONSTRAINT "backup_config_alert_after" CHECK ("alertAfterHours" BETWEEN 6 AND 720),
  -- Segredo cifrado nunca é texto puro: o formato v1 tem prefixo (um valor sem ":" aqui é bug de quem gravou).
  ADD CONSTRAINT "backup_config_secrets_are_ciphertext" CHECK (
    ("s3AccessKeyCiphertext" IS NULL OR "s3AccessKeyCiphertext" LIKE 'v1:%')
    AND ("s3SecretKeyCiphertext" IS NULL OR "s3SecretKeyCiphertext" LIKE 'v1:%')
    AND ("driveOauthClientSecretCiphertext" IS NULL OR "driveOauthClientSecretCiphertext" LIKE 'v1:%')
    AND ("driveOauthRefreshTokenCiphertext" IS NULL OR "driveOauthRefreshTokenCiphertext" LIKE 'v1:%')
    AND ("encryptionKeyCiphertext" IS NULL OR "encryptionKeyCiphertext" LIKE 'v1:%')
  ),
  -- Chave e impressão digital andam juntas: uma sem a outra é estado corrompido (o agendador cifraria sem poder provar qual chave usou).
  ADD CONSTRAINT "backup_config_key_pair" CHECK (("encryptionKeyCiphertext" IS NULL) = ("encryptionKeyFingerprint" IS NULL));

ALTER TABLE "BackupRun"
  ADD CONSTRAINT "backup_run_size_nonneg" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0),
  -- Falhou <=> tem código de erro (e só código: texto livre pode carregar host/usuário do pg_dump ou resposta do destino).
  ADD CONSTRAINT "backup_run_error_code_iff_failed" CHECK (("status" = 'FAILED') = ("errorCode" IS NOT NULL)),
  ADD CONSTRAINT "backup_run_finished_when_terminal" CHECK (("status" IN ('SUCCESS', 'FAILED')) = ("finishedAt" IS NOT NULL)),
  ADD CONSTRAINT "backup_run_checksum_hex" CHECK ("checksumSha256" IS NULL OR "checksumSha256" ~ '^[0-9a-f]{64}$');

-- A linha singleton nasce junto, desligada: o agendador/telas nunca precisam "criar a config" (e o upsert da aplicação continua valendo como reserva).
INSERT INTO "BackupConfig" ("id", "updatedAt") VALUES (1, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;

-- ============================================================
-- ROLLBACK MANUAL (não automático)
-- ============================================================
-- DROP TABLE IF EXISTS "BackupRun";
-- DROP TABLE IF EXISTS "BackupConfig";
-- DROP TYPE IF EXISTS "BackupDestination";
-- DROP TYPE IF EXISTS "BackupRunStatus";
-- DROP TYPE IF EXISTS "BackupTrigger";
