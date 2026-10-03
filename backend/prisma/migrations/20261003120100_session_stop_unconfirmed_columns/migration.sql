-- ============================================================
-- F5.9 (Cronos, 2026-10-03): sessão travada — colunas, CHECKs, índice do
-- watchdog e backfill em "ChargingSession".
-- ============================================================
-- Desenho: .claude/agent-memory/nova/decisoes-f59-sessao-travada.md.
-- Depende de 20261003120000_session_stop_unconfirmed_enums (tipos e o valor
-- 'STOP_UNCONFIRMED' — precisa estar COMMITADO antes deste arquivo rodar).
--
-- Sem downtime, tudo aditivo:
--  * ADD COLUMN nullable sem DEFAULT: metadata-only.
--  * stopAttempts NOT NULL DEFAULT 0: DEFAULT constante é metadata-only
--    desde o PG11 (sem reescrita de tabela).
--  * CHECK: ADD ... NOT VALID + VALIDATE em statement separado (padrão de
--    20260916150000_retaguarda_indices_live_panel).
--  * Índice SEM CONCURRENTLY: o migrate deploy usa uma transação por
--    arquivo. Aceitável na escala atual (milhares de linhas); o índice é
--    PARCIAL e só cobre sessões não terminais (poucas linhas).

-- ------------------------------------------------------------
-- 1) Colunas
-- ------------------------------------------------------------
-- Relógio do SERVIDOR (now()): lastActivityAt, stopRequestedAt, unconfirmedAt,
-- lateStopReceivedAt. Relógio do CARREGADOR (payload): lateStopAt (e o
-- lastSampleAt já existente). O watchdog decide só pelo primeiro grupo; a
-- cobrança só pelo segundo.
ALTER TABLE "ChargingSession"
  ADD COLUMN "lastActivityAt"       TIMESTAMPTZ(3),
  ADD COLUMN "stopRequestedAt"      TIMESTAMPTZ(3),
  ADD COLUMN "stopRequestedBy"      "SessionStopRequester",
  ADD COLUMN "stopAttempts"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "unconfirmedAt"        TIMESTAMPTZ(3),
  ADD COLUMN "unconfirmedReason"    "StopUnconfirmedReason",
  ADD COLUMN "provisionalCostCents" INTEGER,
  ADD COLUMN "closureSource"        "SessionClosureSource",
  ADD COLUMN "meterStopSource"      "MeterStopSource",
  -- Mesmo tipo de "meterStopWh" (INTEGER / Int).
  ADD COLUMN "lateStopMeterWh"      INTEGER,
  ADD COLUMN "lateStopAt"           TIMESTAMPTZ(3),
  ADD COLUMN "lateStopReceivedAt"   TIMESTAMPTZ(3),
  ADD COLUMN "unbilledCostCents"    INTEGER;

