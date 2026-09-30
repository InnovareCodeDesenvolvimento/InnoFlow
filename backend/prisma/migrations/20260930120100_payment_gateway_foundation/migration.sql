-- ============================================================
-- F5.1 (Cronos, 2026-09-30): fundação de schema para pagamento real (Cielo)
-- ============================================================
-- Desenho completo: .claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md
-- e cielo-fatos-verificados.md (Nova, 30/09/2026 — D1 do dono aprovada:
-- cartão salvo via Silent Order Post, SAQ A-EP). Esta migration é a base
-- que NÃO depende da decisão de cartão em si — corrige 3 armadilhas achadas
-- no schema de 16/09 e prepara o terreno (config do gateway, CPF opcional,
-- ator SYSTEM na auditoria).
--
-- Depende de 20260930120000_payment_gateway_enum_values já ter rodado (e
-- commitado) antes desta — ver o comentário lá sobre por que os
-- ALTER TYPE ... ADD VALUE têm de estar numa migration à parte.
--
-- Padrões sem downtime usados abaixo (mesma convenção já estabelecida
-- neste repo): ADD COLUMN nullable ou com DEFAULT constante é O(1) de
-- metadados desde o Postgres 11 (não reescreve tabela); CHECK novo em
-- coluna com dado existente usa NOT VALID + VALIDATE CONSTRAINT em
-- statement separado (não bloqueia leitura/escrita concorrente durante a
-- validação); SEM CREATE INDEX CONCURRENTLY (Prisma Migrate roda o arquivo
-- inteiro numa transação só — CONCURRENTLY não roda dentro de transação,
-- já causou falha real em produção nesta base, ver
-- 20260916150000_retaguarda_indices_live_panel). Tabelas ainda pequenas
-- nesta fase (WebhookEvent, PaymentIntent, User, AuditLog não estão na
-- escala de MeterSample/OcppMessage) — lock breve de CREATE INDEX/ALTER
-- normal é aceitável.

-- ============================================================
-- 1) WebhookEvent: dedupe vira ÍNDICE COMUM (não UNIQUE) + contador de
--    tentativas.
-- ============================================================
-- Um Pix pendente→pago é a MESMA (provider, externalId) com changeType
-- diferente — o UNIQUE original descartaria a 2ª mudança de status
-- legítima do mesmo PaymentId. O dedupe de verdade vai para o EFEITO
-- (índices únicos parciais na seção 2, abaixo), não para a caixa de
-- entrada do webhook (que é só dica, nunca verdade — decisão §3 da Nova).
-- Cria o índice novo ANTES de derrubar o antigo (nunca fica um instante
-- sem nenhum índice nessas colunas).
CREATE INDEX "WebhookEvent_provider_externalId_changeType_idx"
  ON "WebhookEvent" ("provider", "externalId", "changeType");

ALTER TABLE "WebhookEvent" DROP CONSTRAINT IF EXISTS "WebhookEvent_provider_externalId_changeType_key";
DROP INDEX IF EXISTS "WebhookEvent_provider_externalId_changeType_key";

-- Quantas vezes o worker tentou reconsultar/processar este evento —
-- observabilidade e critério de "desistir e deixar para o varredor de
-- PaymentIntent" em vez de reprocessar um evento quebrado para sempre.
-- DEFAULT constante (0) em coluna nova = metadata-only desde PG11.
ALTER TABLE "WebhookEvent" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- 2) Idempotência do EFEITO — os dois índices únicos parciais que a caixa
--    de entrada do webhook (seção 1) NÃO garante mais sozinha.
-- ============================================================
-- Mesmo espírito de ux_wallet_entry_charge_debit_once (F4,
-- 20260917140000_wallet_debt_ocpp_unique_indexes) — não são `@@unique` no
-- schema.prisma porque são parciais.

-- No máximo um crédito de TOPUP_PIX por PaymentIntent (referenceId) — evita
-- creditar a carteira duas vezes se o worker reconsultar/reprocessar o
-- mesmo PaymentIntent (retry do webhook, corrida entre worker e varredor).
CREATE UNIQUE INDEX "ux_wallet_entry_topup_once"
  ON "WalletEntry" ("referenceType", "referenceId")
  WHERE type = 'TOPUP_PIX';

