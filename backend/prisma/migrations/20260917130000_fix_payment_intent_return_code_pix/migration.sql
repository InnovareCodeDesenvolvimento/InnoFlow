-- ============================================================
-- Fix: payment_intent_return_code_required era rígido demais para PIX
-- ============================================================
-- Bug real encontrado rodando o seed sintético em produção (17/09/2026):
-- a constraint original exigia `returnCode IS NOT NULL` para QUALQUER
-- PaymentIntent com status AUTHORIZED/CAPTURED, sem distinguir o meio de
-- pagamento. Mas `returnCode` é um conceito específico do fluxo de CARTÃO
-- da Cielo (prova de aprovação via código como '00'/'4'/'6') — o fluxo de
-- PIX (`WALLET_TOPUP_PIX`) não tem ReturnCode nenhum, a confirmação chega
-- por webhook (`ChangeType`), conforme já documentado pela Nova em
-- `.claude/agent-memory/nova/cielo-fatos-verificados.md`. Resultado: TODO
-- PIX capturado (o caso normal, não a exceção) violava a constraint —
-- isso teria bloqueado pagamentos PIX reais em produção na Fase 5, não só
-- o dado sintético do Cronos.
--
-- Correção: exigir `returnCode` só para intents de CARTÃO
-- (purpose = 'SESSION_CARD_CAPTURE'). PIX fica de fora da exigência.
-- Sem downtime: DROP + ADD ... NOT VALID + VALIDATE (mesmo padrão das
-- migrations anteriores deste projeto).

ALTER TABLE "PaymentIntent" DROP CONSTRAINT IF EXISTS "payment_intent_return_code_required";

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "payment_intent_return_code_required" CHECK (
    purpose <> 'SESSION_CARD_CAPTURE'
    OR status NOT IN ('AUTHORIZED', 'CAPTURED')
    OR "returnCode" IS NOT NULL
  ) NOT VALID;

ALTER TABLE "PaymentIntent" VALIDATE CONSTRAINT "payment_intent_return_code_required";

-- ============================================================
-- Rollback (guardado para quem precisar reverter na mão):
-- ============================================================
-- ALTER TABLE "PaymentIntent" DROP CONSTRAINT IF EXISTS "payment_intent_return_code_required";
-- ALTER TABLE "PaymentIntent"
--   ADD CONSTRAINT "payment_intent_return_code_required" CHECK (
--     status NOT IN ('AUTHORIZED', 'CAPTURED') OR "returnCode" IS NOT NULL
--   ) NOT VALID;
-- ALTER TABLE "PaymentIntent" VALIDATE CONSTRAINT "payment_intent_return_code_required";
