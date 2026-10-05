import { Prisma, type PrismaClient } from '@prisma/client'
import { logger } from '../../lib/logger'

/**
 * Manutenção das partições mensais de `MeterSample` (por `ts`) e `OcppMessage` (por `occurredAt`) — N-11 (auditoria pré-produção).
 *
 * O DDL mora numa função SQL só (`ensure_partitions_ahead`, migration `20261005120000_partition_maintenance`), a MESMA que a migration
 * chamou para criar 12 meses à frente. Aqui ficam o agendamento seguro (lock consultivo + `lock_timeout`), a leitura do catálogo e os
 * alertas. Por que não basta "confiar na DEFAULT": passado o último mês criado o INSERT não falha, mas as linhas se acumulam na DEFAULT
 * e, quando alguém criar o mês, o `CREATE` falha enquanto houver linhas dele lá — a função SQL move essas linhas antes de anexar.
 */

export const TABELAS_PARTICIONADAS = ['MeterSample', 'OcppMessage'] as const
export type TabelaParticionada = (typeof TABELAS_PARTICIONADAS)[number]

/** Coluna da chave de partição de cada tabela (a mesma de `PARTITION BY RANGE` na migration inicial). */
export const COLUNA_PARTICAO: Record<TabelaParticionada, string> = { MeterSample: 'ts', OcppMessage: 'occurredAt' }

/** Mesma chave usada dentro de `ensure_partitions_ahead` (re-entrante na mesma sessão): criação e retenção nunca rodam juntas. */
export const CHAVE_LOCK_MANUTENCAO = 'innoelektron:manutencao-particoes'

/** Alerta `partition_horizon_low` quando a última partição criada termina antes de agora + isto (em meses). */
export const HORIZONTE_MINIMO_MESES = 2

/** Quanto esperar por um lock de tabela antes de desistir (a rodada seguinte tenta de novo). Nunca fila atrás de uma transação longa. */
export const LOCK_TIMEOUT_MS = 10_000

type Db = PrismaClient | Prisma.TransactionClient

export interface ParticaoInfo {
  nome: string
  inicio: Date
  fim: Date
  /** `pg_class.reltuples` — estimativa (pode ser -1/0 se a tabela nunca passou por ANALYZE). Só para log. */
  linhasEstimadas: number
  bytes: number
}

export interface InfoDefault {
  nome: string | null
  linhas: number
  minimo: Date | null
  maximo: Date | null
}

export interface RelatorioParticoes {
  tabela: TabelaParticionada
  /** true = outra execução segurava o lock consultivo; nada foi feito. */
  pulou: boolean
  criadas: { particao: string; linhasMovidasDaDefault: number }[]
  /** Fim (exclusivo) da última partição explícita, ou null se não há nenhuma. */
  horizonteAte: Date | null
  linhasNaDefault: number
  erro?: string
}

export function adicionarMesesUtc(data: Date, meses: number): Date {
  const d = new Date(data.getTime())
  d.setUTCMonth(d.getUTCMonth() + meses)
  return d
}

function nomeSeguro(nome: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(nome)) throw new Error(`nome de relação inesperado: ${nome}`)
  return nome
}

export function referenciaTabela(nome: string): Prisma.Sql {
  return Prisma.raw(`"${nomeSeguro(nome)}"`)
}

/**
 * Partições EXPLÍCITAS (sem a DEFAULT) em ordem cronológica. As bordas são lidas do catálogo (`pg_get_expr`), nunca recalculadas.
 * ATENÇÃO (medido): `pg_get_expr(relpartbound, oid)` pede AccessShareLock na partição — atrás de um LOCK exclusivo alheio ele ESPERA. Quem chama
 * numa situação de lock deve usar uma transação com `lock_timeout` (ou `horizonteAproximadoPorNome`, que não trava).
 * `tamanho: false` pula `pg_total_relation_size` (que pega AccessShareLock nas partições e esperaria atrás de um lock exclusivo alheio); a retenção usa `true` só para o log. */
export async function listarParticoes(db: Db, tabela: TabelaParticionada, opts: { tamanho?: boolean } = {}): Promise<ParticaoInfo[]> {
  const colunaBytes = (opts.tamanho ?? true) ? Prisma.sql`pg_total_relation_size(c.oid)::float8` : Prisma.sql`0::float8`
  const linhas = await db.$queryRaw<{ nome: string; inicio: Date; fim: Date; linhasEstimadas: number; bytes: number }[]>(Prisma.sql`
    SELECT c.relname::text AS "nome",
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \\(''([^'']+)''\\)'))[1]::timestamptz AS "inicio",
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([^'']+)''\\)'))[1]::timestamptz AS "fim",
           c.reltuples::float8 AS "linhasEstimadas",
           ${colunaBytes} AS "bytes"
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = to_regclass(quote_ident(${tabela}))
       AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
     ORDER BY 2
  `)
  return linhas.map((l) => ({ nome: l.nome, inicio: l.inicio, fim: l.fim, linhasEstimadas: Number(l.linhasEstimadas), bytes: Number(l.bytes) }))
}