-- No máximo uma quitação de dívida por referência (Debt.id) — evita quitar
-- a mesma Debt duas vezes se o crédito de Pix rodar mais de uma vez para o
-- mesmo evento (mesma classe de corrida do índice acima).
CREATE UNIQUE INDEX "ux_wallet_entry_debt_settlement_once"
  ON "WalletEntry" ("referenceId")
  WHERE type = 'DEBT_SETTLEMENT';

-- ============================================================
-- 3) PaymentIntent: campos de estorno/chargeback/falha + índice do
--    varredor de conciliação.
-- ============================================================
ALTER TABLE "PaymentIntent" ADD COLUMN "amountRefundedCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PaymentIntent" ADD COLUMN "chargebackAt" TIMESTAMPTZ(3);
ALTER TABLE "PaymentIntent" ADD COLUMN "failureReason" TEXT;

-- Defesa extra (não pedida explicitamente, mesmo mandato de "integridade
-- por desenho" das outras CHECKs deste schema): nunca estornar mais do que
-- foi capturado. NULL passa em CHECK (NULL <= n é NULL), então intent ainda
-- sem captura não é afetado.
ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "payment_intent_refund_not_exceeding_capture" CHECK (
    "amountCapturedCents" IS NULL OR "amountRefundedCents" <= "amountCapturedCents"
  ) NOT VALID;
ALTER TABLE "PaymentIntent" VALIDATE CONSTRAINT "payment_intent_refund_not_exceeding_capture";

-- Varredor de conciliação: reconsulta intents "vivos" (CREATED/AUTHORIZED/
-- CAPTURE_PENDING) ordenando por há quanto tempo pararam de mudar, sem
-- varrer a tabela inteira por status.
CREATE INDEX "PaymentIntent_status_updatedAt_idx" ON "PaymentIntent" ("status", "updatedAt");

-- ------------------------------------------------------------
-- Correção da CHECK payment_intent_purpose_consistency (armadilha #2 do
-- schema de 16/09 — ver decisoes-f5-pagamento-cielo.md §6).
-- ------------------------------------------------------------
-- A original exigia chargingSessionId presente SEMPRE que purpose =
-- SESSION_CARD_CAPTURE. Isso quebra a F5: a pré-autorização acontece na API
-- (POST /api/me/sessions/start), ANTES do RemoteStart — a sessão ainda não
-- existe. O vínculo (chargingSessionId) só é gravado depois, quando o
-- StartTransaction liga a sessão real ao PaymentIntent AUTHORIZED (via
-- UPDATE OF "chargingSessionId" — o trigger set_payment_intent_operator_id
-- já cobre esse caminho, ver seção 5). Reescrita: chargingSessionId só é
-- obrigatório a partir do momento em que o dinheiro de fato se move
-- (CAPTURE_PENDING/CAPTURED) — antes disso (CREATED/AUTHORIZED, e também
-- CANCELLED/DENIED/VOIDED/FAILED/EXPIRED de uma pré-auth que nunca virou
-- sessão) o campo pode estar nulo.
ALTER TABLE "PaymentIntent" DROP CONSTRAINT "payment_intent_purpose_consistency";

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "payment_intent_purpose_consistency" CHECK (
    (purpose = 'SESSION_CARD_CAPTURE' AND "walletId" IS NULL AND
      (status NOT IN ('CAPTURE_PENDING', 'CAPTURED') OR "chargingSessionId" IS NOT NULL)) OR
    (purpose = 'WALLET_TOPUP_PIX' AND "walletId" IS NOT NULL AND "chargingSessionId" IS NULL)
  ) NOT VALID;
ALTER TABLE "PaymentIntent" VALIDATE CONSTRAINT "payment_intent_purpose_consistency";
-- Nota: todas as linhas existentes satisfazem a nova CHECK trivialmente —
-- a antiga já exigia chargingSessionId sempre presente para
-- SESSION_CARD_CAPTURE (mais restritiva), então nenhuma linha gravada até
-- hoje pode violar a versão nova (mais permissiva). VALIDATE aqui é só
-- formalidade/consistência de padrão, não expectativa real de achar linha
-- ruim.

-- ------------------------------------------------------------
-- Trigger set_payment_intent_operator_id (init migration, 16/09) já
-- tolera chargingSessionId nulo — conferido, NENHUMA mudança necessária:
-- ------------------------------------------------------------
-- BEFORE INSERT OR UPDATE OF "chargingSessionId" ON "PaymentIntent";
-- corpo: `IF NEW."chargingSessionId" IS NOT NULL THEN <deriva operatorId>
-- END IF` — INSERT de uma pré-auth sem sessão (chargingSessionId NULL)
-- simplesmente não deriva nada e operatorId fica NULL (mesmo
-- comportamento documentado para WALLET_TOPUP_PIX); quando o
-- StartTransaction depois roda `UPDATE "PaymentIntent" SET
-- "chargingSessionId" = ...`, o trigger dispara (está na cláusula
-- `OF "chargingSessionId"`) e deriva operatorId nesse momento. Não precisa
-- de `ADD COLUMN`/mudança de trigger para a F5 funcionar.

-- ============================================================
-- 4) User: CPF opcional (LGPD) para pagamento via Pix.
-- ============================================================
ALTER TABLE "User" ADD COLUMN "cpf" VARCHAR(11);

