-- ============================================================
-- F5.9 (Cronos, 2026-10-03): "ChargePoint"."connectedAt" — achado M2 do Órion
-- (docs/AUDITORIA-F5.9.md).
-- ============================================================
-- Problema: hoje só existem lastBootAt / lastSeenAt / disconnectedAt. O
-- watchdog de sessão travada não sabe HÁ QUANTO TEMPO o carregador está de
-- volta: com a sessão em STOP_UNCONFIRMED há 30 min e o carregador visto há
-- 6 s (acabou de reconectar), a janela G1 já "venceu" e o servidor encerra no
-- 1º ciclo, antes de o Stop enfileirado ser entregue.
--
-- connectedAt = instante do SERVIDOR (relógio do servidor, nunca do carregador)
-- em que o WebSocket (re)conectou. Gravado pelo gateway OCPP no handshake
-- (código da Vega, fora desta migration). NULL = desconhecido: o leitor cai no
-- comportamento antigo.
--
-- Sem downtime, tudo aditivo:
--  * ADD COLUMN nullable sem DEFAULT: metadata-only (sem reescrita, lock
--    ACCESS EXCLUSIVE só pelo instante do catálogo).
--  * Backfill é UPDATE em "ChargePoint" (dezenas/centenas de linhas, um por
--    carregador físico) — não é tabela grande.
--  * Sem índice: coluna lida só como atributo da linha já localizada por id;
--    nenhuma consulta filtra por ela. Índice = custo de escrita a cada
--    reconexão sem leitura que o justifique.
--  * Sem ADD VALUE de enum, então cabe em um arquivo só.

-- ------------------------------------------------------------
-- 1) Coluna
-- ------------------------------------------------------------
ALTER TABLE "ChargePoint"
  ADD COLUMN "connectedAt" TIMESTAMPTZ(3);

-- ------------------------------------------------------------
-- 2) Backfill conservador
-- ------------------------------------------------------------
-- connectedAt = lastSeenAt SOMENTE para o carregador que o próprio banco
-- considera conectado: lastSeenAt preenchido E (nunca registrou disconnectedAt
-- OU disconnectedAt é ANTERIOR ao lastSeenAt). É a negação exata da regra de
-- queda de isChargePointOnline (core/estacoes/disponibilidade.ts: caiu quando
-- disconnectedAt >= lastSeenAt). Sem checar o limiar de 5 min de propósito:
-- "conectado" aqui é "não consta queda", não "falou agora".
--
-- Por que isso é seguro (e o único erro possível é para o lado conservador):
--  * lastSeenAt é SEMPRE >= ao instante real da reconexão (a conexão é a
--    primeira mensagem vista). Logo o connectedAt do backfill nunca é anterior
--    à reconexão real: no pior caso SUBESTIMA há quanto tempo o carregador está
--    de volta, o que faz o watchdog esperar um pouco mais — nunca encerrar cedo
--    demais. Superestimar seria o lado perigoso (reabriria o M2), e não ocorre.
--  * É um valor aproximado, não um fato medido; a primeira reconexão real após
--    o deploy sobrescreve com o instante exato do handshake.
--  * Carregador sem lastSeenAt (nunca falou) ou com queda registrada fica NULL
--    = "desconhecido" => Vega usa o comportamento antigo.
-- (O trigger de ChargePoint só dispara em UPDATE OF siteId; este UPDATE não o
-- aciona e não toca updatedAt.)
UPDATE "ChargePoint"
   SET "connectedAt" = "lastSeenAt"
 WHERE "connectedAt" IS NULL
   AND "lastSeenAt" IS NOT NULL
   AND ("disconnectedAt" IS NULL OR "disconnectedAt" < "lastSeenAt");

-- ============================================================
-- Rollback (manual, Prisma não tem "down"). DROP COLUMN é metadata-only; perde
-- só o que esta migration gravou, nenhuma coluna pré-existente é tocada. Antes
-- de reverter, o código da Vega que lê/grava connectedAt precisa estar fora do
-- ar (senão quebra com "column does not exist").
-- ============================================================
-- ALTER TABLE "ChargePoint" DROP COLUMN IF EXISTS "connectedAt";
