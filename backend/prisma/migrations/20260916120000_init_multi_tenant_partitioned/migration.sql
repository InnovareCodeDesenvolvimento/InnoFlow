-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR', 'DRIVER');

-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('AC_TYPE2', 'DC_CCS2', 'DC_CHADEMO');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('AVAILABLE', 'PREPARING', 'CHARGING', 'SUSPENDED_EVSE', 'SUSPENDED_EV', 'FINISHING', 'RESERVED', 'UNAVAILABLE', 'FAULTED');

-- CreateEnum
CREATE TYPE "ChargingSessionStatus" AS ENUM ('STARTED', 'CHARGING', 'FINISHING', 'STOPPED', 'FAULTED');

-- CreateEnum
CREATE TYPE "StopReason" AS ENUM ('LOCAL', 'REMOTE', 'EV_DISCONNECTED', 'HARD_RESET', 'SOFT_RESET', 'POWER_LOSS', 'EMERGENCY_STOP', 'DEAUTHORIZED', 'UNLOCK_COMMAND', 'OTHER');

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('RFID', 'VIRTUAL', 'APP');

-- CreateEnum
CREATE TYPE "AuthTokenStatus" AS ENUM ('ACCEPTED', 'BLOCKED', 'EXPIRED', 'INVALID');

-- CreateEnum
CREATE TYPE "TariffModel" AS ENUM ('PER_KWH', 'PER_MINUTE', 'PER_SESSION', 'HYBRID');

-- CreateEnum
CREATE TYPE "TariffScope" AS ENUM ('CONNECTOR', 'CHARGE_POINT', 'SITE', 'OPERATOR');

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('CREDIT_CARD');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('CIELO_CARD', 'CIELO_PIX', 'WALLET');

-- CreateEnum
CREATE TYPE "PaymentIntentPurpose" AS ENUM ('SESSION_CARD_CAPTURE', 'WALLET_TOPUP_PIX');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURE_PENDING', 'CAPTURED', 'CANCELLED', 'DENIED', 'VOIDED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WalletEntryType" AS ENUM ('TOPUP_PIX', 'TOPUP_REFUND', 'CHARGE_DEBIT', 'ADJUSTMENT_CREDIT', 'ADJUSTMENT_DEBIT', 'REFUND');

-- CreateEnum
CREATE TYPE "DebtStatus" AS ENUM ('OPEN', 'SETTLED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "OcppDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "OcppMessageType" AS ENUM ('CALL', 'CALL_RESULT', 'CALL_ERROR');

-- ============================================================
-- Particionamento mensal (MeterSample, OcppMessage)
-- ============================================================
-- ~500 mil linhas/dia de MeterSample na escala alvo; OcppMessage (log bruto
-- do protocolo) cresce no mesmo ritmo. Particionar por mês desde a primeira
-- migration evita ter que reescrever uma tabela de centenas de milhões de
-- linhas depois. Índices ficam em (sessionId, ts) e (chargePointId,
-- occurredAt) — CREATE INDEX na tabela-mãe particionada propaga para todas
-- as partições (atuais e futuras) automaticamente no Postgres 11+.
--
-- ensure_monthly_partition cria a partição do mês se ainda não existir —
-- idempotente, seguro para rodar em loop/cron. Chamada aqui para os
-- primeiros meses; MANUTENÇÃO CONTÍNUA (criar os próximos meses com
-- antecedência) fica pendente de agendamento — ver handoff do Cronos.
CREATE OR REPLACE FUNCTION ensure_monthly_partition(
  parent_table text,
  partition_month date
) RETURNS void AS $$
DECLARE
  partition_name text := parent_table || '_' || to_char(partition_month, 'YYYY_MM');
  range_start date := date_trunc('month', partition_month)::date;
  range_end date := (date_trunc('month', partition_month) + interval '1 month')::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      partition_name, parent_table, range_start, range_end
    );
  END IF;
