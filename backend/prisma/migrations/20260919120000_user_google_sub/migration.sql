-- Login/cadastro com Google (motorista): guarda o `sub` estável do Google.
-- Migration só ADICIONA (coluna nullable + índice único) — sem reescrita de
-- tabela, sem lock relevante (User é pequena), rollback trivial no fim.

ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- Rollback (manual, Prisma não tem "down"):
-- DROP INDEX IF EXISTS "User_googleSub_key";
-- ALTER TABLE "User" DROP COLUMN IF EXISTS "googleSub";
