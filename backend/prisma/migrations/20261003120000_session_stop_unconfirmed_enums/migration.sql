-- ============================================================
-- F5.9 (Cronos, 2026-10-03): sessão travada — enums (M5/M6 do Órion).
-- ============================================================
-- Desenho: .claude/agent-memory/nova/decisoes-f59-sessao-travada.md.
-- Fechar pelo servidor é PROVISÓRIO: a sessão vai para STOP_UNCONFIRMED (sem
-- mexer em dinheiro) e só o watchdog a encerra depois, com a melhor prova.
--
-- Por que este arquivo é SÓ enum: `prisma migrate deploy` roda cada arquivo
-- numa ÚNICA transação, e o Postgres proíbe usar um valor recém-criado por
-- `ALTER TYPE ... ADD VALUE` (em CHECK, índice parcial WHERE, UPDATE) na
-- mesma transação ("unsafe use of new value of enum type"). A migration
-- seguinte (20261003120100_session_stop_unconfirmed_columns) tem um CHECK e
-- um índice parcial que citam 'STOP_UNCONFIRMED'. Mesma regra já aplicada em
-- 20260930120000_payment_gateway_enum_values.
-- CREATE TYPE de enum NOVO não tem essa restrição; ficam aqui só por
-- coesão (os 4 enums novos + o valor novo nascem juntos).

ALTER TYPE "ChargingSessionStatus" ADD VALUE 'STOP_UNCONFIRMED';

CREATE TYPE "SessionClosureSource" AS ENUM ('CHARGER', 'SERVER');

CREATE TYPE "MeterStopSource" AS ENUM ('STOP_TRANSACTION', 'LAST_METER_SAMPLE', 'NO_READING');

CREATE TYPE "StopUnconfirmedReason" AS ENUM (
  'STOP_REJECTED',
  'STOP_NOT_CONFIRMED',
  'CHARGER_UNREACHABLE',
  'CHARGER_REBOOTED',
  'CONNECTOR_IDLE',
  'MAX_DURATION'
);

CREATE TYPE "SessionStopRequester" AS ENUM ('DRIVER', 'ADMIN', 'GUARD', 'WATCHDOG');

-- ============================================================
-- Rollback (manual, Prisma não tem "down"). Só faça DEPOIS de reverter a
-- migration 20261003120100 (as colunas dependem destes tipos):
-- ============================================================
-- DROP TYPE IF EXISTS "SessionStopRequester";
-- DROP TYPE IF EXISTS "StopUnconfirmedReason";
-- DROP TYPE IF EXISTS "MeterStopSource";
-- DROP TYPE IF EXISTS "SessionClosureSource";
--
-- 'STOP_UNCONFIRMED' em "ChargingSessionStatus": Postgres não tem
-- `ALTER TYPE ... DROP VALUE`. Se for MESMO preciso remover, e só depois de
-- zerar as linhas que o usam (UPDATE "ChargingSession" SET status = 'STOPPED'
-- WHERE status = 'STOP_UNCONFIRMED' — decisão de negócio, não automática) e
-- de dropar o índice ix_charging_session_watchdog e o CHECK que o citam:
--   ALTER TYPE "ChargingSessionStatus" RENAME TO "ChargingSessionStatus_old";
--   CREATE TYPE "ChargingSessionStatus" AS ENUM
--     ('STARTED','CHARGING','FINISHING','STOPPED','FAULTED');
--   -- derrubar índices parciais que citam o tipo (ux_charging_session_active_per_connector),
--   -- ALTER COLUMN status DROP DEFAULT; ALTER COLUMN status TYPE "ChargingSessionStatus"
--   --   USING status::text::"ChargingSessionStatus"; SET DEFAULT 'STARTED'; recriar os índices;
--   DROP TYPE "ChargingSessionStatus_old";
-- (reescreve a tabela: ACCESS EXCLUSIVE — não vale a pena; deixar o valor
-- ocioso no enum é inofensivo.)
