-- ============================================================
-- Lote 1 da F6 (Cronos, 2026-10-05) — PARTE 2/2: LGPD, notificações, estorno/chargeback, termos de uso.
-- ============================================================
-- Desenho, estados, invariantes e leitura/escrita por item (L1.3/L1.4/L1.6/L1.8/L1.9): docs/MODELO-DADOS-LOTE1.md. Decisões do dono: DL1-DL8 (PROGRESSO.md).
-- Contrato literal: frontend/src/types/api.ts (commit 5ef6386). A parte 1 (20261005150000) adicionou os valores de AuditAction.
--
-- ESTRATÉGIA (expand puro — nada é removido, renomeado nem reinterpretado; todo o código atual segue funcionando sem mudança):
--   * Tabelas existentes só ganham COLUNAS NULÁVEIS sem DEFAULT (User.deletedAt, ChargingSession.startIp/startUserAgent) = só catálogo, sem reescrever a tabela
--     nem tomar lock longo; e CHECKs `NOT VALID` + `VALIDATE` (a validação só pede SHARE UPDATE EXCLUSIVE; um CHECK novo direto seria ACCESS EXCLUSIVE durante o scan).
--   * Tabelas novas nascem vazias: FKs/índices/CHECKs/triggers normais, sem CONCURRENTLY nem NOT VALID (não há linha para travar).
--   * Nenhum DEFAULT "pesado" em tabela existente.
--
-- Por que ANONIMIZAÇÃO (LGPD, DL2/DL3): todas as FKs para User são Restrict e WalletEntry/AuditLog são append-only por trigger; o registro financeiro tem de
-- sobreviver (art. 16 da LGPD). A pessoa some, o fato contábil fica ligado a um id pseudônimo. O banco GARANTE o estado anonimizado (CHECK user_deleted_is_anonymized).
--
-- NÃO MEXE em: triggers de append-only (WalletEntry, AuditLog) — a anonimização do snapshot de ator do AuditLog fica como DECISÃO DO DONO/ÓRION (ver doc §3.5);
-- conciliação (`paymentsService`) — estorno/chargeback continuam informativos; nenhum índice/constraint existente.

-- ------------------------------------------------------------
-- 1) Enums novos (CREATE TYPE: pode criar e usar na mesma transação)
-- ------------------------------------------------------------

CREATE TYPE "AccountDeletionRefundStatus" AS ENUM ('NOT_REQUIRED', 'PENDING_REFUND', 'REFUNDED');

CREATE TYPE "NotificationType" AS ENUM ('SESSION_COMPLETED', 'SESSION_PAYMENT_FAILED', 'SESSION_CLOSED_BY_SERVER', 'LOW_BALANCE', 'TOPUP_CREDITED', 'REMOTE_START_BY_SUPPORT', 'PASSWORD_CHANGED', 'ACCOUNT_DELETED');

CREATE TYPE "NotificationDeliveryChannel" AS ENUM ('EMAIL');

CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TYPE "ConsentKind" AS ENUM ('TERMS', 'PRIVACY');

CREATE TYPE "ConsentSource" AS ENUM ('REGISTER', 'GOOGLE_SIGNUP', 'REACCEPT');

CREATE TYPE "PaymentReversalKind" AS ENUM ('REFUND', 'CHARGEBACK');

CREATE TYPE "PaymentReversalStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED', 'OPEN', 'WON', 'LOST', 'ACCEPTED');

CREATE TYPE "RefundDestination" AS ENUM ('WALLET', 'CARD_VIA_PORTAL');

-- ------------------------------------------------------------
-- 2) Colunas novas em tabelas existentes (nuláveis, sem DEFAULT: metadata-only)
-- ------------------------------------------------------------

ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMPTZ(3);

ALTER TABLE "ChargingSession" ADD COLUMN "startIp" VARCHAR(64),
ADD COLUMN "startUserAgent" VARCHAR(512);

-- ------------------------------------------------------------
-- 3) LGPD — o BANCO garante que "conta excluída" = anonimizada
-- ------------------------------------------------------------
-- Tombstone: `email = 'excluido+' || id || '@anon.invalid'` é ÚNICO por construção (o id é único), então não colide com o índice único de e-mail e LIBERA o e-mail
-- original para um novo cadastro. `googleSub`/`cpf` voltam a NULL (índices únicos não olham NULL) e liberam o Google/CPF originais; `phone` não é único.
-- `.invalid` é TLD reservado (RFC 2606): nunca resolve, e o e-mail nunca é entregue por engano. Só DRIVER é excluível por este fluxo (staff é desativado, não
-- anonimizado). `sessionsValidAfter` preenchido garante a revogação de TODAS as sessões/SSE no mesmo UPDATE.
--
-- CHECK `NOT VALID` + `VALIDATE`: nenhuma linha existente tem deletedAt, então a validação passa trivialmente; em tabela grande isso evita o ACCESS EXCLUSIVE do scan.
ALTER TABLE "User"
  ADD CONSTRAINT "user_deleted_is_anonymized" CHECK (
    "deletedAt" IS NULL
    OR (
      "role" = 'DRIVER'
      AND "active" = false
      AND "name" = 'Conta excluída'
      AND "email" = 'excluido+' || "id" || '@anon.invalid'
      AND "passwordHash" IS NULL
      AND "googleSub" IS NULL
      AND "cpf" IS NULL
      AND "phone" IS NULL
      AND "sessionsValidAfter" IS NOT NULL
    )
  ) NOT VALID;
