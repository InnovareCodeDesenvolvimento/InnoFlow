-- ============================================================
-- F5.4 (Cronos, 2026-09-30): plugar o cartão salvo na SESSÃO de recarga
-- (pré-autorização no início, captura parcial no fim).
-- ============================================================
-- Desenho: .claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md §2
-- ("Início da recarga" e "Stop"). Continuação de F5.1/F5.2/F5.3 (fundação
-- do gateway, estados Pix, cadastro de cartão) — já publicadas.
--
-- Três mudanças aditivas, sem downtime (mesma convenção já estabelecida
-- neste repo, ver header de 20260930120100_payment_gateway_foundation):
-- ADD COLUMN nullable/DEFAULT constante é metadata-only desde PG11; CREATE
-- TYPE de enum NOVO pode ser criado e usado na mesma transação (só
-- `ALTER TYPE ... ADD VALUE` em enum EXISTENTE precisaria de migration
-- isolada — não é o caso aqui, ver tecnica-migration-sem-banco-vivo.md);
-- CHECK e FOREIGN KEY novas usam NOT VALID + VALIDATE CONSTRAINT em
-- statement separado (não bloqueiam leitura/escrita concorrente durante a
-- validação, e não seguram lock enquanto escaneiam PaymentIntent, que já
-- tem linhas reais em produção desde F5.1). SEM CREATE INDEX CONCURRENTLY
-- (Prisma Migrate roda o arquivo inteiro numa transação só).

-- ============================================================
-- 1) ChargingSession.paymentMode — WALLET (default, débito direto na
--    carteira no StopTransaction) ou CARD (pré-auth + captura via
--    PaymentIntent). Enum NOVO, pode ser usado na mesma transação em que é
--    criado.
-- ============================================================
CREATE TYPE "ChargingSessionPaymentMode" AS ENUM ('WALLET', 'CARD');

ALTER TABLE "ChargingSession"
  ADD COLUMN "paymentMode" "ChargingSessionPaymentMode" NOT NULL DEFAULT 'WALLET';

-- ============================================================
-- 2) PaymentIntent.authTokenId — vínculo com a pré-autorização de cartão.
-- ============================================================
-- Preenchido só quando purpose='SESSION_CARD_CAPTURE' (nunca para
-- WALLET_TOPUP_PIX — reforçado abaixo na CHECK). É o vínculo que o
-- StartTransaction usa para achar a pré-autorização AUTHORIZED a partir do
-- idTag que chegou no handshake OCPP: AuthToken.idTag -> AuthToken.id ->
-- PaymentIntent.authTokenId. UNIQUE porque cada idTag virtual autoriza no
-- máximo um PaymentIntent.
ALTER TABLE "PaymentIntent" ADD COLUMN "authTokenId" TEXT;

CREATE UNIQUE INDEX "PaymentIntent_authTokenId_key" ON "PaymentIntent"("authTokenId");

-- FK com o mesmo padrão onDelete: Restrict das outras FKs deste model
-- (chargingSession/paymentMethod/wallet/user/operator) — NOT VALID + VALIDATE
-- em statement separado: todas as linhas existentes já têm authTokenId NULL
-- (coluna acabou de nascer), então a validação é trivial, mas o padrão
-- NOT VALID evita segurar ACCESS EXCLUSIVE/SHARE ROW EXCLUSIVE escaneando a
-- tabela inteira enquanto valida — mesma disciplina de sem-downtime já usada
-- para CHECK constraints neste repo, aplicada aqui a uma FOREIGN KEY.
ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_authTokenId_fkey"
  FOREIGN KEY ("authTokenId") REFERENCES "AuthToken"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;
ALTER TABLE "PaymentIntent" VALIDATE CONSTRAINT "PaymentIntent_authTokenId_fkey";

-- Índice próprio além do índice único implícito? Decisão: NÃO. A consulta do
-- checkAuthorization no handler OCPP é um lookup pontual
-- (`WHERE "authTokenId" = $1 [AND status = 'AUTHORIZED']`) — o índice único
-- B-tree criado acima já localiza no máximo 1 linha por valor de
-- authTokenId (é @unique), então filtrar status depois é uma checagem sobre
-- essa única linha, não uma varredura. Um índice composto
-- (authTokenId, status) não reduziria I/O nenhum aqui; adicionaria custo de
-- escrita sem ganho de leitura (mandato "não indexar por garantia").
-- Reavaliar só se a consulta real do Vega vier a filtrar por status SEM
-- passar authTokenId (não é o caso deste fluxo).

