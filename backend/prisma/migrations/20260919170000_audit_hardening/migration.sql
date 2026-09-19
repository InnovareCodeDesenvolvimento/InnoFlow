-- ============================================================
-- Endurecimento do log de auditoria e do razão da carteira (Órion A4 + M4 parcial, 2026-09-19)
-- ============================================================
-- Só ADICIONA constraints/triggers — nenhum DROP/ALTER destrutivo, nenhuma reescrita de tabela.
--
-- 1) TETO DE TAMANHO (A4). `AuditLog` é imutável por 24 meses (trigger append-only): um campo sem
--    teto (User-Agent e URL chegam a ~16 KB) deixa um atacante encher o disco PARA SEMPRE. A
--    aplicação já trunca (`core/auditoria/limitesDeCampos.ts`); o CHECK abaixo é a rede de
--    segurança — um caminho que esqueça de truncar falha ALTO em vez de gravar lixo.
--    `NOT VALID` de propósito: a constraint vale para linhas NOVAS, e o `VALIDATE` (que varre a
--    tabela e FALHARIA se já houver linha longa em produção) fica de fora — a tabela é append-only,
--    então não dá para "consertar" linha antiga com UPDATE. Assim esta migration nunca falha por
--    causa de dado existente (falha de migration no boot = deploy fora do ar).
--    (NULL passa em CHECK: `NULL <= n` é NULL.)
ALTER TABLE "AuditLog" ADD CONSTRAINT "audit_log_path_max_len" CHECK (char_length("path") <= 255) NOT VALID;
ALTER TABLE "AuditLog" ADD CONSTRAINT "audit_log_user_agent_max_len" CHECK (char_length("userAgent") <= 512) NOT VALID;
ALTER TABLE "AuditLog" ADD CONSTRAINT "audit_log_entity_id_max_len" CHECK (char_length("entityId") <= 128) NOT VALID;

-- 2) TRUNCATE (M4 parcial). Os triggers de UPDATE/DELETE de `AuditLog` e `WalletEntry` são
--    `FOR EACH ROW`, e o Postgres NÃO dispara trigger de linha em TRUNCATE: quem tem o privilégio
--    (o dono — e em produção a aplicação conecta como dono) esvaziava o log de auditoria e o
--    razão da carteira inteiros, sem erro nenhum. Trigger `BEFORE TRUNCATE ... FOR EACH STATEMENT`
--    que levanta exceção.
--    Caveat honesto (o mesmo dos triggers de linha): trigger não segura dono/superuser — quem pode
--    `DROP TRIGGER` desliga isto. Fechar de verdade exige duas roles de banco (migração vs.
--    aplicação sem TRUNCATE/ALTER/DROP) — decisão de infraestrutura (mexe na DATABASE_URL de
--    produção), fora desta migration.
CREATE OR REPLACE FUNCTION forbid_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% é append-only — TRUNCATE não é permitido', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE TRIGGER wallet_entry_no_truncate
  BEFORE TRUNCATE ON "WalletEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

-- ============================================================
-- Rollback (manual, Prisma não tem "down"):
-- ============================================================
-- DROP TRIGGER IF EXISTS "wallet_entry_no_truncate" ON "WalletEntry";
-- DROP TRIGGER IF EXISTS "audit_log_no_truncate" ON "AuditLog";
-- DROP FUNCTION IF EXISTS forbid_truncate();
-- ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "audit_log_entity_id_max_len";
-- ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "audit_log_user_agent_max_len";
-- ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "audit_log_path_max_len";
-- (opcional, quando tiver certeza de que não há linha longa:)
-- ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "audit_log_path_max_len"; -- etc.
