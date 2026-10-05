-- Configuração de comunicação (e-mail SMTP e WhatsApp/Evolution API) pelo painel ADMIN — avisos de alerta ao dono (N-7) e e-mail transacional.
-- Tabela SINGLETON (id = 1), mesmo desenho de "PaymentGatewayConfig": o painel manda, as envs ALERT_* são a reserva. Os campos *Ciphertext guardam o
-- segredo CIFRADO (AES-256-GCM, formato v1:<kid>:<base64>, chave PAYMENT_SECRETS_KEY — que vive só em env, nunca no banco).
-- Aditiva: só CREATE TABLE; não toca em nenhuma tabela existente.

CREATE TABLE "NotificationChannelConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,

    "emailEnabled" BOOLEAN,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
    "smtpUser" TEXT,
    "smtpPasswordCiphertext" TEXT,
    "emailFromName" TEXT,
    "emailFromAddress" TEXT,
    "alertEmailRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "emailMinSeverity" TEXT NOT NULL DEFAULT 'IMPORTANTE',

    "whatsappEnabled" BOOLEAN,
    "evolutionBaseUrl" TEXT,
    "evolutionInstance" TEXT,
    "evolutionApiKeyCiphertext" TEXT,
    "evolutionApiVersion" INTEGER NOT NULL DEFAULT 2,
    "alertWhatsappRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "whatsappMinSeverity" TEXT NOT NULL DEFAULT 'CRITICO',

    "alertDedupeMinutes" INTEGER,

    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationChannelConfig_pkey" PRIMARY KEY ("id")
);

-- Singleton de verdade (só a linha id = 1) e valores válidos reforçados no banco, não só na aplicação.
ALTER TABLE "NotificationChannelConfig"
  ADD CONSTRAINT "notification_channel_config_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "notification_channel_config_smtp_port" CHECK ("smtpPort" IS NULL OR ("smtpPort" BETWEEN 1 AND 65535)),
  ADD CONSTRAINT "notification_channel_config_evolution_version" CHECK ("evolutionApiVersion" IN (1, 2)),
  ADD CONSTRAINT "notification_channel_config_email_min_severity" CHECK ("emailMinSeverity" IN ('INFO', 'IMPORTANTE', 'CRITICO')),
  ADD CONSTRAINT "notification_channel_config_whatsapp_min_severity" CHECK ("whatsappMinSeverity" IN ('INFO', 'IMPORTANTE', 'CRITICO')),
  ADD CONSTRAINT "notification_channel_config_dedupe_minutes" CHECK ("alertDedupeMinutes" IS NULL OR ("alertDedupeMinutes" BETWEEN 1 AND 1440));

-- ============================================================
-- ROLLBACK MANUAL (não automático)
-- ============================================================
-- DROP TABLE IF EXISTS "NotificationChannelConfig";