/** Horizonte (fim exclusivo da última partição) deduzido só dos NOMES `Tabela_AAAA_MM` — aproximação SEM lock, para alertar mesmo quando as bordas (`pg_get_expr`) estão inacessíveis. */
export async function horizonteAproximadoPorNome(db: Db, tabela: TabelaParticionada): Promise<Date | null> {
  const linhas = await db.$queryRaw<{ nome: string }[]>(Prisma.sql`
    SELECT c.relname::text AS "nome" FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = to_regclass(quote_ident(${tabela})) AND c.relname ~ '^[A-Za-z]+_[0-9]{4}_[0-9]{2}$'
  `)
  let melhor: Date | null = null
  for (const { nome } of linhas) {
    const m = /_(\d{4})_(\d{2})$/.exec(nome)
    if (!m) continue
    const fim = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)) // mês seguinte ao do rótulo (mês 1-based => índice Number(m[2]) já é o próximo)
    if (melhor === null || fim.getTime() > melhor.getTime()) melhor = fim
  }
  return melhor
}

/** A partição DEFAULT existe? Quantas linhas tem (deveria ser 0) e de que intervalo de tempo. */
export async function inspecionarDefault(db: Db, tabela: TabelaParticionada): Promise<InfoDefault> {
  const achada = await db.$queryRaw<{ nome: string }[]>(Prisma.sql`
    SELECT c.relname::text AS "nome"
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = to_regclass(quote_ident(${tabela})) AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
  `)
  if (achada.length === 0) return { nome: null, linhas: 0, minimo: null, maximo: null }
  const nome = achada[0].nome
  const coluna = Prisma.raw(`"${COLUNA_PARTICAO[tabela]}"`)
  const [r] = await db.$queryRaw<{ n: number; minimo: Date | null; maximo: Date | null }[]>(
    Prisma.sql`SELECT count(*)::float8 AS "n", min(${coluna}) AS "minimo", max(${coluna}) AS "maximo" FROM ${referenciaTabela(nome)}`,
  )
  return { nome, linhas: Number(r.n), minimo: r.minimo, maximo: r.maximo }
}

/** `SET LOCAL lock_timeout` — parametrizável (SET puro não aceita parâmetro). */
export async function definirLockTimeout(tx: Prisma.TransactionClient, ms: number): Promise<void> {
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${Math.trunc(ms)}ms`}, true)`
}