ALTER TABLE "User"
  ADD CONSTRAINT "user_cpf_numeric_11_digits" CHECK ("cpf" IS NULL OR "cpf" ~ '^[0-9]{11}$')
  NOT VALID;
ALTER TABLE "User" VALIDATE CONSTRAINT "user_cpf_numeric_11_digits";

-- Parcial: só dono de CPF preenchido precisa ser único; vários usuários sem
-- CPF (NULL) nunca colidem entre si em índice único.
CREATE UNIQUE INDEX "ux_user_cpf" ON "User" ("cpf") WHERE "cpf" IS NOT NULL;

-- ============================================================
-- 5) PaymentGatewayConfig: tabela SINGLETON com a nossa conta Cielo.
-- ============================================================
-- Ver comentário do model no schema.prisma para o porquê dos campos
-- *Ciphertext (AES-256-GCM; a CHAVE de cifragem vive só na env
-- PAYMENT_SECRETS_KEY, NUNCA no banco — se o banco vazar, os segredos
-- continuam ilegíveis sem a chave, que não está aqui).
CREATE TABLE "PaymentGatewayConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "environment" TEXT NOT NULL,
    "merchantId" TEXT,
    "merchantKeyCiphertext" TEXT,
    "sopClientId" TEXT,
    "sopClientSecretCiphertext" TEXT,
    "webhookHeaderSecretCiphertext" TEXT,
    "cardEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pixEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentGatewayConfig_pkey" PRIMARY KEY ("id")
);

-- Singleton de verdade: só a linha id=1 pode existir. Reforçado por CHECK
-- (não só convenção da app) — um INSERT com qualquer outro id colide com
-- o DEFAULT 1 só se ninguém passar id explícito; a CHECK fecha o buraco de
-- alguém inserir id=2 de propósito ou por engano.
ALTER TABLE "PaymentGatewayConfig"
  ADD CONSTRAINT "payment_gateway_config_singleton" CHECK ("id" = 1);

-- ============================================================
-- 6) AuditLog: ator SYSTEM (enum separado de Role) + HTTP anulável só para
--    SYSTEM.
-- ============================================================
-- Enum NOVO (não ADD VALUE em tipo existente) — pode ser criado e usado na
-- MESMA transação sem o problema da seção "enum_values" desta F5.1.
CREATE TYPE "AuditActorRole" AS ENUM ('ADMIN', 'OPERATOR', 'DRIVER', 'SYSTEM');