ALTER TABLE "User" VALIDATE CONSTRAINT "user_deleted_is_anonymized";

-- Sem "ressuscitar": depois de excluída a conta não volta (o CHECK acima já impede restaurar credenciais/PII; isto impede só zerar o deletedAt).
CREATE OR REPLACE FUNCTION user_deleted_is_irreversible() RETURNS trigger AS $$
BEGIN
  IF OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN
    RAISE EXCEPTION 'User %: conta já excluída/anonimizada em % — não há como desfazer', OLD.id, OLD."deletedAt"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_deleted_irreversible
  BEFORE UPDATE OF "deletedAt" ON "User"
  FOR EACH ROW EXECUTE FUNCTION user_deleted_is_irreversible();

-- Cartão excluído: a coluna do token continua NOT NULL (não muda o tipo do Prisma Client que o Vega já usa). "Destruído" = marcador literal 'DESTROYED' (não é
-- ciphertext válido: tentar decifrar falha alto) E o cartão inativo e fora de "padrão". O CHECK impede o marcador num cartão ativo.
ALTER TABLE "PaymentMethod"
  ADD CONSTRAINT "payment_method_destroyed_token_inactive" CHECK (
    "cieloCardTokenCiphertext" <> 'DESTROYED' OR ("active" = false AND "isDefault" = false)
  ) NOT VALID;
ALTER TABLE "PaymentMethod" VALIDATE CONSTRAINT "payment_method_destroyed_token_inactive";

-- Sinal por tipo nas entradas da carteira (convenção do schema: crédito > 0, débito < 0). Os dois tipos NÃO têm escritor hoje (nenhuma linha existente), mas é por
-- eles que o lote 1 vai passar a escrever: REFUND (estorno para a carteira, crédito) e TOPUP_REFUND (devolução do saldo de conta excluída por Pix manual, DÉBITO
-- da carteira). NÃO restringe ADJUSTMENT_*: a decisão da Nova de não travar correção contábil (sem CHECK de saldo >= 0) continua valendo.
ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "wallet_entry_refund_sign" CHECK (
    ("type" <> 'REFUND' OR "amountCents" > 0)
    AND ("type" <> 'TOPUP_REFUND' OR "amountCents" < 0)
  ) NOT VALID;
ALTER TABLE "WalletEntry" VALIDATE CONSTRAINT "wallet_entry_refund_sign";

-- ------------------------------------------------------------
-- 4) AccountDeletionRequest — um pedido por conta excluída (DL2/DL3)
-- ------------------------------------------------------------

CREATE TABLE "AccountDeletionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "balanceCentsAtRequest" INTEGER NOT NULL,
    "refundStatus" "AccountDeletionRefundStatus" NOT NULL,
    "refundPixKeyCiphertext" TEXT,
    "refundedAmountCents" INTEGER,
    "refundProofReference" VARCHAR(120),
    "refundedAt" TIMESTAMPTZ(3),
    "refundedByUserId" TEXT,
    "refundWalletEntryId" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountDeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountDeletionRequest_userId_key" ON "AccountDeletionRequest"("userId");
CREATE UNIQUE INDEX "AccountDeletionRequest_refundWalletEntryId_key" ON "AccountDeletionRequest"("refundWalletEntryId");

ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_refundedByUserId_fkey" FOREIGN KEY ("refundedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_refundWalletEntryId_fkey" FOREIGN KEY ("refundWalletEntryId") REFERENCES "WalletEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fila do ADMIN ("GET /api/admin/account-deletions?status=PENDING_REFUND", mais antigo primeiro): só as linhas pendentes, que serão sempre poucas.
-- Sem índice em refundedByUserId: FK Restrict para User, e User nunca é apagado (Restrict em todo o schema) — o índice só serviria a um DELETE que não existe.
CREATE INDEX "ix_account_deletion_pending" ON "AccountDeletionRequest" ("requestedAt") WHERE "refundStatus" = 'PENDING_REFUND';

