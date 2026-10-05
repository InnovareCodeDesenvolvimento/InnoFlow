-- N-11 (auditoria pré-produção): manutenção das partições mensais de `MeterSample` (por `ts`) e `OcppMessage` (por `occurredAt`).
--
-- PROBLEMA. A migration inicial criou só 2026-09..2027-02 + a partição DEFAULT. Passado 2027-02 o INSERT NÃO falha (a DEFAULT
-- aceita), mas é pior do que parece: (1) as linhas novas se acumulam na DEFAULT (sem a poda por partição); (2) criar depois a
-- partição de um mês cujas linhas já estão na DEFAULT FALHA ("updated partition constraint for default partition would be
-- violated by some row") até alguém mover essas linhas à mão.
--
-- `ensure_partitions_ahead(tabela, meses, a_partir_de)` resolve as duas coisas e é a MESMA função usada por esta migration e pelo
-- job do worker (`services/manutencao/particoes.ts`) — um único lugar com o DDL:
--
--  * IDEMPOTENTE: só cria o que falta (nada a fazer => devolve 0 linhas).
--  * CONTÍGUA E À PROVA DE FUSO: cada partição nova começa EXATAMENTE onde a última existente termina (lido de `pg_get_expr`),
--    nunca de um "dia 1" recalculado. Motivo medido: as bordas da migration inicial dependem do `TimeZone` da sessão que a rodou
--    (num Postgres em America/Cayenne ficaram `... 00:00:00-03`; em UTC ficam `+00`). Recalcular a borda em UTC sobre um banco assim
--    gera sobreposição de 3 h e o CREATE falha.
--  * MOVE as linhas da DEFAULT que cairiam no novo intervalo (DELETE ... RETURNING + INSERT numa tabela avulsa) ANTES de anexar.
--  * `CREATE TABLE (LIKE pai INCLUDING ALL)` + `ATTACH PARTITION`, não `CREATE TABLE ... PARTITION OF`: o ATTACH pede só SHARE
--    UPDATE EXCLUSIVE no pai (não conflita com INSERT/UPDATE em curso); o CREATE ... PARTITION OF pede ACCESS EXCLUSIVE no pai e
--    pararia a ingestão do OCPP enquanto espera um lock. Índices equivalentes da avulsa são adotados no ATTACH; triggers
--    (`set_*_operator_id`) e FKs são clonados do pai pelo próprio Postgres.
--  * Lock consultivo de transação: duas execuções concorrentes (migration + worker, ou 2 réplicas do worker) se serializam.
--
-- `as_of` existe para o teste simular o futuro (default: now()). Em produção ninguém passa.
--
-- A função antiga `ensure_monthly_partition(tabela, mês)` da migration inicial continua aí, inalterada (nada mais a chama).

CREATE OR REPLACE FUNCTION ensure_partitions_ahead(
  parent_table text,
  months_ahead integer,
  as_of timestamptz DEFAULT now()
) RETURNS TABLE (partition_name text, rows_moved bigint) AS $$
DECLARE
  parent       regclass;
  default_part regclass;
  key_col      text;
  col_list     text;
  last_hi      timestamptz;
  lo           timestamptz;
  hi           timestamptz;
  target       timestamptz;
  pname        text;
  moved        bigint;
BEGIN
  IF months_ahead IS NULL OR months_ahead < 0 OR months_ahead > 120 THEN
    RAISE EXCEPTION 'ensure_partitions_ahead: months_ahead fora de 0..120 (%)', months_ahead;
  END IF;

  parent := to_regclass(quote_ident(parent_table));
  IF parent IS NULL THEN
    RAISE EXCEPTION 'ensure_partitions_ahead: tabela % não existe', parent_table;
  END IF;

  -- Mesma chave que o job TS usa em pg_try_advisory_xact_lock (re-entrante na mesma sessão).
  PERFORM pg_advisory_xact_lock(hashtext('innoelektron:manutencao-particoes'));

  SELECT a.attname INTO key_col
    FROM pg_partitioned_table pt
    JOIN pg_attribute a ON a.attrelid = pt.partrelid AND a.attnum = pt.partattrs[0]
   WHERE pt.partrelid = parent AND pt.partstrat = 'r';
  IF key_col IS NULL THEN
    RAISE EXCEPTION 'ensure_partitions_ahead: % não é particionada por RANGE', parent_table;
  END IF;

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO col_list
    FROM pg_attribute
   WHERE attrelid = parent AND attnum > 0 AND NOT attisdropped;

  SELECT c.oid INTO default_part
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
   WHERE i.inhparent = parent AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT';

  -- Fim (exclusivo) da última partição explícita. Sem nenhuma: começa no 1º dia do mês corrente em UTC.
  SELECT max((regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz) INTO last_hi
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
   WHERE i.inhparent = parent AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT';
  IF last_hi IS NULL THEN
    last_hi := date_trunc('month', as_of AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  END IF;

  target := as_of + make_interval(months => months_ahead);

  WHILE last_hi < target LOOP
    lo := last_hi;
    -- +1 mês em calendário UTC (não no TimeZone da sessão: a partir de uma borda 'dia 1 00:00 UTC' a aritmética em America/Cayenne driftaria para o dia 30).
    hi := ((lo AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
    -- Rótulo AAAA_MM = mês em que a borda cai em UTC depois de +14 h (as bordas são "dia 1 00:00" num fuso de -12..+14 h; +14 h
    -- sempre aterrissa no mesmo mês). Mantém os nomes da migration inicial (`MeterSample_2026_09`) em qualquer fuso do banco.
    pname := parent_table || '_' || to_char((lo + interval '14 hours') AT TIME ZONE 'UTC', 'YYYY_MM');
    IF to_regclass(quote_ident(pname)) IS NOT NULL THEN
      RAISE EXCEPTION 'ensure_partitions_ahead: % já existe e não é a partição contígua esperada de %', pname, parent_table;
    END IF;

    EXECUTE format('CREATE TABLE %I (LIKE %s INCLUDING ALL)', pname, parent);

    moved := 0;
    IF default_part IS NOT NULL THEN
      EXECUTE format(
        'WITH m AS (DELETE FROM %s WHERE %I >= %L AND %I < %L RETURNING *) INSERT INTO %I (%s) SELECT %s FROM m',
        default_part, key_col, lo, key_col, hi, pname, col_list, col_list
      );
      GET DIAGNOSTICS moved = ROW_COUNT;
    END IF;

    EXECUTE format('ALTER TABLE %s ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', parent, pname, lo, hi);

    partition_name := pname;
    rows_moved := moved;
    RETURN NEXT;
    last_hi := hi;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Partições até pelo menos 12 meses à frente (hoje 2026-10-05 => até 2027-10). Idempotente.
SELECT * FROM ensure_partitions_ahead('MeterSample', 12);
SELECT * FROM ensure_partitions_ahead('OcppMessage', 12);

-- ============================================================
-- Rollback (não executado automaticamente — Prisma Migrate não tem "down"):
-- ============================================================
-- As partições criadas aqui são vazias e inofensivas; só remova se quiser desfazer de verdade. Para cada partição de 2027-03 em
-- diante E SOMENTE se vazia (confira com SELECT count(*)):
--   ALTER TABLE "MeterSample" DETACH PARTITION "MeterSample_2027_03"; DROP TABLE "MeterSample_2027_03";
--   (idem "OcppMessage_2027_03" ... e os meses seguintes)
-- DROP FUNCTION IF EXISTS ensure_partitions_ahead(text, integer, timestamptz);
-- DELETE FROM "_prisma_migrations" WHERE migration_name = '20261005120000_partition_maintenance';