/** Tenta o lock consultivo da manutenção (de transação). false = outra execução está rodando. */
export async function tentarLockManutencao(tx: Prisma.TransactionClient): Promise<boolean> {
  const [r] = await tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext(${CHAVE_LOCK_MANUTENCAO})) AS "ok"`)
  return r.ok === true
}

export function ehErroDeLockTimeout(err: unknown): boolean {
  const texto = err instanceof Error ? `${err.message} ${JSON.stringify((err as { meta?: unknown }).meta ?? '')}` : String(err)
  return /55P03|lock timeout|canceling statement due to lock/i.test(texto)
}

/** Dispara os alertas de saúde das partições de uma tabela (horizonte curto, linhas na DEFAULT). */
export function alertarSaudeParticoes(tabela: TabelaParticionada, horizonteAte: Date | null, padrao: InfoDefault, agora: Date): void {
  const limite = adicionarMesesUtc(agora, HORIZONTE_MINIMO_MESES)
  if (horizonteAte === null || horizonteAte.getTime() < limite.getTime()) {
    logger.warn(
      { alert: 'partition_horizon_low', tabela, horizonteAte: horizonteAte?.toISOString() ?? null, minimoMeses: HORIZONTE_MINIMO_MESES },
      `[manutencao] ALERTA: partições de ${tabela} cobrem menos de ${HORIZONTE_MINIMO_MESES} meses à frente — risco de linhas caírem na partição DEFAULT`,
    )
  }
  if (padrao.linhas > 0) {
    logger.warn(
      { alert: 'partition_default_has_rows', tabela, particao: padrao.nome, linhas: padrao.linhas, de: padrao.minimo?.toISOString() ?? null, ate: padrao.maximo?.toISOString() ?? null },
      `[manutencao] ALERTA: ${padrao.linhas} linha(s) na partição DEFAULT de ${tabela} — mês sem partição (ou linha com relógio fora do intervalo). Rode a manutenção para mover as que couberem.`,
    )
  }
}

/**
 * Garante partições até `mesesAFrente` meses à frente em cada tabela particionada. Uma transação por tabela (o ATTACH e o lock de
 * uma não seguram a outra); idempotente; lock consultivo para não rodar em duplicidade; alerta se o horizonte ficar curto ou houver
 * linhas na DEFAULT — inclusive quando a criação FALHA (é justamente aí que o alerta mais importa).
 */
export async function garantirParticoesFuturas(db: PrismaClient, opts: { mesesAFrente: number; agora?: Date; lockTimeoutMs?: number }): Promise<RelatorioParticoes[]> {
  const agora = opts.agora ?? new Date()
  const relatorios: RelatorioParticoes[] = []

  for (const tabela of TABELAS_PARTICIONADAS) {
    const base: RelatorioParticoes = { tabela, pulou: false, criadas: [], horizonteAte: null, linhasNaDefault: 0 }
    try {
      const resultado = await db.$transaction(
        async (tx) => {
          await definirLockTimeout(tx, opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS)
          if (!(await tentarLockManutencao(tx))) return null
          const criadas = await tx.$queryRaw<{ partition_name: string; rows_moved: bigint }[]>(
            Prisma.sql`SELECT partition_name, rows_moved FROM ensure_partitions_ahead(${tabela}, ${opts.mesesAFrente}::int, ${agora}::timestamptz)`,
          )
          const particoes = await listarParticoes(tx, tabela, { tamanho: false })
          const padrao = await inspecionarDefault(tx, tabela)
          return { criadas, particoes, padrao }
        },
        { timeout: 120_000, maxWait: 15_000 },
      )

      if (resultado === null) {
        logger.info({ event: 'partition_maintenance_skipped', tabela }, `[manutencao] ${tabela}: outra execução segura o lock da manutenção — nada feito`)
        relatorios.push({ ...base, pulou: true })
        continue
      }

      const horizonteAte = resultado.particoes.length > 0 ? resultado.particoes[resultado.particoes.length - 1].fim : null
      for (const c of resultado.criadas) {
        logger.info(
          { event: 'partition_created', tabela, particao: c.partition_name, linhasMovidasDaDefault: Number(c.rows_moved) },
          `[manutencao] partição ${c.partition_name} criada${Number(c.rows_moved) > 0 ? ` (${Number(c.rows_moved)} linha(s) movida(s) da DEFAULT)` : ''}`,
        )
      }
      logger.info(
        { event: 'partition_horizon', tabela, horizonteAte: horizonteAte?.toISOString() ?? null, criadas: resultado.criadas.length, particoes: resultado.particoes.length },
        `[manutencao] ${tabela}: ${resultado.particoes.length} partição(ões), horizonte até ${horizonteAte?.toISOString() ?? 'n/d'}, ${resultado.criadas.length} criada(s) nesta rodada`,
      )
      alertarSaudeParticoes(tabela, horizonteAte, resultado.padrao, agora)
      relatorios.push({
        ...base,
        criadas: resultado.criadas.map((c) => ({ particao: c.partition_name, linhasMovidasDaDefault: Number(c.rows_moved) })),
        horizonteAte,
        linhasNaDefault: resultado.padrao.linhas,
      })
    } catch (err) {
      const lockTimeout = ehErroDeLockTimeout(err)
      logger.error(
        { err, tabela, alert: lockTimeout ? 'partition_maintenance_lock_timeout' : 'partition_maintenance_failed' },
        lockTimeout
          ? `[manutencao] ${tabela}: lock indisponível dentro de ${opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS} ms — a próxima rodada tenta de novo`
          : `[manutencao] ${tabela}: falha ao garantir partições futuras`,
      )
      // Mesmo falhando, avalia a saúde com o que o catálogo mostra agora: o horizonte curto é o alerta que não pode ficar mudo.
      let horizonteAte: Date | null = null
      let linhasNaDefault = 0
      try {
        // Só o catálogo (sem lock de tabela): o horizonte curto é o alerta que NÃO pode ficar mudo quando a criação falha.
        horizonteAte = await horizonteAproximadoPorNome(db, tabela)
        let padrao: InfoDefault = { nome: null, linhas: 0, minimo: null, maximo: null }
        try {
          // Contar a DEFAULT precisa de lock de leitura: com timeout curto, para não esperar atrás da mesma transação que travou a criação.
          padrao = await db.$transaction(async (tx) => {
            await definirLockTimeout(tx, 2_000)
            return inspecionarDefault(tx, tabela)
          })
        } catch {
          logger.warn({ tabela }, '[manutencao] não foi possível contar as linhas da DEFAULT (lock indisponível) — alerta de DEFAULT fica para a próxima rodada')
        }
        linhasNaDefault = padrao.linhas
        alertarSaudeParticoes(tabela, horizonteAte, padrao, agora)
      } catch (err2) {
        logger.error({ err: err2, tabela }, '[manutencao] não foi possível nem ler o estado das partições')
      }
      relatorios.push({ ...base, horizonteAte, linhasNaDefault, erro: err instanceof Error ? err.message : String(err) })
    }
  }
  return relatorios
}
