-- ============================================================
-- F5.7 (Cronos, 2026-10-02): marca de ambiente (SANDBOX/PRODUCTION) em
-- PaymentMethod e PaymentIntent — achado M4 do portão final da F5 (Órion).
-- ============================================================
-- Problema: cartões tokenizados e intents criados em SANDBOX continuavam
-- "vivos" quando o ADMIN virava o gateway para PRODUÇÃO. Token de sandbox
-- não cobra em produção, e intent em trânsito seria reconsultado no host
-- errado. A lógica (listar/usar só cartões do ambiente efetivo; bloquear a
-- troca de ambiente com pagamento em trânsito) é do Vega; aqui só o schema.
--
-- Duas colunas aditivas + um enum NOVO, sem downtime:
--  * CREATE TYPE de enum NOVO pode ser criado e usado na mesma transação
--    (só `ALTER TYPE ... ADD VALUE` em enum EXISTENTE exigiria migration
--    isolada — não é o caso, ver tecnica-migration-sem-banco-vivo.md).
--  * ADD COLUMN ... NOT NULL DEFAULT <constante> é metadata-only desde o
--    PG11: não reescreve a tabela, o lock ACCESS EXCLUSIVE é instantâneo.
--  * Sem CHECK/FK novos, então nada a validar (NOT VALID não se aplica).
--  * Sem CREATE INDEX CONCURRENTLY (Prisma Migrate roda o arquivo numa
--    transação só) — e nenhum índice é criado, ver decisão abaixo.

-- ============================================================
-- 1) Enum novo
-- ============================================================
CREATE TYPE "PaymentEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- ============================================================
-- 2) Colunas — DEFAULT 'SANDBOX'
-- ============================================================
-- Por que SANDBOX para o legado: TODA linha existente nasceu sob o sandbox
-- Cielo ou sob o simulador (PaymentGatewayConfig/gateway fake) — nunca
-- houve dinheiro real processado neste sistema. Logo 'SANDBOX' não é um
-- chute conveniente, é o rótulo VERDADEIRO do legado. Rotular o legado como
-- PRODUCTION seria o erro perigoso (tokens/intents falsos passariam por
-- reais no dia da virada).
--
-- O DEFAULT fica na coluna (não é só para o backfill): qualquer INSERT que
-- ainda não saiba do campo (seed-demo.ts, testes, código antigo durante um
-- deploy em duas etapas) cai no lado seguro. O Vega passa o ambiente
-- efetivo explicitamente nos inserts reais.
ALTER TABLE "PaymentMethod"
  ADD COLUMN "environment" "PaymentEnvironment" NOT NULL DEFAULT 'SANDBOX';

ALTER TABLE "PaymentIntent"
  ADD COLUMN "environment" "PaymentEnvironment" NOT NULL DEFAULT 'SANDBOX';

-- ============================================================
-- 3) Índices — avaliados, NENHUM criado (mandato "não indexar por garantia")
-- ============================================================
-- (a) Vega, ao trocar o ambiente do gateway:
--       SELECT count(*) FROM "PaymentIntent"
--        WHERE environment = X AND status IN ('CREATED','AUTHORIZED',
--              'PENDING','CAPTURE_PENDING');
--     O predicado seletivo é o STATUS, não o ambiente: os 4 estados "vivos"
--     são uma fração ínfima da tabela (a imensa maioria das linhas está em
--     CAPTURED/PAID/DENIED/FAILED/EXPIRED/VOIDED — estados terminais).
--     Os índices existentes "PaymentIntent_status_idx" e
--     "PaymentIntent_status_updatedAt_idx" (status, updatedAt) já levam o
--     planner direto a essas poucas linhas; `environment` é então só um
--     filtro de heap sobre um punhado de linhas. Um índice
--     (environment, status) NÃO reduziria o conjunto lido (environment tem
--     2 valores; a seletividade vem toda do status) e custaria escrita em
--     TODA mudança de status de PaymentIntent (tabela quente, com varredor
--     de conciliação atualizando updatedAt). Além disso a consulta roda só
--     numa ação rara e manual do ADMIN (virar o ambiente), não em caminho
--     quente. Um índice parcial (WHERE status IN (...)) seria ainda menos
--     defensável: não pode ser criado nem usado na mesma transação de um
--     ADD VALUE, e acopla o índice à lista de estados vivos que o Vega
--     ainda pode mudar.
--
-- (b) Vega, ao listar cartões:
--       SELECT ... FROM "PaymentMethod"
--        WHERE "userId" = U AND active AND environment = X;
--     "PaymentMethod_userId_idx" já reduz a no máximo a meia dúzia de cartões
--     do motorista; `environment` e `active` filtram sobre essas poucas
--     linhas. Índice composto (userId, environment) seria custo de escrita
--     sem ganho de leitura mensurável.
--
-- Reavaliar SE: PaymentIntent passar de alguns milhões de linhas E o
-- count(*) de troca de ambiente aparecer em pg_stat_statements como lento
-- (o plano esperado é Bitmap/Index Scan em PaymentIntent_status_idx; se o
-- planner preferir Seq Scan, a solução é um índice parcial
-- "WHERE status IN (...)", em migration própria, sem ADD VALUE junto).

-- ============================================================
-- 4) Interações conferidas (nada precisou mudar)
-- ============================================================
--  * payment_intent_purpose_consistency (CHECK): só olha purpose/walletId/
--    chargingSessionId/authTokenId/status — não toca environment.
--  * ux_payment_intent_active_per_session (único parcial por sessão),
--    PaymentIntent_authTokenId_key (@unique), PaymentIntent_cieloPaymentId_key
--    (@unique): nenhum inclui environment e NÃO devem incluir — são unicidades
--    globais (a Cielo não reusa PaymentId entre ambientes na prática, e a
--    sessão/idTag virtual é uma só independente de ambiente).
--  * Triggers (set_payment_intent_operator_id e demais): disparam em
--    UPDATE OF "chargingSessionId"/colunas de FK — environment não participa
--    de nenhuma derivação, sem mudança.
--  * PaymentMethod não tem CHECK/trigger/único parcial além de
--    PaymentMethod_userId_idx. Nota para o Vega: "isDefault" NÃO é único por
--    usuário no banco; com cartões de dois ambientes, "o cartão padrão" tem
--    de ser resolvido por (userId, environment, isDefault).

-- ============================================================
-- Rollback (manual, Prisma não tem "down"). Perde-se só a marca de
-- ambiente; nenhuma linha é apagada. Só é seguro reverter ANTES de existir
-- qualquer linha PRODUCTION (depois dela, o rollback apagaria a informação
-- que distingue token de produção de token de sandbox):
-- ============================================================
-- ALTER TABLE "PaymentIntent" DROP COLUMN IF EXISTS "environment";
-- ALTER TABLE "PaymentMethod" DROP COLUMN IF EXISTS "environment";
-- DROP TYPE IF EXISTS "PaymentEnvironment";
