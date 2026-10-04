-- ============================================================
-- C2.5 (Cronos, 2026-10-04): identificadores da transação Cielo em
-- "PaymentIntent" — achado F22 de docs/GATEWAY-CIELO-PARQUE-VS-INNOFLOW.md.
-- ============================================================
-- Problema: a Cielo só permite consultar uma venda por 3 meses, e o chargeback
-- chega meses depois. O que a contestação pede (Tid, AuthorizationCode,
-- ProofOfSale/NSU) precisa ser gravado NA HORA da autorização/captura — depois
-- é impossível redescobrir. Hoje o PaymentIntent guarda só cieloPaymentId e
-- returnCode. O Parque das Feiras já guarda os quatro (adaptadores/cielo/
-- index.ts, ~347-364); aqui entram os três que não existem no InnoFlow
-- (o SentOrderId fica fora do pedido desta tarefa).
--
-- Colunas (todas anuláveis: Pix e intent que nunca chegou à Cielo não têm):
--   cieloTid               VARCHAR(64)
--   cieloAuthorizationCode VARCHAR(64)
--   cieloProofOfSale       VARCHAR(64)
-- Tamanho: a API 3.0 documenta Tid e ProofOfSale com 20 caracteres e
-- AuthorizationCode com 6 (do conhecimento da doc, NÃO reconferido ao vivo; o
-- código do Parque não fixa comprimento). 64 = ~3x o maior documentado, de
-- propósito: estourar o limite faria o UPDATE falhar DEPOIS de a Cielo já ter
-- autorizado. Alargar VarChar depois é barato; perder o registro não se desfaz.
--
-- Sem downtime, tudo aditivo:
--  * ADD COLUMN nullable sem DEFAULT: metadata-only (sem reescrita da tabela,
--    ACCESS EXCLUSIVE só pelo instante de mexer no catálogo). Os 3 numa única
--    ALTER TABLE = um só lock.
--  * Sem backfill: o legado nunca teve esses valores (e o legado é sandbox/
--    simulador, ver PaymentIntent.environment). NULL = "não registrado".
--  * Sem índice: nenhuma consulta do sistema filtra por eles — o webhook e a
--    conciliação casam por cieloPaymentId (já @unique). Índice em coluna só
--    escrita = custo a cada autorização, zero leitura. Se um dia existir tela
--    de suporte "achar intent pelo Tid", reavaliar com EXPLAIN real (índice
--    parcial WHERE "cieloTid" IS NOT NULL, em migration própria).
--  * Sem CHECK: não há regra de negócio no banco a reforçar (formato é da
--    Cielo e pode mudar); a validade é da aplicação.
--  * Sem ADD VALUE de enum, então cabe em um arquivo só.
--  * Nenhum trigger/CHECK/índice existente de PaymentIntent lê estas colunas.

ALTER TABLE "PaymentIntent"
  ADD COLUMN "cieloTid"               VARCHAR(64),
  ADD COLUMN "cieloAuthorizationCode" VARCHAR(64),
  ADD COLUMN "cieloProofOfSale"       VARCHAR(64);

-- ============================================================
-- Rollback (manual, Prisma não tem "down"). DROP COLUMN é metadata-only; perde
-- SÓ o que esta migration gravou (nenhuma coluna pré-existente é tocada) — mas
-- perder Tid/NSU é exatamente a perda que esta migration existe para evitar:
-- só reverter se ainda NÃO houver transação real gravada (ambiente sandbox), ou
-- depois de exportar os valores. O código da Vega que lê/grava estes campos
-- precisa estar fora do ar antes (senão quebra com "column does not exist").
-- ============================================================
-- ALTER TABLE "PaymentIntent"
--   DROP COLUMN IF EXISTS "cieloProofOfSale",
--   DROP COLUMN IF EXISTS "cieloAuthorizationCode",
--   DROP COLUMN IF EXISTS "cieloTid";