ALTER TABLE "AccountDeletionRequest"
  ADD CONSTRAINT "account_deletion_balance_non_negative" CHECK ("balanceCentsAtRequest" >= 0),
  -- A chave Pix é dado pessoal: só é aceita CIFRADA (formato do aesGcm.ts: v1:<kid de 8 hex>:<base64>). CPF/telefone/e-mail/chave aleatória em claro NÃO casam.
  ADD CONSTRAINT "account_deletion_pix_key_is_ciphertext" CHECK (
    "refundPixKeyCiphertext" IS NULL OR "refundPixKeyCiphertext" ~ '^v1:[0-9a-f]{8}:[A-Za-z0-9+/]+={0,2}$'
  ),
  -- Máquina de estados reforçada no banco (o que existe em cada estado):
  --   NOT_REQUIRED: saldo zero, sem chave, sem nada de reembolso;
  --   PENDING_REFUND: saldo > 0, chave guardada (cifrada), nada de reembolso ainda;
  --   REFUNDED: chave APAGADA, valor entre 1 e o saldo do pedido, comprovante, quando/quem, e o WalletEntry TOPUP_REFUND.
  ADD CONSTRAINT "account_deletion_status_consistency" CHECK (
    (
      "refundStatus" = 'NOT_REQUIRED'
      AND "balanceCentsAtRequest" = 0
      AND "refundPixKeyCiphertext" IS NULL
      AND "refundedAmountCents" IS NULL AND "refundProofReference" IS NULL AND "refundedAt" IS NULL
      AND "refundedByUserId" IS NULL AND "refundWalletEntryId" IS NULL
    ) OR (
      "refundStatus" = 'PENDING_REFUND'
      AND "balanceCentsAtRequest" > 0
      AND "refundPixKeyCiphertext" IS NOT NULL
      AND "refundedAmountCents" IS NULL AND "refundProofReference" IS NULL AND "refundedAt" IS NULL
      AND "refundedByUserId" IS NULL AND "refundWalletEntryId" IS NULL
    ) OR (
      "refundStatus" = 'REFUNDED'
      AND "balanceCentsAtRequest" > 0
      AND "refundPixKeyCiphertext" IS NULL
      AND "refundedAmountCents" BETWEEN 1 AND "balanceCentsAtRequest"
      AND "refundProofReference" IS NOT NULL AND length(btrim("refundProofReference")) > 0
      AND "refundedAt" IS NOT NULL AND "refundedByUserId" IS NOT NULL AND "refundWalletEntryId" IS NOT NULL
    )
  );

-- Imutabilidade: quem/quando/quanto-saldo nunca mudam; NOT_REQUIRED e REFUNDED são terminais (nenhuma coluna muda mais); a linha nunca é apagada.
CREATE OR REPLACE FUNCTION account_deletion_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AccountDeletionRequest é registro de prova da exclusão — DELETE não é permitido (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."balanceCentsAtRequest" IS DISTINCT FROM OLD."balanceCentsAtRequest" THEN
    RAISE EXCEPTION 'AccountDeletionRequest: userId/requestedAt/balanceCentsAtRequest são imutáveis (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."refundStatus" IN ('NOT_REQUIRED', 'REFUNDED')
     AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'AccountDeletionRequest: estado terminal % não muda mais (id=%)', OLD."refundStatus", OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_deletion_request_no_update_of_proof
  BEFORE UPDATE ON "AccountDeletionRequest"
  FOR EACH ROW EXECUTE FUNCTION account_deletion_request_guard();

CREATE TRIGGER account_deletion_request_no_delete
  BEFORE DELETE ON "AccountDeletionRequest"
  FOR EACH ROW EXECUTE FUNCTION account_deletion_request_guard();

-- ------------------------------------------------------------
-- 5) Notificações (L1.6, DL5)
-- ------------------------------------------------------------

-- Preferências: 1:1 com o usuário, criada sob demanda. Só o que é OPCIONAL existe como coluna (DL5): não há como persistir opt-out de segurança/cobrança.
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "sessionReceiptEmail" BOOLEAN NOT NULL DEFAULT true,
    "lowBalanceEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lowBalanceThresholdCents" INTEGER NOT NULL DEFAULT 2000,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Limites do contrato (LOW_BALANCE_THRESHOLD_MIN/MAX_CENTS): R$ 5,00 a R$ 500,00.
ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "notification_preference_threshold_range" CHECK ("lowBalanceThresholdCents" BETWEEN 500 AND 50000);

-- Outbox + idempotência. Chave: (userId, type, channel, entityId).
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationDeliveryChannel" NOT NULL DEFAULT 'EMAIL',
    "entityId" VARCHAR(128) NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "statusReason" VARCHAR(64),
    "providerMessageId" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationLog_userId_type_channel_entityId_key" ON "NotificationLog"("userId", "type", "channel", "entityId");
