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
-- Padrão sem downtime usado abaixo:
--   1. ADD COLUMN nullable sem DEFAULT — é operação O(1) de metadados no
--      Postgres 11+, não reescreve a tabela, não precisa de padrão especial.
--   2. CHECK constraint em coluna nova: ADD CONSTRAINT ... NOT VALID (não
--      escaneia a tabela, lock rápido) seguido de VALIDATE CONSTRAINT em
--      statement separado (escaneia mas só pede lock SHARE UPDATE
--      EXCLUSIVE — não bloqueia leitura nem escrita concorrente).
--
-- CORREÇÃO (16/09/2026): a versão original deste arquivo usava
-- `CREATE INDEX CONCURRENTLY`, partindo do pressuposto de que o Prisma
-- Migrate roda cada statement fora de uma transação. Isso é FALSO — testado
-- em produção real (EasyPanel): `prisma migrate deploy` envolve o arquivo
-- inteiro em UMA transação, e o Postgres rejeita CONCURRENTLY dentro de
-- transação com o erro `25001 CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block` (código Prisma P3018) — a migration inteira falha e
-- reverte (nenhuma coluna/índice chega a existir). Removido CONCURRENTLY:
-- na escala atual do projeto (milhares de linhas, não a escala-alvo de
-- milhões), o lock breve de um CREATE INDEX normal é aceitável. Se algum dia
-- isso precisar rodar sem lock contra uma tabela já grande em produção real,
-- a forma correta é `prisma db execute` rodando o CONCURRENTLY manualmente
-- fora do fluxo de migrate, seguido de `prisma migrate resolve --applied`.

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
-- retaguarda). Sem CONCURRENTLY (ver correção acima) — lock breve,
-- aceitável na escala atual.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "ChargingSession_operatorId_status_startedAt_idx"
  ON "ChargingSession" ("operatorId", "status", "startedAt");

CREATE INDEX IF NOT EXISTS "ChargingSession_siteId_status_startedAt_idx"
  ON "ChargingSession" ("siteId", "status", "startedAt");

CREATE INDEX IF NOT EXISTS "PaymentIntent_operatorId_status_capturedAt_idx"
  ON "PaymentIntent" ("operatorId", "status", "capturedAt");

CREATE INDEX IF NOT EXISTS "PaymentIntent_purpose_status_capturedAt_idx"
  ON "PaymentIntent" ("purpose", "status", "capturedAt");

CREATE INDEX IF NOT EXISTS "WalletEntry_type_createdAt_idx"
  ON "WalletEntry" ("type", "createdAt");

CREATE INDEX IF NOT EXISTS "Debt_operatorId_status_createdAt_idx"
  ON "Debt" ("operatorId", "status", "createdAt");

-- ============================================================
-- Rollback (não executado automaticamente — Prisma Migrate não tem "down"
-- automático; guardado aqui para quem precisar reverter na mão):
-- ============================================================
-- DROP INDEX IF EXISTS "Debt_operatorId_status_createdAt_idx";
-- DROP INDEX IF EXISTS "WalletEntry_type_createdAt_idx";
-- DROP INDEX IF EXISTS "PaymentIntent_purpose_status_capturedAt_idx";
-- DROP INDEX IF EXISTS "PaymentIntent_operatorId_status_capturedAt_idx";
-- DROP INDEX IF EXISTS "ChargingSession_siteId_status_startedAt_idx";
-- DROP INDEX IF EXISTS "ChargingSession_operatorId_status_startedAt_idx";
-- ALTER TABLE "ChargingSession" DROP CONSTRAINT IF EXISTS "charging_session_last_soc_range";
-- ALTER TABLE "ChargingSession" DROP COLUMN IF EXISTS "lastSoc";
-- ALTER TABLE "ChargingSession" DROP COLUMN IF EXISTS "lastPowerW";
-- ALTER TABLE "ChargingSession" DROP COLUMN IF EXISTS "lastSampleAt";
