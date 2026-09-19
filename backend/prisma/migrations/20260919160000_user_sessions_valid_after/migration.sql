-- Revogação de sessão (Órion A3/M1, 2026-09-19): `authenticate` passa a recusar JWT cujo
-- `iat` seja anterior a `User.sessionsValidAfter`, e a conferir `User.active`.
-- Migration só ADICIONA uma coluna NULLABLE sem default — sem reescrita de tabela, sem lock
-- relevante, mesmo formato de 20260919120000_user_google_sub. SQL idêntico ao de
-- `prisma migrate diff`.

ALTER TABLE "User" ADD COLUMN     "sessionsValidAfter" TIMESTAMPTZ(3);

-- Rollback (manual, Prisma não tem "down"):
-- ALTER TABLE "User" DROP COLUMN IF EXISTS "sessionsValidAfter";