-- Retenção de 12 meses (expurgo por idade em lote) e leitura recente.
CREATE INDEX "NotificationLog_createdAt_idx" ON "NotificationLog"("createdAt");
-- Varredor de job perdido (Redis caiu entre o INSERT e o enqueue): só as pendentes, ordenadas por idade.
CREATE INDEX "ix_notification_log_pending" ON "NotificationLog" ("createdAt") WHERE "status" = 'PENDING';

ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NotificationLog"
  ADD CONSTRAINT "notification_log_attempts_non_negative" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "notification_log_entity_id_not_blank" CHECK (length(btrim("entityId")) > 0),
  -- SEM PII por desenho: o motivo é um CÓDIGO (ex.: SMTP_550, ETIMEDOUT, PREFERENCE_OFF). Mensagem de erro do SMTP costuma repetir o destinatário; espaço e
  -- `@` não passam neste padrão, então um e-mail ou frase colada aqui é recusado pelo banco.
  ADD CONSTRAINT "notification_log_status_reason_is_code" CHECK ("statusReason" IS NULL OR "statusReason" ~ '^[A-Za-z0-9_.-]+$'),
  ADD CONSTRAINT "notification_log_status_consistency" CHECK (
    ("status" = 'SENT') = ("sentAt" IS NOT NULL)
    AND ("status" NOT IN ('FAILED', 'SKIPPED') OR "statusReason" IS NOT NULL)
  );

-- SENT e SKIPPED são terminais (não existe "reenviar" o que já foi entregue ou dispensado: seria o 2º e-mail do mesmo fato); FAILED pode voltar a PENDING
-- (reenfileiramento manual). A chave do fato nunca muda.
CREATE OR REPLACE FUNCTION notification_log_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."channel" IS DISTINCT FROM OLD."channel" OR NEW."entityId" IS DISTINCT FROM OLD."entityId" THEN
    RAISE EXCEPTION 'NotificationLog: a chave do fato (userId, type, channel, entityId) é imutável (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('SENT', 'SKIPPED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'NotificationLog: estado terminal % não volta atrás (id=%)', OLD."status", OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_log_guard
  BEFORE UPDATE ON "NotificationLog"
  FOR EACH ROW EXECUTE FUNCTION notification_log_guard();

-- ------------------------------------------------------------
-- 6) ConsentRecord — prova do aceite de termos/privacidade (L1.9)
-- ------------------------------------------------------------

CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ConsentKind" NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "ConsentSource" NOT NULL,
    "ip" VARCHAR(64),

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- Idempotência do aceite (reaceite da mesma versão = nada novo) e a consulta "este usuário já aceitou a versão X do documento Y". Serve também a "última
-- versão aceita" (prefixo userId, kind). Sem outro índice: são poucas linhas por usuário.
CREATE UNIQUE INDEX "ConsentRecord_userId_kind_version_key" ON "ConsentRecord"("userId", "kind", "version");

ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConsentRecord"
  ADD CONSTRAINT "consent_record_version_not_blank" CHECK (length(btrim("version")) > 0);

-- Append-only (é a PROVA do aceite, art. 8º §2º da LGPD) com UMA exceção deliberada e estreita: o `ip` pode ser ZERADO (anonimização na exclusão da conta);
-- nenhuma outra coluna muda e a linha nunca é apagada.
CREATE OR REPLACE FUNCTION consent_record_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ConsentRecord é prova do aceite — DELETE não é permitido (id=%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt" OR NEW."source" IS DISTINCT FROM OLD."source" THEN
    RAISE EXCEPTION 'ConsentRecord é append-only — só o ip pode ser zerado (id=%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ip" IS NOT NULL AND NEW."ip" IS DISTINCT FROM OLD."ip" THEN
    RAISE EXCEPTION 'ConsentRecord: o ip só pode ser zerado, não reescrito (id=%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_record_guard_update
  BEFORE UPDATE ON "ConsentRecord"
  FOR EACH ROW EXECUTE FUNCTION consent_record_guard();

CREATE TRIGGER consent_record_guard_delete
  BEFORE DELETE ON "ConsentRecord"
  FOR EACH ROW EXECUTE FUNCTION consent_record_guard();

-- ------------------------------------------------------------
-- 7) PaymentReversal — razão de estornos e chargebacks (L1.8, DL7/DL8)
-- ------------------------------------------------------------

