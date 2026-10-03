-- ============================================================
-- F5.9 (Cronos, 2026-10-03): relógio do SERVIDOR em duas fontes que hoje só
-- guardam o relógio do carregador. Achado da Vega na fase 9b0.
-- ============================================================
-- Problema: o watchdog de sessão travada só pode decidir pelo relógio do
-- servidor, mas
--   * "Connector"."statusUpdatedAt" guarda `data.timestamp ?? now` do
--     StatusNotification (relógio do carregador);
--   * "ChargingSession"."lastActivityAt" também se move com StatusNotification
--     etc., então não distingue "chegou leitura de medidor" (que a regra U1,
--     "reanimar" sessão não confirmada, exige).
--
-- Sem downtime, tudo aditivo:
--  * ADD COLUMN nullable sem DEFAULT: metadata-only (sem reescrita).
--  * O backfill é UPDATE em tabelas pequenas (Connector: dezenas/centenas de
--    linhas; ChargingSession: só as sessões VIVAS, filtro por status, as
--    STOPPED — imensa maioria — não são tocadas).
--  * Sem índice novo: nenhuma das duas colunas é filtro de consulta indexável
--    (o watchdog varre as sessões vivas pelo ix_charging_session_watchdog já
--    existente e lê lastMeterValuesAt/statusReceivedAt só como atributo da
--    linha). Índice aqui seria custo de escrita por MeterValues sem leitura.
--  * Sem ADD VALUE de enum nesta migration, então pode viver num arquivo só.

-- ------------------------------------------------------------
-- 1) Colunas
-- ------------------------------------------------------------
ALTER TABLE "Connector"
  ADD COLUMN "statusReceivedAt" TIMESTAMPTZ(3);

ALTER TABLE "ChargingSession"
  ADD COLUMN "lastMeterValuesAt" TIMESTAMPTZ(3);

-- ------------------------------------------------------------
-- 2) Backfill
-- ------------------------------------------------------------
-- Connector: now() para TODOS os existentes. Sem isso, a regra R2 ("conector
-- preso num status há mais que a janela") olharia NULL/valor antigo e
-- dispararia para o parque inteiro no primeiro ciclo pós-deploy. now() dá a
-- cada conector uma janela cheia para voltar a falar.
UPDATE "Connector"
   SET "statusReceivedAt" = now()
 WHERE "statusReceivedAt" IS NULL;

-- ChargingSession: a melhor aproximação do "último MeterValues" já gravada é
-- lastActivityAt (que a migration 20261003120100 semeou com now() nas vivas).
-- Só sessões abertas/não confirmadas que TÊM lastActivityAt; STOPPED fica NULL
-- (não inventamos história para sessão encerrada). STOP_UNCONFIRMED entra
-- por completude (o valor de enum já está commitado desde 20261003120000);
-- hoje não deve haver linha nesse estado.
-- (Os triggers de Connector/ChargingSession só disparam em UPDATE OF
-- chargePointId/connectorId; estes UPDATEs não os acionam e não tocam
-- updatedAt.)
UPDATE "ChargingSession"
   SET "lastMeterValuesAt" = "lastActivityAt"
 WHERE status IN ('STARTED', 'CHARGING', 'FINISHING', 'FAULTED', 'STOP_UNCONFIRMED')
   AND "lastActivityAt" IS NOT NULL
   AND "lastMeterValuesAt" IS NULL;

-- ============================================================
-- Rollback (manual, Prisma não tem "down"). Perde-se só o que esta migration
-- gravou; nenhuma coluna pré-existente é tocada. DROP COLUMN é metadata-only.
-- Antes de reverter, o código da Vega que lê/grava estas colunas precisa estar
-- fora do ar (senão ele quebra com "column does not exist").
-- ============================================================
-- ALTER TABLE "ChargingSession" DROP COLUMN IF EXISTS "lastMeterValuesAt";
-- ALTER TABLE "Connector"       DROP COLUMN IF EXISTS "statusReceivedAt";
