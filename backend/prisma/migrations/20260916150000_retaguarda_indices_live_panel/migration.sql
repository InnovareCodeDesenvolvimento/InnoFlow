-- ============================================================
-- Módulo de retaguarda (dashboard/financeiro/relatórios) — 2026-09-16
-- ============================================================
-- Ver .claude/agent-memory/nova/decisoes-retaguarda-relatorios.md e
-- .claude/agent-memory/cronos/ para o desenho completo.
--
-- Esta migration só ADICIONA (nenhum DROP/ALTER destrutivo) — rollback é
-- sempre possível derrubando o que foi criado aqui, sem perda de dados
-- (ver bloco de DOWN comentado no final do arquivo).
--
-- Padrão sem downtime usado abaixo (tabelas ChargingSession/PaymentIntent
-- já recebem escrita real do gateway OCPP em produção, mesmo que hoje o
-- volume ainda seja pequeno — o hábito de escrever a migration como se a
-- tabela já fosse grande evita reescrever isso depois):
--   1. ADD COLUMN nullable sem DEFAULT — é operação O(1) de metadados no
--      Postgres 11+, não reescreve a tabela, não precisa de padrão especial.
--   2. CHECK constraint em coluna nova: ADD CONSTRAINT ... NOT VALID (não
--      escaneia a tabela, lock rápido) seguido de VALIDATE CONSTRAINT em
--      statement separado (escaneia mas só pede lock SHARE UPDATE
--      EXCLUSIVE — não bloqueia leitura nem escrita concorrente).
--   3. CREATE INDEX CONCURRENTLY (não bloqueia escrita durante o build do
--      índice, ao custo de não poder rodar dentro de uma transação — o
--      Prisma Migrate roda este arquivo statement-a-statement, sem
--      transação implícita ao redor, então CONCURRENTLY funciona aqui).
--      IF NOT EXISTS torna o arquivo seguro de re-rodar se uma tentativa
--      anterior falhar a meio caminho (CONCURRENTLY pode deixar um índice
--      INVALID se abortado — rodar de novo com IF NOT EXISTS + o mesmo nome
--      não recria um índice já válido, e um índice INVALID deixado para trás
--      precisa de DROP INDEX manual antes de tentar de novo; documentado
--      aqui, não escondido).

-- ------------------------------------------------------------
-- ChargingSession: colunas do painel "ao vivo"
-- ------------------------------------------------------------
-- Preenchidas por amostra (MeterValues/StatusNotification) enquanto a sessão
-- está em andamento — hoje só pelo seed sintético, a partir da Fase 4 real
-- pelo gateway OCPP (Vega). Nulas em sessões já encerradas/antigas: sem
-- backfill, não fazem falta ali.
ALTER TABLE "ChargingSession" ADD COLUMN "lastSampleAt" TIMESTAMPTZ(3);
ALTER TABLE "ChargingSession" ADD COLUMN "lastPowerW" INTEGER;
ALTER TABLE "ChargingSession" ADD COLUMN "lastSoc" INTEGER;

-- CHECK sem downtime: NOT VALID primeiro, VALIDATE depois.
ALTER TABLE "ChargingSession"
  ADD CONSTRAINT "charging_session_last_soc_range" CHECK ("lastSoc" IS NULL OR ("lastSoc" >= 0 AND "lastSoc" <= 100))
  NOT VALID;
ALTER TABLE "ChargingSession" VALIDATE CONSTRAINT "charging_session_last_soc_range";

-- ------------------------------------------------------------
-- Índices de relatório (Vega — 7 rotas de agregação do módulo de
-- retaguarda). CONCURRENTLY: não bloqueia INSERT/UPDATE das tabelas
-- quentes enquanto o índice é construído.
-- ------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChargingSession_operatorId_status_startedAt_idx"
  ON "ChargingSession" ("operatorId", "status", "startedAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChargingSession_siteId_status_startedAt_idx"
  ON "ChargingSession" ("siteId", "status", "startedAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "PaymentIntent_operatorId_status_capturedAt_idx"
  ON "PaymentIntent" ("operatorId", "status", "capturedAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "PaymentIntent_purpose_status_capturedAt_idx"
  ON "PaymentIntent" ("purpose", "status", "capturedAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "WalletEntry_type_createdAt_idx"
  ON "WalletEntry" ("type", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Debt_operatorId_status_createdAt_idx"
  ON "Debt" ("operatorId", "status", "createdAt");

-- ============================================================
-- Rollback (não executado automaticamente — Prisma Migrate não tem "down"
-- automático; guardado aqui para quem precisar reverter na mão):
-- ============================================================
-- DROP INDEX CONCURRENTLY IF EXISTS "Debt_operatorId_status_createdAt_idx";
-- DROP INDEX CONCURRENTLY IF EXISTS "WalletEntry_type_createdAt_idx";
-- DROP INDEX CONCURRENTLY IF EXISTS "PaymentIntent_purpose_status_capturedAt_idx";
-- DROP INDEX CONCURRENTLY IF EXISTS "PaymentIntent_operatorId_status_capturedAt_idx";
-- DROP INDEX CONCURRENTLY IF EXISTS "ChargingSession_siteId_status_startedAt_idx";
-- DROP INDEX CONCURRENTLY IF EXISTS "ChargingSession_operatorId_status_startedAt_idx";
-- ALTER TABLE "ChargingSession" DROP CONSTRAINT IF EXISTS "charging_session_last_soc_range";
-- ALTER TABLE "ChargingSession" DROP COLUMN IF EXISTS "lastSoc";
-- ALTER TABLE "ChargingSession" DROP COLUMN IF EXISTS "lastPowerW";
-- ALTER TABLE "ChargingSession" DROP COLUMN IF EXISTS "lastSampleAt";
