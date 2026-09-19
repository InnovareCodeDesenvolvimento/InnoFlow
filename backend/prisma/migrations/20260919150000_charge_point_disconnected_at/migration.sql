-- "Eletropostos perto de mim" (mapa do PWA): o offline de um carregador que
-- CAI precisa aparecer na hora, não 5 min depois. `disconnectedAt` guarda o
-- instante do close do WebSocket; a regra de "online" (única, em
-- core/estacoes/disponibilidade.ts) trata `disconnectedAt >= lastSeenAt` como
-- offline. NÃO reescreve `lastSeenAt` (fato histórico) nem `Connector.status`.
--
-- Migration só ADICIONA uma coluna NULLABLE sem default — sem reescrita de
-- tabela, sem lock relevante, mesmo formato da 20260919120000_user_google_sub.
-- O SQL abaixo é exatamente o que `prisma migrate diff` gera do schema.

ALTER TABLE "ChargePoint" ADD COLUMN     "disconnectedAt" TIMESTAMPTZ(3);

-- Rollback (manual, Prisma não tem "down"):
-- ALTER TABLE "ChargePoint" DROP COLUMN IF EXISTS "disconnectedAt";
