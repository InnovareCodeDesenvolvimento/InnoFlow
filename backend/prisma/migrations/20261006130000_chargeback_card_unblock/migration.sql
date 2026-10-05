-- ============================================================
-- L1.8 / DL7 / P3 (Vega-E, 06/10/2026) — desbloqueio MANUAL do modo cartão depois de um chargeback perdido.
-- O dono aceitou: LOST/ACCEPTED bloqueia o cartão do motorista e o ADMIN pode DESBLOQUEAR, caso a caso (com motivo e senha).
-- O bloqueio segue DERIVADO (sem flag no usuário): bloqueado = chargeback OPEN, ou LOST/ACCEPTED com "cardUnblockedAt" nulo.
-- EXPAND PURO: 3 colunas nulas em PaymentReversal (só catálogo, sem rewrite), 1 FK, 1 CHECK e a troca do corpo de UMA função de trigger. Nada removido/renomeado.
-- O índice parcial ix_payment_reversal_card_block (status IN OPEN/LOST/ACCEPTED) continua servindo: a consulta nova é um SUBCONJUNTO desse predicado.
-- ============================================================

ALTER TABLE "PaymentReversal"
  ADD COLUMN "cardUnblockedAt" TIMESTAMPTZ(3),
  ADD COLUMN "cardUnblockedByUserId" TEXT,
  ADD COLUMN "cardUnblockReason" VARCHAR(500);

ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_cardUnblockedByUserId_fkey" FOREIGN KEY ("cardUnblockedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Os três campos nascem JUNTOS e só num chargeback PERDIDO (LOST/ACCEPTED): o desbloqueio não existe para OPEN (já bloqueado por estar em aberto), WON (nunca bloqueou) nem para estorno.
ALTER TABLE "PaymentReversal"
  ADD CONSTRAINT "payment_reversal_card_unblock" CHECK (
    ("cardUnblockedAt" IS NULL AND "cardUnblockedByUserId" IS NULL AND "cardUnblockReason" IS NULL)
    OR (
      "kind" = 'CHARGEBACK' AND "status" IN ('LOST', 'ACCEPTED')
      AND "cardUnblockedAt" IS NOT NULL AND "cardUnblockedByUserId" IS NOT NULL
      AND "cardUnblockReason" IS NOT NULL AND length(btrim("cardUnblockReason")) > 0
    )
  ) NOT VALID;
ALTER TABLE "PaymentReversal" VALIDATE CONSTRAINT "payment_reversal_card_unblock";

-- Guard (corpo da migration 20261005150100 + 2 regras): o estado terminal continua imutável EXCETO os três campos de desbloqueio, que podem passar de NULL para preenchidos UMA vez
-- (num chargeback já LOST/ACCEPTED) e depois nunca mais mudam nem voltam a NULL. Tipo, vínculos, valor, motivo, dossiê e autoria seguem imutáveis (o dossiê NÃO é tocado pelo desbloqueio).
CREATE OR REPLACE FUNCTION payment_reversal_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PaymentReversal é registro financeiro — DELETE não é permitido (id=%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Imutáveis: o fato registrado (tipo, vínculos, valor, motivo, dossiê, quem registrou e quando). Mudam só status, resolução, dívida, referências do portal/prazo e o desbloqueio do cartão.
  IF (NEW."id", NEW."kind", NEW."destination", NEW."chargingSessionId", NEW."paymentIntentId", NEW."userId", NEW."amountCents", NEW."reason",
      NEW."caseReference", NEW."notifiedAt", NEW."dossierSnapshot", NEW."walletEntryId", NEW."createdByUserId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."kind", OLD."destination", OLD."chargingSessionId", OLD."paymentIntentId", OLD."userId", OLD."amountCents", OLD."reason",
      OLD."caseReference", OLD."notifiedAt", OLD."dossierSnapshot", OLD."walletEntryId", OLD."createdByUserId", OLD."createdAt") THEN
    RAISE EXCEPTION 'PaymentReversal: tipo, vínculos, valor, motivo, dossiê e autoria são imutáveis (id=%)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Desbloqueio do cartão: registrado UMA vez, só num chargeback JÁ perdido (a mudança de estado e o desbloqueio nunca andam juntos), e depois imutável.
  IF (NEW."cardUnblockedAt", NEW."cardUnblockedByUserId", NEW."cardUnblockReason") IS DISTINCT FROM (OLD."cardUnblockedAt", OLD."cardUnblockedByUserId", OLD."cardUnblockReason") THEN
    IF OLD."cardUnblockedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PaymentReversal: o desbloqueio do cartão já foi registrado e não muda mais (id=%)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."kind" <> 'CHARGEBACK' OR OLD."status" NOT IN ('LOST', 'ACCEPTED') THEN
      RAISE EXCEPTION 'PaymentReversal: só um chargeback já perdido (LOST/ACCEPTED) pode ter o cartão desbloqueado (id=%)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD."status" IN ('CONFIRMED', 'CANCELLED', 'WON', 'LOST', 'ACCEPTED')
     AND (to_jsonb(NEW) - 'updatedAt' - 'cardUnblockedAt' - 'cardUnblockedByUserId' - 'cardUnblockReason') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt' - 'cardUnblockedAt' - 'cardUnblockedByUserId' - 'cardUnblockReason') THEN
    RAISE EXCEPTION 'PaymentReversal: estado terminal % não muda mais (id=%)', OLD."status", OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- ROLLBACK MANUAL (ordem inversa; antes, conferir `SELECT count(*) FROM "PaymentReversal" WHERE "cardUnblockedAt" IS NOT NULL` — o rollback apagaria o registro dos desbloqueios,
-- e os motoristas desbloqueados voltariam a ficar bloqueados pela consulta antiga):
--   1) restaurar o corpo de payment_reversal_guard() da migration 20261005150100 (CREATE OR REPLACE com aquele texto);
--   2) ALTER TABLE "PaymentReversal" DROP CONSTRAINT "payment_reversal_card_unblock";
--   3) ALTER TABLE "PaymentReversal" DROP CONSTRAINT "PaymentReversal_cardUnblockedByUserId_fkey";
--   4) ALTER TABLE "PaymentReversal" DROP COLUMN "cardUnblockedAt", DROP COLUMN "cardUnblockedByUserId", DROP COLUMN "cardUnblockReason";
-- ============================================================