END;
$$ LANGUAGE plpgsql;

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "cnpj" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'BR',
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "openingHours" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargePoint" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "ocppIdentity" TEXT NOT NULL,
    "vendor" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "firmwareVersion" TEXT,
    "basicAuthSecretHash" TEXT NOT NULL,
    "configSnapshot" JSONB,
    "lastBootAt" TIMESTAMPTZ(3),
    "lastSeenAt" TIMESTAMPTZ(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChargePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "connectorId" INTEGER NOT NULL,
    "type" "ConnectorType" NOT NULL,
    "maxPowerKw" DECIMAL(6,2),
    "status" "ConnectorStatus" NOT NULL DEFAULT 'AVAILABLE',
    "statusUpdatedAt" TIMESTAMPTZ(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "operatorId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "idTag" VARCHAR(20) NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "userId" TEXT,
    "status" "AuthTokenStatus" NOT NULL DEFAULT 'ACCEPTED',
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tariff" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" "TariffModel" NOT NULL,
    "pricePerKwh" DECIMAL(12,4),
    "pricePerMinute" DECIMAL(12,4),
    "sessionFeeCents" INTEGER,
    "minChargeCents" INTEGER,
    "idleFeePerMinute" INTEGER NOT NULL DEFAULT 0,
    "idleGracePeriodSeconds" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'BRL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Tariff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TariffWindow" (
    "id" TEXT NOT NULL,
    "tariffId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "daysOfWeek" INTEGER[],
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "pricePerKwh" DECIMAL(12,4),
    "pricePerMinute" DECIMAL(12,4),
    "idleFeePerMinute" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TariffWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TariffAssignment" (
    "id" TEXT NOT NULL,
    "tariffId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "scope" "TariffScope" NOT NULL,
    "connectorId" TEXT,
    "chargePointId" TEXT,
    "siteId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TariffAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargingSession" (
    "id" TEXT NOT NULL,
    "ocppTransactionId" SERIAL NOT NULL,
    "operatorId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "authTokenId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ChargingSessionStatus" NOT NULL DEFAULT 'STARTED',
    "meterStartWh" INTEGER NOT NULL,
    "meterStopWh" INTEGER,
    "energyDeliveredWh" INTEGER,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "chargingEndedAt" TIMESTAMPTZ(3),
    "stoppedAt" TIMESTAMPTZ(3),
    "idleSeconds" INTEGER,
    "stopReason" "StopReason",
    "tariffId" TEXT NOT NULL,
    "tariffSnapshot" JSONB NOT NULL,
    "energyCostCents" INTEGER,
    "timeCostCents" INTEGER,
    "idleFeeCents" INTEGER,
    "sessionFeeCents" INTEGER,
    "minChargeAdjustmentCents" INTEGER,
    "totalCostCents" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChargingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterSample" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "chargePointId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "measurand" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "unit" TEXT,
    "context" TEXT,
    "phase" TEXT,
    "location" TEXT,
    "raw" JSONB,

    CONSTRAINT "MeterSample_pkey" PRIMARY KEY ("id","ts")
) PARTITION BY RANGE ("ts");

-- CreateTable
CREATE TABLE "OcppMessage" (
    "id" TEXT NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "direction" "OcppDirection" NOT NULL,
    "messageType" "OcppMessageType" NOT NULL,
    "ocppMessageId" TEXT NOT NULL,
    "action" TEXT,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OcppMessage_pkey" PRIMARY KEY ("id","occurredAt")
) PARTITION BY RANGE ("occurredAt");

-- Partições dos primeiros 6 meses (lançamento em 2026-09). Rodar
-- ensure_monthly_partition periodicamente (cron/job agendado — pendência
-- operacional, ver handoff) para manter sempre alguns meses de folga.
SELECT ensure_monthly_partition('MeterSample', '2026-09-01');
SELECT ensure_monthly_partition('MeterSample', '2026-10-01');
SELECT ensure_monthly_partition('MeterSample', '2026-11-01');
SELECT ensure_monthly_partition('MeterSample', '2026-12-01');
SELECT ensure_monthly_partition('MeterSample', '2027-01-01');
SELECT ensure_monthly_partition('MeterSample', '2027-02-01');
SELECT ensure_monthly_partition('OcppMessage', '2026-09-01');
SELECT ensure_monthly_partition('OcppMessage', '2026-10-01');
SELECT ensure_monthly_partition('OcppMessage', '2026-11-01');
SELECT ensure_monthly_partition('OcppMessage', '2026-12-01');
SELECT ensure_monthly_partition('OcppMessage', '2027-01-01');
SELECT ensure_monthly_partition('OcppMessage', '2027-02-01');

-- Partição DEFAULT — rede de segurança para linhas fora do range das
-- partições explícitas (relógio de carregador adiantado/atrasado, replay de
-- fila muito antiga). Deve ficar vazia em regime normal; monitorar seu
-- tamanho é sinal de partição faltando.
CREATE TABLE "MeterSample_default" PARTITION OF "MeterSample" DEFAULT;
CREATE TABLE "OcppMessage_default" PARTITION OF "OcppMessage" DEFAULT;

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PaymentMethodType" NOT NULL DEFAULT 'CREDIT_CARD',
    "cieloCardToken" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "holderName" TEXT,
    "expiryMonth" INTEGER,
    "expiryYear" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT,
    "purpose" "PaymentIntentPurpose" NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "userId" TEXT NOT NULL,
    "chargingSessionId" TEXT,
    "paymentMethodId" TEXT,
    "walletId" TEXT,
    "cieloPaymentId" TEXT,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'CREATED',
    "returnCode" TEXT,
    "amountRequestedCents" INTEGER NOT NULL,
    "amountAuthorizedCents" INTEGER,
    "amountCapturedCents" INTEGER,
    "pixQrCode" TEXT,
    "pixExpiresAt" TIMESTAMPTZ(3),
    "authorizedAt" TIMESTAMPTZ(3),
    "capturedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletEntryType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Debt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operatorId" TEXT,
    "chargingSessionId" TEXT,
    "paymentIntentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" "DebtStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT,
    "settledAt" TIMESTAMPTZ(3),
    "settledByWalletEntryId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Debt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "changeType" INTEGER NOT NULL,
    "paymentIntentId" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),
    "processingError" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operator_cnpj_key" ON "Operator"("cnpj");

-- CreateIndex
CREATE INDEX "Site_operatorId_idx" ON "Site"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "ChargePoint_ocppIdentity_key" ON "ChargePoint"("ocppIdentity");

-- CreateIndex
CREATE INDEX "ChargePoint_siteId_idx" ON "ChargePoint"("siteId");

-- CreateIndex
CREATE INDEX "ChargePoint_operatorId_idx" ON "ChargePoint"("operatorId");

-- CreateIndex
CREATE INDEX "Connector_operatorId_idx" ON "Connector"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_chargePointId_connectorId_key" ON "Connector"("chargePointId", "connectorId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_operatorId_idx" ON "User"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_idTag_key" ON "AuthToken"("idTag");

-- CreateIndex
CREATE INDEX "AuthToken_userId_idx" ON "AuthToken"("userId");

-- CreateIndex
CREATE INDEX "Tariff_operatorId_idx" ON "Tariff"("operatorId");

-- CreateIndex
CREATE INDEX "TariffWindow_tariffId_idx" ON "TariffWindow"("tariffId");

-- CreateIndex
CREATE INDEX "TariffAssignment_operatorId_idx" ON "TariffAssignment"("operatorId");

-- CreateIndex
CREATE INDEX "TariffAssignment_connectorId_idx" ON "TariffAssignment"("connectorId");

-- CreateIndex
CREATE INDEX "TariffAssignment_chargePointId_idx" ON "TariffAssignment"("chargePointId");

-- CreateIndex
CREATE INDEX "TariffAssignment_siteId_idx" ON "TariffAssignment"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ChargingSession_ocppTransactionId_key" ON "ChargingSession"("ocppTransactionId");

-- CreateIndex
CREATE INDEX "ChargingSession_operatorId_startedAt_idx" ON "ChargingSession"("operatorId", "startedAt");

-- CreateIndex
CREATE INDEX "ChargingSession_siteId_startedAt_idx" ON "ChargingSession"("siteId", "startedAt");

-- CreateIndex
CREATE INDEX "ChargingSession_userId_startedAt_idx" ON "ChargingSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "ChargingSession_chargePointId_startedAt_idx" ON "ChargingSession"("chargePointId", "startedAt");

-- CreateIndex
CREATE INDEX "ChargingSession_connectorId_idx" ON "ChargingSession"("connectorId");

-- CreateIndex
CREATE INDEX "MeterSample_sessionId_ts_idx" ON "MeterSample"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "MeterSample_chargePointId_ts_idx" ON "MeterSample"("chargePointId", "ts");

-- CreateIndex
CREATE INDEX "MeterSample_operatorId_ts_idx" ON "MeterSample"("operatorId", "ts");

-- CreateIndex
CREATE INDEX "OcppMessage_chargePointId_occurredAt_idx" ON "OcppMessage"("chargePointId", "occurredAt");

-- CreateIndex
CREATE INDEX "OcppMessage_operatorId_occurredAt_idx" ON "OcppMessage"("operatorId", "occurredAt");

-- CreateIndex
CREATE INDEX "PaymentMethod_userId_idx" ON "PaymentMethod"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_cieloPaymentId_key" ON "PaymentIntent"("cieloPaymentId");

-- CreateIndex
CREATE INDEX "PaymentIntent_operatorId_idx" ON "PaymentIntent"("operatorId");

-- CreateIndex
CREATE INDEX "PaymentIntent_userId_idx" ON "PaymentIntent"("userId");

-- CreateIndex
CREATE INDEX "PaymentIntent_status_idx" ON "PaymentIntent"("status");

-- CreateIndex
CREATE INDEX "PaymentIntent_chargingSessionId_idx" ON "PaymentIntent"("chargingSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE INDEX "WalletEntry_walletId_createdAt_idx" ON "WalletEntry"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "Debt_userId_status_idx" ON "Debt"("userId", "status");

-- CreateIndex
CREATE INDEX "Debt_operatorId_idx" ON "Debt"("operatorId");

-- CreateIndex
CREATE INDEX "WebhookEvent_paymentIntentId_idx" ON "WebhookEvent"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_externalId_changeType_key" ON "WebhookEvent"("provider", "externalId", "changeType");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargePoint" ADD CONSTRAINT "ChargePoint_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargePoint" ADD CONSTRAINT "ChargePoint_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "ChargePoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tariff" ADD CONSTRAINT "Tariff_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffWindow" ADD CONSTRAINT "TariffWindow_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "Tariff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffAssignment" ADD CONSTRAINT "TariffAssignment_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "Tariff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffAssignment" ADD CONSTRAINT "TariffAssignment_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffAssignment" ADD CONSTRAINT "TariffAssignment_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffAssignment" ADD CONSTRAINT "TariffAssignment_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "ChargePoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffAssignment" ADD CONSTRAINT "TariffAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargingSession" ADD CONSTRAINT "ChargingSession_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargingSession" ADD CONSTRAINT "ChargingSession_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargingSession" ADD CONSTRAINT "ChargingSession_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "ChargePoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargingSession" ADD CONSTRAINT "ChargingSession_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargingSession" ADD CONSTRAINT "ChargingSession_authTokenId_fkey" FOREIGN KEY ("authTokenId") REFERENCES "AuthToken"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargingSession" ADD CONSTRAINT "ChargingSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargingSession" ADD CONSTRAINT "ChargingSession_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "Tariff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterSample" ADD CONSTRAINT "MeterSample_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChargingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterSample" ADD CONSTRAINT "MeterSample_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "ChargePoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterSample" ADD CONSTRAINT "MeterSample_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcppMessage" ADD CONSTRAINT "OcppMessage_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "ChargePoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcppMessage" ADD CONSTRAINT "OcppMessage_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_chargingSessionId_fkey" FOREIGN KEY ("chargingSessionId") REFERENCES "ChargingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_chargingSessionId_fkey" FOREIGN KEY ("chargingSessionId") REFERENCES "ChargingSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Índices parciais (invariantes de negócio, não só performance)
-- ============================================================

-- Só uma sessão "viva" por conector por vez — impede dupla reserva do
-- mesmo conector físico mesmo se dois handlers OCPP correrem em paralelo.
CREATE UNIQUE INDEX "ux_charging_session_active_per_connector"
  ON "ChargingSession" ("connectorId")
  WHERE status IN ('STARTED', 'CHARGING', 'FINISHING');

-- Só um PaymentIntent "vivo" (não falho/cancelado/negado/expirado) por
-- sessão — permite reter histórico de tentativas falhas sem impedir retry.
CREATE UNIQUE INDEX "ux_payment_intent_active_per_session"
  ON "PaymentIntent" ("chargingSessionId")
  WHERE "chargingSessionId" IS NOT NULL
    AND status NOT IN ('FAILED', 'CANCELLED', 'DENIED', 'EXPIRED');

-- ============================================================
-- CHECK constraints — integridade por desenho, não por confiança no código
-- ============================================================

-- connectorId = 0 no OCPP é "o carregador inteiro" — nunca vira linha aqui.
ALTER TABLE "Connector"
  ADD CONSTRAINT "connector_connector_id_not_zero" CHECK ("connectorId" <> 0);

-- Exatamente uma FK de escopo preenchida, batendo com TariffAssignment.scope.
ALTER TABLE "TariffAssignment"
  ADD CONSTRAINT "tariff_assignment_scope_consistency" CHECK (
    (scope = 'CONNECTOR'    AND "connectorId" IS NOT NULL AND "chargePointId" IS NULL     AND "siteId" IS NULL) OR
    (scope = 'CHARGE_POINT' AND "chargePointId" IS NOT NULL AND "connectorId" IS NULL     AND "siteId" IS NULL) OR
    (scope = 'SITE'         AND "siteId" IS NOT NULL AND "connectorId" IS NULL           AND "chargePointId" IS NULL) OR
    (scope = 'OPERATOR'     AND "connectorId" IS NULL AND "chargePointId" IS NULL         AND "siteId" IS NULL)
  );

-- operatorId obrigatório se e só se role = OPERATOR (ADMIN e DRIVER ficam
-- sem operador — ver comentário no schema.prisma sobre DRIVER roaming).
ALTER TABLE "User"
  ADD CONSTRAINT "user_operator_role_consistency" CHECK (
    (role = 'OPERATOR' AND "operatorId" IS NOT NULL) OR
    (role <> 'OPERATOR' AND "operatorId" IS NULL)
  );

-- Status sozinho não prova aprovação da Cielo — returnCode é obrigatório
-- assim que o status vira AUTHORIZED ou CAPTURED.
ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "payment_intent_return_code_required" CHECK (
    status NOT IN ('AUTHORIZED', 'CAPTURED') OR "returnCode" IS NOT NULL
  );

-- SESSION_CARD_CAPTURE sempre aponta pra uma sessão (nunca carteira);
-- WALLET_TOPUP_PIX sempre aponta pra uma carteira (nunca sessão).
ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "payment_intent_purpose_consistency" CHECK (
    (purpose = 'SESSION_CARD_CAPTURE' AND "chargingSessionId" IS NOT NULL AND "walletId" IS NULL) OR
    (purpose = 'WALLET_TOPUP_PIX' AND "walletId" IS NOT NULL AND "chargingSessionId" IS NULL)
  );

-- Nenhum custo/duração calculado pode ficar negativo.
ALTER TABLE "ChargingSession"
  ADD CONSTRAINT "charging_session_costs_non_negative" CHECK (
    ("energyCostCents" IS NULL OR "energyCostCents" >= 0) AND
    ("timeCostCents" IS NULL OR "timeCostCents" >= 0) AND
    ("idleFeeCents" IS NULL OR "idleFeeCents" >= 0) AND
    ("sessionFeeCents" IS NULL OR "sessionFeeCents" >= 0) AND
    ("minChargeAdjustmentCents" IS NULL OR "minChargeAdjustmentCents" >= 0) AND
    ("totalCostCents" IS NULL OR "totalCostCents" >= 0) AND
    ("idleSeconds" IS NULL OR "idleSeconds" >= 0)
  );

ALTER TABLE "Tariff"
  ADD CONSTRAINT "tariff_idle_fee_non_negative" CHECK (
    "idleFeePerMinute" >= 0 AND "idleGracePeriodSeconds" >= 0
  );

-- ============================================================
-- Denormalização de operatorId por trigger (multi-tenant real)
-- ============================================================
-- Cada trigger deriva operatorId do pai canônico e SOBRESCREVE qualquer
-- valor que a aplicação tenha mandado — a coluna denormalizada nunca
-- diverge do dono real, mesmo se o Vega esquecer de setá-la certo.

CREATE OR REPLACE FUNCTION set_charge_point_operator_id() RETURNS trigger AS $$
BEGIN
  SELECT "operatorId" INTO NEW."operatorId" FROM "Site" WHERE id = NEW."siteId";
  IF NEW."operatorId" IS NULL THEN
    RAISE EXCEPTION 'Site % não encontrado ao derivar operatorId de ChargePoint', NEW."siteId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER charge_point_set_operator_id
  BEFORE INSERT OR UPDATE OF "siteId" ON "ChargePoint"
  FOR EACH ROW EXECUTE FUNCTION set_charge_point_operator_id();

CREATE OR REPLACE FUNCTION set_connector_operator_id() RETURNS trigger AS $$
BEGIN
  SELECT "operatorId" INTO NEW."operatorId" FROM "ChargePoint" WHERE id = NEW."chargePointId";
  IF NEW."operatorId" IS NULL THEN
    RAISE EXCEPTION 'ChargePoint % não encontrado ao derivar operatorId de Connector', NEW."chargePointId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER connector_set_operator_id
  BEFORE INSERT OR UPDATE OF "chargePointId" ON "Connector"
  FOR EACH ROW EXECUTE FUNCTION set_connector_operator_id();

CREATE OR REPLACE FUNCTION set_charging_session_denormalized_fields() RETURNS trigger AS $$
BEGIN
  SELECT "operatorId" INTO NEW."operatorId" FROM "Connector" WHERE id = NEW."connectorId";
  SELECT "siteId" INTO NEW."siteId" FROM "ChargePoint" WHERE id = NEW."chargePointId";
  IF NEW."operatorId" IS NULL THEN
    RAISE EXCEPTION 'Connector % não encontrado ao derivar operatorId de ChargingSession', NEW."connectorId";
  END IF;
  IF NEW."siteId" IS NULL THEN
    RAISE EXCEPTION 'ChargePoint % não encontrado ao derivar siteId de ChargingSession', NEW."chargePointId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER charging_session_set_denormalized_fields
  BEFORE INSERT OR UPDATE OF "connectorId", "chargePointId" ON "ChargingSession"
  FOR EACH ROW EXECUTE FUNCTION set_charging_session_denormalized_fields();

CREATE OR REPLACE FUNCTION set_meter_sample_operator_id() RETURNS trigger AS $$
BEGIN
  SELECT "operatorId" INTO NEW."operatorId" FROM "ChargePoint" WHERE id = NEW."chargePointId";
  IF NEW."operatorId" IS NULL THEN
    RAISE EXCEPTION 'ChargePoint % não encontrado ao derivar operatorId de MeterSample', NEW."chargePointId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meter_sample_set_operator_id
  BEFORE INSERT OR UPDATE OF "chargePointId" ON "MeterSample"
  FOR EACH ROW EXECUTE FUNCTION set_meter_sample_operator_id();

CREATE OR REPLACE FUNCTION set_ocpp_message_operator_id() RETURNS trigger AS $$
BEGIN
  SELECT "operatorId" INTO NEW."operatorId" FROM "ChargePoint" WHERE id = NEW."chargePointId";
  IF NEW."operatorId" IS NULL THEN
    RAISE EXCEPTION 'ChargePoint % não encontrado ao derivar operatorId de OcppMessage', NEW."chargePointId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ocpp_message_set_operator_id
  BEFORE INSERT OR UPDATE OF "chargePointId" ON "OcppMessage"
  FOR EACH ROW EXECUTE FUNCTION set_ocpp_message_operator_id();

-- PaymentIntent/Debt: só derivam operatorId quando têm uma sessão ligada
-- (SESSION_CARD_CAPTURE) — recarga de carteira (WALLET_TOPUP_PIX) e dívida
-- sem sessão de origem ficam com operatorId nulo mesmo, de propósito.
CREATE OR REPLACE FUNCTION set_payment_intent_operator_id() RETURNS trigger AS $$
BEGIN
  IF NEW."chargingSessionId" IS NOT NULL THEN
    SELECT "operatorId" INTO NEW."operatorId" FROM "ChargingSession" WHERE id = NEW."chargingSessionId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_intent_set_operator_id
  BEFORE INSERT OR UPDATE OF "chargingSessionId" ON "PaymentIntent"
  FOR EACH ROW EXECUTE FUNCTION set_payment_intent_operator_id();

CREATE OR REPLACE FUNCTION set_debt_operator_id() RETURNS trigger AS $$
BEGIN
  IF NEW."chargingSessionId" IS NOT NULL THEN
    SELECT "operatorId" INTO NEW."operatorId" FROM "ChargingSession" WHERE id = NEW."chargingSessionId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER debt_set_operator_id
  BEFORE INSERT OR UPDATE OF "chargingSessionId" ON "Debt"
  FOR EACH ROW EXECUTE FUNCTION set_debt_operator_id();

-- ============================================================
-- Carteira (Wallet) append-only — razão nunca se altera depois de escrita
-- ============================================================
-- Saldo é SOMA(amountCents), nunca UPDATE saldo = saldo - x. Reforçado
-- aqui por trigger, não só por convenção no código: nenhum UPDATE ou
-- DELETE passa nesta tabela, ponto.
CREATE OR REPLACE FUNCTION wallet_entry_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'WalletEntry é append-only — UPDATE/DELETE não são permitidos (id=%)',
    COALESCE(OLD.id, 'desconhecido');
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_entry_no_update
  BEFORE UPDATE ON "WalletEntry"
  FOR EACH ROW EXECUTE FUNCTION wallet_entry_append_only();

CREATE TRIGGER wallet_entry_no_delete
  BEFORE DELETE ON "WalletEntry"
  FOR EACH ROW EXECUTE FUNCTION wallet_entry_append_only();
