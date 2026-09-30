-- ============================================================
-- F5.1 (Cronos, 2026-09-30): valores novos de enum, ISOLADOS numa migration
-- própria e ANTES de qualquer coisa que os use.
-- ============================================================
-- Ver .claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md para o
-- desenho completo (D1 do dono: cartão salvo/SAQ A-EP, aprovado 2026-09-30).
--
-- Por que este arquivo existe separado do resto da F5.1: `prisma migrate
-- deploy` envolve CADA ARQUIVO de migration inteiro em UMA transação (já
-- documentado e testado em produção real nesta mesma base — ver comentário
-- em 20260916150000_retaguarda_indices_live_panel/migration.sql). O
-- Postgres proíbe usar um valor de enum recém-adicionado por
-- `ALTER TYPE ... ADD VALUE` dentro da MESMA transação em que foi criado —
-- nem em CHECK, nem em índice parcial `WHERE`, nem em INSERT/UPDATE. A
-- migration seguinte (20260930120100_payment_gateway_foundation) cria um
-- índice parcial `WHERE type = 'DEBT_SETTLEMENT'`; se isso estivesse no
-- mesmo arquivo deste ADD VALUE, a migration inteira falharia com
-- "unsafe use of new value of enum type" — erro só visível rodando contra
-- Postgres real, nenhuma das validações estáticas (prisma validate/migrate
-- diff --from-empty) pega isso, porque nenhuma das duas executa DDL de
-- verdade. Só ADICIONA (nenhum DROP) — sem downtime, sem rollback com perda
-- de dado possível a não ser recriar o enum inteiro (não vale a pena).

-- WalletEntryType: quitação automática de Debt pelo crédito de Pix (F5,
-- decisão §5 da Nova) — usado pelo índice único parcial
-- ux_wallet_entry_debt_settlement_once na próxima migration.
ALTER TYPE "WalletEntryType" ADD VALUE 'DEBT_SETTLEMENT';

-- AuditAction: ações novas da F5 (crédito de Pix pelo worker; ADMIN
-- alterando PaymentGatewayConfig). Não são usadas em nenhum CHECK/índice
-- desta migration nem da próxima — só a app grava linhas com esses valores
-- depois. Separadas aqui de qualquer forma, por precaução (mesma regra do
-- Postgres vale para qualquer uso futuro, e não custa nada manter as duas
-- ALTER TYPE juntas nesta migration "só enum").
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_CREDIT';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_CONFIG_CHANGE';

-- ============================================================
-- Rollback (manual, Prisma não tem "down"; Postgres não tem
-- "ALTER TYPE ... DROP VALUE" — reverter de verdade exige recriar o tipo
-- inteiro sem o(s) valor(es), o que só é seguro se NENHUMA linha usa o
-- valor novo. Documentado, não executado automaticamente):
-- ============================================================
-- (não há statement de reversão seguro e barato para ADD VALUE de enum)
