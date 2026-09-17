-- ============================================================
-- Log de auditoria (Cronos, 2026-09-17) — desenho completo da Nova em
-- .claude/agent-memory/nova/decisoes-audit-log.md. Rastreabilidade de
-- "quem fez o quê, onde e como" no painel ADMIN.
-- ============================================================
-- Esta migration só ADICIONA (nenhum DROP/ALTER destrutivo) — rollback é
-- sempre possível derrubando o que foi criado aqui, sem perda de dados que
-- já existisse antes dela (ver bloco de DOWN comentado no final do
-- arquivo). Tabela nova, sem downtime possível — não há linha viva para
-- travar, então CREATE INDEX aqui é normal (sem CONCURRENTLY), mesmo
-- raciocínio de 20260917140000_wallet_debt_ocpp_unique_indexes.
--
-- SEM particionamento (decisão explícita da Nova — volume 3 ordens de
-- magnitude menor que MeterSample/OcppMessage; gatilho para reconsiderar:
-- >20 milhões de linhas ou p95 >800ms na listagem filtrada de 12 meses).

-- ------------------------------------------------------------
-- Enums
-- ------------------------------------------------------------

CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'REMOTE_COMMAND', 'WALLET_ADJUSTMENT', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'EXPORT', 'OTHER');

CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILED');

-- ------------------------------------------------------------
-- Tabela
-- ------------------------------------------------------------
-- Campos de ator (actorUserId/actorRole/actorEmail/actorName/
-- actorOperatorId) e targetOperatorId são SNAPSHOT histórico, sem FK de
-- propósito: a linha precisa sobreviver a um User apagado/anonimizado
-- (LGPD) ou a mudança de role/operador depois do fato — uma FK obrigaria
-- manter o registro pai vivo para sempre, o que contradiz o propósito do
-- log. `actorRole` reusa o enum "Role" só pelo tipo (não é relação).

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT NOT NULL,
    "actorRole" "Role" NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorOperatorId" TEXT,
    "action" "AuditAction" NOT NULL,
    "actionDetail" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "targetOperatorId" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "correlationId" TEXT,
    "changes" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- ------------------------------------------------------------
-- Índices — um por padrão de consulta real do painel ADMIN (Nova, §1.6):
-- ------------------------------------------------------------

-- Listagem padrão, mais recente primeiro.
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt" DESC);

-- "O que este usuário fez" (auditoria por ator).
CREATE INDEX "AuditLog_actorUserId_occurredAt_idx" ON "AuditLog"("actorUserId", "occurredAt");

-- "Histórico desta entidade" (ex.: todo UPDATE de um Tariff específico).
CREATE INDEX "AuditLog_entityType_entityId_occurredAt_idx" ON "AuditLog"("entityType", "entityId", "occurredAt");

-- Filtro por tipo de ação (ex.: só WALLET_ADJUSTMENT, só LOGIN_FAILED).
CREATE INDEX "AuditLog_action_occurredAt_idx" ON "AuditLog"("action", "occurredAt");

-- "O que aconteceu com este operador" (ex.: ADMIN olhando um operador só).
CREATE INDEX "AuditLog_targetOperatorId_occurredAt_idx" ON "AuditLog"("targetOperatorId", "occurredAt");

-- PARCIAL: painel de exceções (DENIED/FAILED) sem varrer o volume de
-- SUCCESS, que é a maioria esmagadora das linhas. Não tem `@@index`
-- correspondente no schema.prisma — Prisma não expressa WHERE em índice
-- normal (mesma convenção dos `ux_*` parciais já existentes neste projeto).
CREATE INDEX "ix_audit_log_non_success" ON "AuditLog"("occurredAt") WHERE "outcome" <> 'SUCCESS';

-- ------------------------------------------------------------
-- Append-only por trigger — mesmo padrão de `wallet_entry_append_only`
-- (ver 20260916120000_init_multi_tenant_partitioned), com UMA diferença:
-- UPDATE é bloqueado SEMPRE; DELETE só é bloqueado para linhas DENTRO do
-- piso de retenção (24 meses) — permite expurgo de linhas mais antigas
-- (retenção/LGPD), o que `WalletEntry` não precisa (carteira não expurga).
-- Caveat honesto (já registrado pela Nova): trigger não segura
-- dono/superuser do Postgres — segura a aplicação e quem usa a aplicação.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'AuditLog é append-only — UPDATE não é permitido (id=%)',
      OLD.id;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."occurredAt" >= now() - interval '24 months' THEN
      RAISE EXCEPTION 'AuditLog: DELETE bloqueado — linha ainda dentro do piso de retenção de 24 meses (id=%, occurredAt=%)',
        OLD.id, OLD."occurredAt";
    END IF;
    RETURN OLD;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_restrict_delete
  BEFORE DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- ============================================================
-- Rollback (não executado automaticamente — Prisma Migrate não tem "down"
-- automático; guardado aqui para quem precisar reverter na mão):
-- ============================================================
-- DROP TRIGGER IF EXISTS "audit_log_restrict_delete" ON "AuditLog";
-- DROP TRIGGER IF EXISTS "audit_log_no_update" ON "AuditLog";
-- DROP FUNCTION IF EXISTS audit_log_append_only();
-- DROP INDEX IF EXISTS "ix_audit_log_non_success";
-- DROP INDEX IF EXISTS "AuditLog_targetOperatorId_occurredAt_idx";
-- DROP INDEX IF EXISTS "AuditLog_action_occurredAt_idx";
-- DROP INDEX IF EXISTS "AuditLog_entityType_entityId_occurredAt_idx";
-- DROP INDEX IF EXISTS "AuditLog_actorUserId_occurredAt_idx";
-- DROP INDEX IF EXISTS "AuditLog_occurredAt_idx";
-- DROP TABLE IF EXISTS "AuditLog";
-- DROP TYPE IF EXISTS "AuditOutcome";
-- DROP TYPE IF EXISTS "AuditAction";