CREATE TABLE "PaymentReversal" (
    "id" TEXT NOT NULL,
    "kind" "PaymentReversalKind" NOT NULL,
    "status" "PaymentReversalStatus" NOT NULL,
    "destination" "RefundDestination",
    "chargingSessionId" TEXT,
    "paymentIntentId" TEXT,
    "userId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" VARCHAR(500),
    "portalReference" VARCHAR(120),
    "caseReference" VARCHAR(120),
    "reasonCode" VARCHAR(40),
    "notifiedAt" TIMESTAMPTZ(3),
    "responseDeadline" TIMESTAMPTZ(3),
    "dossierSnapshot" JSONB,
    "walletEntryId" TEXT,
    "debtId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedByUserId" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentReversal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentReversal_walletEntryId_key" ON "PaymentReversal"("walletEntryId");
CREATE UNIQUE INDEX "PaymentReversal_debtId_key" ON "PaymentReversal"("debtId");
CREATE INDEX "PaymentReversal_chargingSessionId_idx" ON "PaymentReversal"("chargingSessionId");
CREATE INDEX "PaymentReversal_paymentIntentId_idx" ON "PaymentReversal"("paymentIntentId");

ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_chargingSessionId_fkey" FOREIGN KEY ("chargingSessionId") REFERENCES "ChargingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_walletEntryId_fkey" FOREIGN KEY ("walletEntryId") REFERENCES "WalletEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Um chargeback por venda (409 CHARGEBACK_ALREADY_REGISTERED), mesmo sob duas requisições concorrentes. Estornos de uma mesma venda podem ser vários (parciais).
CREATE UNIQUE INDEX "ux_payment_reversal_chargeback_per_intent" ON "PaymentReversal" ("paymentIntentId") WHERE "kind" = 'CHARGEBACK';

-- Bloqueio do modo cartão (CardEligibilityReason = CHARGEBACK_BLOCKED) é DERIVADO, sem flag em User: o motorista está bloqueado se existir chargeback dele OPEN,
-- LOST ou ACCEPTED (WON devolve o modo cartão). A consulta do `POST /api/me/sessions/start` e do cadastro de cartão:
--   SELECT 1 FROM "PaymentReversal" WHERE "userId" = $1 AND "kind" = 'CHARGEBACK' AND "status" IN ('OPEN','LOST','ACCEPTED') LIMIT 1
-- é atendida por este índice parcial (a linha do motorista dentro dele, se existir).
CREATE INDEX "ix_payment_reversal_card_block" ON "PaymentReversal" ("userId") WHERE "kind" = 'CHARGEBACK' AND "status" IN ('OPEN', 'LOST', 'ACCEPTED');

-- Fila do job que reconsulta estornos feitos no portal da Cielo e marca CONFIRMED (mais antigo primeiro).
CREATE INDEX "ix_payment_reversal_pending_confirmation" ON "PaymentReversal" ("createdAt") WHERE "status" = 'PENDING_CONFIRMATION';

-- Sem índice em userId (geral), createdByUserId e resolvedByUserId: tabela de eventos manuais do ADMIN (dezenas por ano), FKs Restrict para User, que nunca é apagado.

ALTER TABLE "PaymentReversal"
  ADD CONSTRAINT "payment_reversal_amount_positive" CHECK ("amountCents" > 0),
  -- O PRAZO do chargeback não pode ser anterior ao aviso.
  ADD CONSTRAINT "payment_reversal_deadline_after_notice" CHECK ("responseDeadline" IS NULL OR "notifiedAt" IS NULL OR "responseDeadline" >= "notifiedAt"),
  -- O dossiê é um OBJETO JSON de até 4 MiB (a curva de medição deve ser amostrada pela aplicação; estourar = erro claro, não tabela inchada).
  ADD CONSTRAINT "payment_reversal_dossier_size" CHECK ("dossierSnapshot" IS NULL OR pg_column_size("dossierSnapshot") <= 4194304),
  -- A FORMA de cada tipo (o que é obrigatório e o que é proibido) e os estados válidos de cada um.
  ADD CONSTRAINT "payment_reversal_shape" CHECK (
    (
      "kind" = 'REFUND'
      AND "status" IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED')
      AND "destination" IS NOT NULL
      AND "chargingSessionId" IS NOT NULL
      AND "reason" IS NOT NULL AND length(btrim("reason")) > 0
      AND "caseReference" IS NULL AND "reasonCode" IS NULL AND "notifiedAt" IS NULL AND "responseDeadline" IS NULL
      AND "dossierSnapshot" IS NULL AND "debtId" IS NULL
    ) OR (
      "kind" = 'CHARGEBACK'
      AND "status" IN ('OPEN', 'WON', 'LOST', 'ACCEPTED')
      AND "destination" IS NULL
      AND "paymentIntentId" IS NOT NULL
      AND "caseReference" IS NOT NULL AND length(btrim("caseReference")) > 0
      AND "notifiedAt" IS NOT NULL
      AND "dossierSnapshot" IS NOT NULL AND jsonb_typeof("dossierSnapshot") = 'object'
      AND "walletEntryId" IS NULL AND "portalReference" IS NULL AND "reason" IS NULL
    )
  ),
  -- Destino do estorno: CARD_VIA_PORTAL é sempre sobre uma venda de cartão e é o ÚNICO que fica pendente; WALLET nasce CONFIRMED com o WalletEntry REFUND e
  -- só ele tem walletEntryId. Estorno CONFIRMED na carteira sem lançamento (ou lançamento num estorno de cartão) é impossível.
  ADD CONSTRAINT "payment_reversal_destination_rules" CHECK (
    ("destination" IS DISTINCT FROM 'CARD_VIA_PORTAL' OR "paymentIntentId" IS NOT NULL)
    AND ("portalReference" IS NULL OR "destination" = 'CARD_VIA_PORTAL')
    AND ("destination" IS DISTINCT FROM 'WALLET' OR "status" = 'CONFIRMED')
    AND (COALESCE("destination" = 'WALLET', false) = ("walletEntryId" IS NOT NULL))
  ),
  -- Saída do estado pendente/aberto: resolvedAt só existe depois dela; o desfecho do chargeback exige o ADMIN que decidiu; dívida só em chargeback perdido.
  ADD CONSTRAINT "payment_reversal_resolution" CHECK (
    (("status" IN ('PENDING_CONFIRMATION', 'OPEN')) = ("resolvedAt" IS NULL))
    AND ("resolvedByUserId" IS NULL OR "resolvedAt" IS NOT NULL)
    AND ("status" NOT IN ('WON', 'LOST', 'ACCEPTED') OR "resolvedByUserId" IS NOT NULL)
    AND ("debtId" IS NULL OR "status" IN ('LOST', 'ACCEPTED'))
  );

-- ---- BEFORE INSERT: deriva o pagador, valida coerência sessão x venda e impõe os TETOS (sob lock da sessão) ----
-- Lock FOR NO KEY UPDATE na sessão: serializa estornos concorrentes da MESMA sessão (a 2ª inserção só soma depois de a 1ª commitar) sem bloquear os
-- inserts de MeterSample/PaymentIntent que só pedem FOR KEY SHARE na sessão. A venda (PaymentIntent) é só LIDA, sem lock: todo estorno carrega a sessão e é
-- ela quem serializa; o chargeback é serializado pelo índice único parcial. Ordem de lock para a aplicação seguir: SESSÃO primeiro, depois a venda.
-- Os tetos são do BANCO e são o limite SUPERIOR (valor total da sessão / valor capturado); "o que de fato foi cobrado" (ex.: sessão que virou dívida) é
-- regra mais fina da aplicação (409 SESSION_NOT_BILLED) — o banco não deixa passar do teto nem se a aplicação errar.
CREATE OR REPLACE FUNCTION payment_reversal_before_insert() RETURNS trigger AS $$
DECLARE
  v_session_user   text;
  v_session_total  integer;
  v_intent_user    text;
  v_intent_session text;
  v_intent_prov    "PaymentProvider";
  v_intent_capt    integer;
  v_reserved       bigint;
BEGIN
  IF NEW."paymentIntentId" IS NOT NULL THEN
    SELECT pi."userId", pi."chargingSessionId", pi."provider", pi."amountCapturedCents"
      INTO v_intent_user, v_intent_session, v_intent_prov, v_intent_capt
      FROM "PaymentIntent" pi WHERE pi.id = NEW."paymentIntentId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PaymentReversal: PaymentIntent % não existe', NEW."paymentIntentId" USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_intent_prov <> 'CIELO_CARD' THEN
      RAISE EXCEPTION 'PaymentReversal: só venda de cartão (CIELO_CARD) tem estorno/chargeback (intent %, provider %)', NEW."paymentIntentId", v_intent_prov
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."chargingSessionId" IS NULL THEN
      NEW."chargingSessionId" := v_intent_session;
    ELSIF v_intent_session IS DISTINCT FROM NEW."chargingSessionId" THEN
      RAISE EXCEPTION 'PaymentReversal: o PaymentIntent % não pertence à sessão %', NEW."paymentIntentId", NEW."chargingSessionId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."chargingSessionId" IS NOT NULL THEN
    SELECT cs."userId", cs."totalCostCents" INTO v_session_user, v_session_total
      FROM "ChargingSession" cs WHERE cs.id = NEW."chargingSessionId" FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PaymentReversal: sessão % não existe', NEW."chargingSessionId" USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF v_intent_user IS NOT NULL AND v_session_user IS NOT NULL AND v_intent_user <> v_session_user THEN
    RAISE EXCEPTION 'PaymentReversal: a venda % e a sessão % são de pagadores diferentes', NEW."paymentIntentId", NEW."chargingSessionId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- A aplicação não decide quem é o pagador: o banco copia (mesmo padrão dos triggers de operatorId).
  NEW."userId" := COALESCE(v_intent_user, v_session_user, NEW."userId");

  IF NEW."kind" = 'CHARGEBACK' THEN
    IF NEW."amountCents" > COALESCE(v_intent_capt, 0) THEN
      RAISE EXCEPTION 'PaymentReversal: chargeback de % excede o capturado (%) na venda %', NEW."amountCents", COALESCE(v_intent_capt, 0), NEW."paymentIntentId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'REFUND' AND NEW."status" <> 'CANCELLED' THEN
    IF NEW."chargingSessionId" IS NULL THEN
      RAISE EXCEPTION 'payment_reversal_shape: estorno exige a sessão (chargingSessionId)' USING ERRCODE = 'check_violation';
    END IF;
    IF v_session_total IS NULL THEN
      RAISE EXCEPTION 'SESSION_NOT_BILLED: sessão % sem totalCostCents — não há o que estornar', NEW."chargingSessionId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM(r."amountCents"), 0) INTO v_reserved
      FROM "PaymentReversal" r
     WHERE r."chargingSessionId" = NEW."chargingSessionId" AND r."kind" = 'REFUND' AND r."status" <> 'CANCELLED';
    IF v_reserved + NEW."amountCents" > v_session_total THEN
      RAISE EXCEPTION 'AMOUNT_EXCEEDS_REFUNDABLE: estornos da sessão % somariam % (> total % da sessão)', NEW."chargingSessionId", v_reserved + NEW."amountCents", v_session_total
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."destination" = 'CARD_VIA_PORTAL' THEN
      IF NEW."paymentIntentId" IS NULL THEN
        RAISE EXCEPTION 'payment_reversal_destination_rules: devolução no cartão exige a venda (paymentIntentId)' USING ERRCODE = 'check_violation';
      END IF;
      SELECT COALESCE(SUM(r."amountCents"), 0) INTO v_reserved
        FROM "PaymentReversal" r
       WHERE r."paymentIntentId" = NEW."paymentIntentId" AND r."kind" = 'REFUND' AND r."destination" = 'CARD_VIA_PORTAL' AND r."status" <> 'CANCELLED';
      IF v_reserved + NEW."amountCents" > COALESCE(v_intent_capt, 0) THEN
        RAISE EXCEPTION 'AMOUNT_EXCEEDS_REFUNDABLE: devoluções no cartão da venda % somariam % (> capturado %)', NEW."paymentIntentId", v_reserved + NEW."amountCents", COALESCE(v_intent_capt, 0)
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_reversal_before_insert
  BEFORE INSERT ON "PaymentReversal"
  FOR EACH ROW EXECUTE FUNCTION payment_reversal_before_insert();

-- ---- BEFORE UPDATE / DELETE: o que foi registrado não se reescreve; estados terminais são terminais; nada é apagado ----
CREATE OR REPLACE FUNCTION payment_reversal_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PaymentReversal é registro financeiro — DELETE não é permitido (id=%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Imutáveis: o fato registrado (tipo, vínculos, valor, motivo, dossiê, quem registrou e quando). Mudam só status, resolução, dívida e referências do portal/prazo.
  IF (NEW."id", NEW."kind", NEW."destination", NEW."chargingSessionId", NEW."paymentIntentId", NEW."userId", NEW."amountCents", NEW."reason",
      NEW."caseReference", NEW."notifiedAt", NEW."dossierSnapshot", NEW."walletEntryId", NEW."createdByUserId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."kind", OLD."destination", OLD."chargingSessionId", OLD."paymentIntentId", OLD."userId", OLD."amountCents", OLD."reason",
      OLD."caseReference", OLD."notifiedAt", OLD."dossierSnapshot", OLD."walletEntryId", OLD."createdByUserId", OLD."createdAt") THEN
    RAISE EXCEPTION 'PaymentReversal: tipo, vínculos, valor, motivo, dossiê e autoria são imutáveis (id=%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('CONFIRMED', 'CANCELLED', 'WON', 'LOST', 'ACCEPTED')
     AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'PaymentReversal: estado terminal % não muda mais (id=%)', OLD."status", OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_reversal_guard_update
  BEFORE UPDATE ON "PaymentReversal"
  FOR EACH ROW EXECUTE FUNCTION payment_reversal_guard();

CREATE TRIGGER payment_reversal_guard_delete
  BEFORE DELETE ON "PaymentReversal"
  FOR EACH ROW EXECUTE FUNCTION payment_reversal_guard();

-- ---- AFTER: mantém os campos INFORMATIVOS do PaymentIntent (os relatórios atuais seguem funcionando sem mudança) ----
--   * amountRefundedCents = Σ REFUND/CARD_VIA_PORTAL/CONFIRMED da venda (recalculado do razão a cada mudança relevante, nunca incrementado). O estorno para a
--     CARTEIRA não entra: ele já aparece no WalletEntry REFUND (referenceType CHARGING_SESSION), que a conciliação soma à parte — contar nos dois seria duplicar.
--   * chargebackAt = quando a Cielo avisou o dono (notifiedAt), gravado no registro do chargeback e mantido depois (WON não apaga o histórico).
-- O status do PaymentIntent NÃO muda (continua CAPTURED): decisão §4 da F5, a identidade de conciliação não se altera. O CHECK existente
-- payment_intent_refund_not_exceeding_capture (F5.1) é a rede de segurança por trás desta soma.
CREATE OR REPLACE FUNCTION payment_reversal_sync_intent() RETURNS trigger AS $$
DECLARE
  v_sum bigint;
BEGIN
  IF NEW."paymentIntentId" IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW."kind" = 'REFUND' AND NEW."destination" = 'CARD_VIA_PORTAL' THEN
    SELECT COALESCE(SUM(r."amountCents"), 0) INTO v_sum
      FROM "PaymentReversal" r
     WHERE r."paymentIntentId" = NEW."paymentIntentId" AND r."kind" = 'REFUND' AND r."destination" = 'CARD_VIA_PORTAL' AND r."status" = 'CONFIRMED';
    UPDATE "PaymentIntent" SET "amountRefundedCents" = v_sum, "updatedAt" = now()
     WHERE id = NEW."paymentIntentId" AND "amountRefundedCents" <> v_sum;
  ELSIF NEW."kind" = 'CHARGEBACK' AND TG_OP = 'INSERT' THEN
    UPDATE "PaymentIntent" SET "chargebackAt" = NEW."notifiedAt", "updatedAt" = now() WHERE id = NEW."paymentIntentId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_reversal_sync_intent
  AFTER INSERT OR UPDATE OF "status" ON "PaymentReversal"
  FOR EACH ROW EXECUTE FUNCTION payment_reversal_sync_intent();

-- ============================================================
-- ROLLBACK MANUAL (não automático — Prisma Migrate não tem "down"). Ordem inversa; não perde dado que existia ANTES desta migration (tudo é novo):
-- ============================================================
-- (a) Antes de reverter, o código do lote 1 não pode estar escrevendo (senão perde registros). Estornos já CONFIRMED na carteira deixam WalletEntry REFUND
--     (append-only, permanece) — o rollback só some com o vínculo.
-- DROP TRIGGER IF EXISTS payment_reversal_sync_intent ON "PaymentReversal";
-- DROP TRIGGER IF EXISTS payment_reversal_guard_delete ON "PaymentReversal";
-- DROP TRIGGER IF EXISTS payment_reversal_guard_update ON "PaymentReversal";
-- DROP TRIGGER IF EXISTS payment_reversal_before_insert ON "PaymentReversal";
-- DROP FUNCTION IF EXISTS payment_reversal_sync_intent();
-- DROP FUNCTION IF EXISTS payment_reversal_guard();
-- DROP FUNCTION IF EXISTS payment_reversal_before_insert();
-- DROP TABLE IF EXISTS "PaymentReversal";           -- os "amountRefundedCents"/"chargebackAt" que o trigger gravou em PaymentIntent FICAM (informativos)
-- DROP TRIGGER IF EXISTS consent_record_guard_delete ON "ConsentRecord";
-- DROP TRIGGER IF EXISTS consent_record_guard_update ON "ConsentRecord";
-- DROP FUNCTION IF EXISTS consent_record_guard();
-- DROP TABLE IF EXISTS "ConsentRecord";
-- DROP TRIGGER IF EXISTS notification_log_guard ON "NotificationLog";
-- DROP FUNCTION IF EXISTS notification_log_guard();
-- DROP TABLE IF EXISTS "NotificationLog";
-- DROP TABLE IF EXISTS "NotificationPreference";
-- DROP TRIGGER IF EXISTS account_deletion_request_no_delete ON "AccountDeletionRequest";
-- DROP TRIGGER IF EXISTS account_deletion_request_no_update_of_proof ON "AccountDeletionRequest";
-- DROP FUNCTION IF EXISTS account_deletion_request_guard();
-- DROP TABLE IF EXISTS "AccountDeletionRequest";
-- ALTER TABLE "WalletEntry" DROP CONSTRAINT IF EXISTS "wallet_entry_refund_sign";
-- ALTER TABLE "PaymentMethod" DROP CONSTRAINT IF EXISTS "payment_method_destroyed_token_inactive";
-- DROP TRIGGER IF EXISTS user_deleted_irreversible ON "User";
-- DROP FUNCTION IF EXISTS user_deleted_is_irreversible();
-- ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "user_deleted_is_anonymized";
-- (b) As duas colunas abaixo só podem sair se NENHUMA conta foi excluída (deletedAt) — senão o rollback desfaz a prova da anonimização; confira antes:
--     SELECT count(*) FROM "User" WHERE "deletedAt" IS NOT NULL;   -- deve ser 0
-- ALTER TABLE "User" DROP COLUMN IF EXISTS "deletedAt";
-- ALTER TABLE "ChargingSession" DROP COLUMN IF EXISTS "startIp", DROP COLUMN IF EXISTS "startUserAgent";
-- (c) Tipos (só depois de nenhuma tabela/coluna usá-los):
-- DROP TYPE IF EXISTS "RefundDestination";
-- DROP TYPE IF EXISTS "PaymentReversalStatus";
-- DROP TYPE IF EXISTS "PaymentReversalKind";
-- DROP TYPE IF EXISTS "ConsentSource";
-- DROP TYPE IF EXISTS "ConsentKind";
-- DROP TYPE IF EXISTS "NotificationStatus";
-- DROP TYPE IF EXISTS "NotificationDeliveryChannel";
-- DROP TYPE IF EXISTS "NotificationType";
-- DROP TYPE IF EXISTS "AccountDeletionRefundStatus";
-- (d) Os 4 valores de AuditAction (migration 20261005150000) não têm rollback — ver o arquivo.
-- Depois: DELETE FROM "_prisma_migrations" WHERE "migration_name" IN ('20261005150100_lote1_lgpd_notificacoes_estorno_termos', '20261005150000_lote1_audit_action_values');
