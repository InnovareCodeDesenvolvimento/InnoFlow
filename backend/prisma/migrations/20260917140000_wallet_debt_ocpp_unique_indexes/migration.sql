-- ============================================================
-- F4 (Cronos, 2026-09-17): 3 índices únicos parciais/compostos que
-- transformam corrida de concorrência em erro de banco alto e claro, agora
-- que dinheiro real (carteira) passa a circular via StopTransaction.
-- ============================================================
-- Esta migration só ADICIONA (nenhum DROP/ALTER destrutivo) — rollback é
-- sempre possível derrubando o que foi criado aqui, sem perda de dados
-- (ver bloco de DOWN comentado no final do arquivo).
--
-- Sem CONCURRENTLY de propósito: o Prisma Migrate envolve o arquivo inteiro
-- numa transação e `CREATE INDEX CONCURRENTLY` não roda dentro de
-- transação (já causou falha real em produção nesta mesma migration —
-- ver 20260916150000_retaguarda_indices_live_panel). Tabelas ainda
-- pequenas nesta fase — lock breve de CREATE INDEX normal é aceitável.

-- ------------------------------------------------------------
-- 1) WalletEntry: nunca debitar a mesma sessão duas vezes.
-- ------------------------------------------------------------
-- O StopTransaction do Vega protege isso em runtime com `FOR UPDATE`, mas
-- essa é a rede de segurança de banco — se a corrida escapar do lock da
-- aplicação (bug, retry duplicado, dois workers), o segundo INSERT falha
-- com unique_violation em vez de duplicar a cobrança silenciosamente.
-- NÃO é `@@unique` no schema.prisma porque é parcial (só se aplica a
-- CHARGE_DEBIT — TOPUP/ADJUSTMENT/REFUND continuam livres para repetir
-- referenceId, ex. vários créditos manuais no mesmo dia).
CREATE UNIQUE INDEX "ux_wallet_entry_charge_debit_once"
  ON "WalletEntry" ("referenceType", "referenceId")
  WHERE type = 'CHARGE_DEBIT';

-- ------------------------------------------------------------
-- 2) Debt: no máximo uma dívida ABERTA por sessão.
-- ------------------------------------------------------------
-- NULL nunca colide em índice único — dívidas sem chargingSessionId
-- (ex. writeoff manual sem sessão associada) continuam livres, a restrição
-- vale só quando a dívida está de fato amarrada a uma sessão.
CREATE UNIQUE INDEX "ux_debt_open_per_session"
  ON "Debt" ("chargingSessionId")
  WHERE status = 'OPEN';

-- ------------------------------------------------------------
-- 3) OcppMessage: idempotência de log por (chargePointId, ocppMessageId,
--    direction) — pendência que o próprio Vega documentou em
--    `backend/src/ocpp/idempotency.ts` como "trabalho de schema, sinalizado
--    no handoff". Virou risco real agora que StopTransaction movimenta
--    dinheiro (duplicar o log OUTBOUND não duplica cobrança por si só, mas
--    é a mesma classe de corrida que motiva o índice acima).
-- ------------------------------------------------------------
-- OcppMessage é particionada por RANGE(occurredAt) (ver
-- 20260916120000_init_multi_tenant_partitioned) — Postgres EXIGE que a
-- coluna de particionamento esteja incluída em qualquer índice único da
-- tabela-mãe, por isso "occurredAt" entra na chave. Na prática isso não
-- enfraquece a proteção contra o cenário real (reenvio do MESMO envelope
-- OCPP-J ao reconectar): o `occurredAt` é extraído do próprio payload
-- (`extractEventTimestamp`), então um reenvio verbatim carrega o mesmo
-- timestamp e ainda colide. O caso que escaparia (mesmo ocppMessageId,
-- payload diferente, timestamp diferente) já seria uma mensagem OCPP
-- malformada/fora de especificação, não o retry que este índice existe
-- para cobrir.
CREATE UNIQUE INDEX "ux_ocpp_message_dedupe"
  ON "OcppMessage" ("chargePointId", "ocppMessageId", "direction", "occurredAt");

-- ============================================================
-- Rollback (não executado automaticamente — Prisma Migrate não tem "down"
-- automático; guardado aqui para quem precisar reverter na mão):
-- ============================================================
-- DROP INDEX IF EXISTS "ux_ocpp_message_dedupe";
-- DROP INDEX IF EXISTS "ux_debt_open_per_session";
-- DROP INDEX IF EXISTS "ux_wallet_entry_charge_debit_once";