-- ============================================================
-- 3) PaymentIntent.captureAmountCents — valor-ALVO da captura.
-- ============================================================
-- DISTINTO de amountCapturedCents (já existe desde a migration inicial) —
-- não confundir os dois: captureAmountCents é o valor que o finalizarSessao
-- calcula e grava ao entrar em CAPTURE_PENDING
-- (min(total da sessão, amountAuthorizedCents)) — o que MANDAMOS cobrar.
-- amountCapturedCents continua sendo o que a Cielo de fato CONFIRMOU ter
-- capturado, só preenchido depois do sucesso do PUT /capture. Os dois
-- convivem no mesmo PaymentIntent: captureAmountCents não é sobrescrito por
-- amountCapturedCents, fica como registro do alvo mesmo se a captura
-- falhar/retentar (o varredor de conciliação compara os dois).
ALTER TABLE "PaymentIntent" ADD COLUMN "captureAmountCents" INTEGER;

-- ------------------------------------------------------------
-- Ajuste na CHECK payment_intent_purpose_consistency (F5.1,
-- 20260930120100_payment_gateway_foundation): authTokenId só pode estar
-- preenchido do lado SESSION_CARD_CAPTURE.
-- ------------------------------------------------------------
-- Decisão: NÃO exigir authTokenId NOT NULL sempre que purpose =
-- SESSION_CARD_CAPTURE (ida única, não bidirecional). Motivo real, não só
-- teórico: `seed-demo.ts` já insere PaymentIntent com
-- purpose='SESSION_CARD_CAPTURE' vinculado diretamente via
-- chargingSessionId, simulando sessões históricas que nunca passaram pelo
-- fluxo real de pré-auth com AuthToken (essas linhas nasceriam com
-- authTokenId NULL e violariam uma CHECK bidirecional). A direção que
-- IMPORTA proteger é a outra: WALLET_TOPUP_PIX nunca pode carregar um
-- authTokenId (não faz sentido semântico nenhum uma recarga de carteira
-- estar amarrada a uma pré-autorização de cartão) — essa é a que a CHECK
-- abaixo reforça.
ALTER TABLE "PaymentIntent" DROP CONSTRAINT "payment_intent_purpose_consistency";

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "payment_intent_purpose_consistency" CHECK (
    (purpose = 'SESSION_CARD_CAPTURE' AND "walletId" IS NULL AND
      (status NOT IN ('CAPTURE_PENDING', 'CAPTURED') OR "chargingSessionId" IS NOT NULL)) OR
    (purpose = 'WALLET_TOPUP_PIX' AND "walletId" IS NOT NULL AND "chargingSessionId" IS NULL AND "authTokenId" IS NULL)
  ) NOT VALID;
ALTER TABLE "PaymentIntent" VALIDATE CONSTRAINT "payment_intent_purpose_consistency";
-- Nota: toda linha existente tem authTokenId NULL (coluna nova nesta mesma
-- migration) — nenhuma linha WALLET_TOPUP_PIX pode violar a cláusula nova.
-- VALIDATE aqui é formalidade de padrão, mesma nota das migrations
-- anteriores desta família.

-- ------------------------------------------------------------
-- Trigger set_payment_intent_operator_id (init migration, 16/09): NENHUMA
-- mudança necessária — conferido. O trigger dispara em
-- `BEFORE INSERT OR UPDATE OF "chargingSessionId"` e deriva operatorId a
-- partir da sessão; authTokenId não participa dessa derivação (a
-- pré-autorização nasce sem sessão e sem operatorId mesmo, documentado em
-- F5.1 seção 3) — nada a propagar aqui.
-- ------------------------------------------------------------

-- ============================================================
-- Rollback (manual, Prisma não tem "down"):
-- ============================================================
-- ALTER TABLE "PaymentIntent" DROP CONSTRAINT IF EXISTS "payment_intent_purpose_consistency";
-- ALTER TABLE "PaymentIntent" ADD CONSTRAINT "payment_intent_purpose_consistency" CHECK (
--   (purpose = 'SESSION_CARD_CAPTURE' AND "walletId" IS NULL AND
--     (status NOT IN ('CAPTURE_PENDING', 'CAPTURED') OR "chargingSessionId" IS NOT NULL)) OR
--   (purpose = 'WALLET_TOPUP_PIX' AND "walletId" IS NOT NULL AND "chargingSessionId" IS NULL)
-- ); -- falha se houver linha WALLET_TOPUP_PIX com authTokenId preenchido (não deveria existir)
-- ALTER TABLE "PaymentIntent" DROP COLUMN IF EXISTS "captureAmountCents";
-- ALTER TABLE "PaymentIntent" DROP CONSTRAINT IF EXISTS "PaymentIntent_authTokenId_fkey";
-- DROP INDEX IF EXISTS "PaymentIntent_authTokenId_key";
-- ALTER TABLE "PaymentIntent" DROP COLUMN IF EXISTS "authTokenId";
-- ALTER TABLE "ChargingSession" DROP COLUMN IF EXISTS "paymentMode";
-- DROP TYPE IF EXISTS "ChargingSessionPaymentMode";
