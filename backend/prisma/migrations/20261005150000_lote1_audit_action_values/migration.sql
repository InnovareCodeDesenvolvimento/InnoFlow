-- ============================================================
-- Lote 1 da F6 (Cronos, 2026-10-05) — PARTE 1/2: valores novos de AuditAction.
-- ============================================================
-- Desenho: docs/MODELO-DADOS-LOTE1.md. Contrato: frontend/src/types/api.ts (commit 5ef6386).
--
-- Por que este arquivo é SÓ `ADD VALUE`: `prisma migrate deploy` roda cada arquivo numa ÚNICA transação e o Postgres proíbe USAR um valor recém-criado por
-- `ALTER TYPE ... ADD VALUE` (CHECK, índice parcial `WHERE`, INSERT/UPDATE) na mesma transação ("unsafe use of new value of enum type"). Hoje nada na parte 2
-- cita estes valores, mas o isolamento é regra do projeto (ver 20260930120000_payment_gateway_enum_values e 20261003120000_session_stop_unconfirmed_enums) e
-- evita que um CHECK/índice futuro quebre o deploy. Os enums NOVOS (CREATE TYPE) ficam na parte 2 — criar e usar na mesma transação é permitido.
--
-- Valores (um por trilha de auditoria que hoje cairia em `OTHER`):
--   PASSWORD_RESET    — L1.3, redefinição de senha por e-mail (o evento sai de trás de `OTHER`)
--   ACCOUNT_DELETION  — L1.4, exclusão/anonimização pelo titular E o registro do reembolso do saldo pelo ADMIN (actionDetail distingue)
--   REFUND            — L1.8, estorno de sessão registrado pelo ADMIN
--   CHARGEBACK        — L1.8, chargeback registrado/resolvido pelo ADMIN
-- Valor de enum é para sempre (Postgres não tem DROP VALUE): por isso só os quatro realmente necessários.
-- `IF NOT EXISTS` torna o arquivo reaplicável à mão sem erro.
--
-- Efeito em quem lê o enum (conferido, não corrigido aqui — fora do escopo de banco):
--   * backend/src/api/schemas/auditLog.schema.ts tem um z.enum espelhando AuditAction (já sem PAYMENT_CREDIT/PAYMENT_CONFIG_CHANGE): o filtro por ação não
--     enxerga os valores novos até o Vega acrescentá-los;
--   * frontend/src/types/api.ts `AuditAction` e `AUDIT_ACTION_LABELS: Record<AuditAction, string>` (utils.ts) precisam dos 4 valores novos.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REFUND';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CHARGEBACK';

-- ============================================================
-- Rollback (manual — Prisma não tem "down"):
-- ============================================================
-- Postgres não tem `ALTER TYPE ... DROP VALUE`. Valor ocioso no enum é inofensivo; deixe-o. Só se for MESMO preciso removê-lo (e só DEPOIS de nenhuma linha de
-- AuditLog usá-lo — e AuditLog é append-only, então linhas com estes valores não saem antes dos 24 meses), recriar o tipo:
--   ALTER TYPE "AuditAction" RENAME TO "AuditAction_old";
--   CREATE TYPE "AuditAction" AS ENUM ('CREATE','UPDATE','DELETE','REMOTE_COMMAND','WALLET_ADJUSTMENT','LOGIN_SUCCESS','LOGIN_FAILED','EXPORT','PAYMENT_CREDIT','PAYMENT_CONFIG_CHANGE','OTHER');
--   ALTER TABLE "AuditLog" ALTER COLUMN "action" TYPE "AuditAction" USING "action"::text::"AuditAction";   -- REESCREVE a tabela (ACCESS EXCLUSIVE) e o trigger de append-only não bloqueia DDL
--   DROP TYPE "AuditAction_old";
-- Não vale a pena. Para "desligar" uma funcionalidade, pare de gravar o valor no código.