-- Troca de tipo de coluna existente (Role -> AuditActorRole) — os 3 valores
-- em uso hoje (ADMIN/OPERATOR/DRIVER) têm o mesmo nome nos dois enums, o
-- cast texto->texto->enum preserva o dado. Honestidade: isto é um REWRITE
-- de tabela inteira (ACCESS EXCLUSIVE durante a operação) — Postgres não
-- tem caminho "sem rewrite" para trocar o tipo de uma coluna enum, mesmo
-- quando os valores batem. Aceitável agora (AuditLog é "3 ordens de
-- magnitude menor que MeterSample/OcppMessage", ver schema.prisma) — se
-- crescer muito antes de rodar isto em produção, considerar expand/contract
-- (coluna nova + backfill) em vez desta troca direta.
ALTER TABLE "AuditLog"
  ALTER COLUMN "actorRole" TYPE "AuditActorRole" USING ("actorRole"::text::"AuditActorRole");

-- method/path/httpStatus viram anuláveis — só DROP NOT NULL, metadata-only,
-- não escaneia a tabela.
ALTER TABLE "AuditLog" ALTER COLUMN "method" DROP NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "path" DROP NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "httpStatus" DROP NOT NULL;

-- Reforça por CHECK (não só convenção da aplicação) que os 3 só podem
-- faltar quando o ator é SYSTEM — nenhuma linha com ator humano pode ficar
-- sem o rastro HTTP que a motivou.
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "audit_log_http_fields_required_unless_system" CHECK (
    "actorRole" = 'SYSTEM' OR ("method" IS NOT NULL AND "path" IS NOT NULL AND "httpStatus" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "audit_log_http_fields_required_unless_system";
-- Nota: toda linha existente tem actorRole IN ('ADMIN','OPERATOR','DRIVER')
-- (SYSTEM não existia antes desta migration) e method/path/httpStatus eram
-- NOT NULL até agora — nenhuma linha pode violar esta CHECK. VALIDATE aqui
-- é formalidade de padrão, mesma nota da seção 3.

-- ============================================================
-- Rollback (manual, Prisma não tem "down"):
-- ============================================================
-- ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "audit_log_http_fields_required_unless_system";
-- ALTER TABLE "AuditLog" ALTER COLUMN "httpStatus" SET NOT NULL; -- só se garantido que não há linha SYSTEM
-- ALTER TABLE "AuditLog" ALTER COLUMN "path" SET NOT NULL;       -- idem
-- ALTER TABLE "AuditLog" ALTER COLUMN "method" SET NOT NULL;     -- idem
-- ALTER TABLE "AuditLog" ALTER COLUMN "actorRole" TYPE "Role" USING ("actorRole"::text::"Role"); -- falha se houver linha SYSTEM
-- DROP TYPE IF EXISTS "AuditActorRole";
-- ALTER TABLE "PaymentGatewayConfig" DROP CONSTRAINT IF EXISTS "payment_gateway_config_singleton";
-- DROP TABLE IF EXISTS "PaymentGatewayConfig";
-- DROP INDEX IF EXISTS "ux_user_cpf";
-- ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "user_cpf_numeric_11_digits";
-- ALTER TABLE "User" DROP COLUMN IF EXISTS "cpf";
-- ALTER TABLE "PaymentIntent" DROP CONSTRAINT IF EXISTS "payment_intent_purpose_consistency";
-- ALTER TABLE "PaymentIntent" ADD CONSTRAINT "payment_intent_purpose_consistency" CHECK (
--   (purpose = 'SESSION_CARD_CAPTURE' AND "chargingSessionId" IS NOT NULL AND "walletId" IS NULL) OR
--   (purpose = 'WALLET_TOPUP_PIX' AND "walletId" IS NOT NULL AND "chargingSessionId" IS NULL)
-- ); -- falha se houver pré-auth sem sessão ainda gravada (ex.: em produção real com F5 já rodando)
-- DROP INDEX IF EXISTS "PaymentIntent_status_updatedAt_idx";
-- ALTER TABLE "PaymentIntent" DROP CONSTRAINT IF EXISTS "payment_intent_refund_not_exceeding_capture";
-- ALTER TABLE "PaymentIntent" DROP COLUMN IF EXISTS "failureReason";
-- ALTER TABLE "PaymentIntent" DROP COLUMN IF EXISTS "chargebackAt";
-- ALTER TABLE "PaymentIntent" DROP COLUMN IF EXISTS "amountRefundedCents";
-- DROP INDEX IF EXISTS "ux_wallet_entry_debt_settlement_once";
-- DROP INDEX IF EXISTS "ux_wallet_entry_topup_once";
-- ALTER TABLE "WebhookEvent" DROP COLUMN IF EXISTS "attempts";
-- CREATE UNIQUE INDEX "WebhookEvent_provider_externalId_changeType_key" ON "WebhookEvent"("provider", "externalId", "changeType"); -- falha se já houver 2ª mudança de status do mesmo PaymentId gravada
-- DROP INDEX IF EXISTS "WebhookEvent_provider_externalId_changeType_idx";
