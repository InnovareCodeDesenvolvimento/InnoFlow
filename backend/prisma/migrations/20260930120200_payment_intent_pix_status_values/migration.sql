-- ============================================================
-- F5.2 (Cronos, 2026-09-30): dois valores novos de enum, ISOLADOS numa
-- migration própria — mesma regra de 20260930120000_payment_gateway_enum_values.
-- ============================================================
-- Ver .claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md, seção 3
-- (fluxo Pix: CREATED -> PENDING -> PAID/EXPIRED/FAILED) e
-- .claude/agent-memory/cronos/tecnica-migration-sem-banco-vivo.md para o
-- motivo da separação: `prisma migrate deploy` roda cada arquivo de
-- migration inteiro numa única transação, e o Postgres proíbe usar um
-- valor de enum recém-adicionado por `ALTER TYPE ... ADD VALUE` dentro da
-- MESMA transação em que foi criado (nem em CHECK, nem em índice parcial
-- `WHERE`, nem em INSERT/UPDATE). Por isso este arquivo contém SÓ os dois
-- ADD VALUE — nenhum CHECK, índice ou uso do valor novo aqui; isso fica
-- para uma migration seguinte, quando o Vega precisar. Só ADICIONA (nenhum
-- DROP) — sem downtime, sem rollback com perda de dado possível a não ser
-- recriar o enum inteiro (não vale a pena).

-- PaymentIntentStatus: estados do fluxo Pix (WALLET_TOPUP_PIX). O fluxo de
-- cartão (SESSION_CARD_CAPTURE) continua usando os estados que já existem
-- (AUTHORIZED/CAPTURE_PENDING/CAPTURED/VOIDED) — PENDING/PAID são
-- exclusivos do Pix.
ALTER TYPE "PaymentIntentStatus" ADD VALUE 'PENDING';
ALTER TYPE "PaymentIntentStatus" ADD VALUE 'PAID';

-- ============================================================
-- Rollback (manual, Prisma não tem "down"; Postgres não tem
-- "ALTER TYPE ... DROP VALUE" — reverter de verdade exige recriar o tipo
-- inteiro sem o(s) valor(es), o que só é seguro se NENHUMA linha usa o
-- valor novo. Documentado, não executado automaticamente):
-- ============================================================
-- (não há statement de reversão seguro e barato para ADD VALUE de enum)