-- ------------------------------------------------------------
-- 2) CHECKs (integridade por desenho, não por confiança na app)
-- ------------------------------------------------------------
-- STOP_UNCONFIRMED sem hora/motivo é uma sessão que o watchdog não sabe
-- quando nem por que ficou pendente.
ALTER TABLE "ChargingSession"
  ADD CONSTRAINT "charging_session_unconfirmed_requires_reason" CHECK (
    status <> 'STOP_UNCONFIRMED'
    OR ("unconfirmedAt" IS NOT NULL AND "unconfirmedReason" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "ChargingSession" VALIDATE CONSTRAINT "charging_session_unconfirmed_requires_reason";

ALTER TABLE "ChargingSession"
  ADD CONSTRAINT "charging_session_f59_amounts_non_negative" CHECK (
    ("provisionalCostCents" IS NULL OR "provisionalCostCents" >= 0)
    AND ("unbilledCostCents" IS NULL OR "unbilledCostCents" >= 0)
    AND "stopAttempts" >= 0
  ) NOT VALID;
ALTER TABLE "ChargingSession" VALIDATE CONSTRAINT "charging_session_f59_amounts_non_negative";

-- ------------------------------------------------------------
-- 3) Índice do watchdog
-- ------------------------------------------------------------
-- Consulta real (worker, a cada 60 s, lote limitado):
--   WHERE status IN (<não terminais>) AND COALESCE("lastActivityAt", ...) < now() - janela
-- Parcial: sessões terminais (STOPPED, a imensa maioria da tabela) ficam de
-- fora, então o índice tem o tamanho das sessões VIVAS (dezenas/centenas) e
-- custa escrita só nelas. Inclui STOP_UNCONFIRMED (o watchdog também varre as
-- pendentes) e FAULTED (antes um beco sem saída). Prisma não expressa índice
-- parcial não-único: vive só aqui (verificado: `migrate diff
-- --from-url` contra o banco migrado NÃO o acusa; só ux_ocpp_message_dedupe).
-- NOTA: este índice NÃO substitui nem altera o único parcial
-- ux_charging_session_active_per_connector (STARTED/CHARGING/FINISHING):
-- STOP_UNCONFIRMED fica FORA dele, como FAULTED já estava. Se o dono decidir
-- BLOQUEAR nova recarga no conector durante a confirmação, isso é um índice
-- único novo (decisão pendente no PROGRESSO.md), não parte desta migration.
CREATE INDEX "ix_charging_session_watchdog"
  ON "ChargingSession" ("status", "lastActivityAt")
  WHERE status IN ('STARTED', 'CHARGING', 'FINISHING', 'FAULTED', 'STOP_UNCONFIRMED');

-- ------------------------------------------------------------
-- 4) Backfill
-- ------------------------------------------------------------
-- Sessões abertas hoje não têm lastActivityAt. Sem isto, o primeiro ciclo do
-- watchdog pós-deploy as veria "paradas desde sempre" e encerraria TODAS de
-- uma vez. now() dá a cada uma uma janela cheia para voltar a falar.
-- STOP_UNCONFIRMED é omitido de propósito: o valor acabou de nascer, não há
-- linha nesse estado. Sessões STOPPED antigas ficam com closureSource /
-- meterStopSource NULL: não sabemos como foram fechadas e não inventamos.
-- (Os triggers de ChargingSession só disparam em UPDATE OF connectorId/
-- chargePointId; este UPDATE não os aciona e não toca updatedAt.)
UPDATE "ChargingSession"
   SET "lastActivityAt" = now()
 WHERE status IN ('STARTED', 'CHARGING', 'FINISHING', 'FAULTED')
   AND "lastActivityAt" IS NULL;

-- ============================================================
-- Rollback (manual, Prisma não tem "down"). Perde-se só o que a F5.9
-- gravou (nenhuma coluna pré-existente é tocada). Se houver sessão em
-- STOP_UNCONFIRMED, resolva-a ANTES (UPDATE ... SET status = 'STOPPED' é
-- decisão de negócio) — o CHECK é derrubado abaixo, mas o valor de enum
-- permanece. Rollback do enum: ver 20261003120000.
-- ============================================================
-- DROP INDEX IF EXISTS "ix_charging_session_watchdog";
-- ALTER TABLE "ChargingSession" DROP CONSTRAINT IF EXISTS "charging_session_f59_amounts_non_negative";
-- ALTER TABLE "ChargingSession" DROP CONSTRAINT IF EXISTS "charging_session_unconfirmed_requires_reason";
-- ALTER TABLE "ChargingSession"
--   DROP COLUMN IF EXISTS "unbilledCostCents",
--   DROP COLUMN IF EXISTS "lateStopReceivedAt",
--   DROP COLUMN IF EXISTS "lateStopAt",
--   DROP COLUMN IF EXISTS "lateStopMeterWh",
--   DROP COLUMN IF EXISTS "meterStopSource",
--   DROP COLUMN IF EXISTS "closureSource",
--   DROP COLUMN IF EXISTS "provisionalCostCents",
--   DROP COLUMN IF EXISTS "unconfirmedReason",
--   DROP COLUMN IF EXISTS "unconfirmedAt",
--   DROP COLUMN IF EXISTS "stopAttempts",
--   DROP COLUMN IF EXISTS "stopRequestedBy",
--   DROP COLUMN IF EXISTS "stopRequestedAt",
--   DROP COLUMN IF EXISTS "lastActivityAt";
