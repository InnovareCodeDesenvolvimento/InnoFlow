import { Prisma, type PrismaClient } from '@prisma/client'
import { logger } from '../../lib/logger'
import { SYSTEM_ACTOR } from '../../core/auditoria/systemActor'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import {
  definirLockTimeout,
  ehErroDeLockTimeout,
  listarParticoes,
  LOCK_TIMEOUT_MS,
  referenciaTabela,
  tentarLockManutencao,
  type ParticaoInfo,
  type TabelaParticionada,
} from './particoes'

/**
 * Retenção/purga de dados de volume (N-11). SEGURA POR PADRÃO: `RETENTION_ENABLED=false` => esta rotina não toca em NADA.
 *
 * O QUE PURGA (allowlist fixa abaixo — nada fora dela é tocável por esta rotina, por mais que a config diga):
 *  - `OcppMessage` e `MeterSample` (particionadas por mês): só por DETACH + DROP de partição INTEIRA cujo FIM (exclusivo) já passou do
 *    prazo (`fim <= agora - dias`). Nunca DELETE linha a linha, nunca a partição DEFAULT, nunca o mês corrente/futuro.
 *  - `WebhookEvent` (NÃO particionada, volume ínfimo — a conta Cielo é compartilhada e o InnoFlow não recebe webhook): DELETE em lotes
 *    de eventos JÁ PROCESSADOS mais velhos que o prazo.
 *  - `NotificationLog` (L1.6, DL6 — log das notificações por e-mail ao motorista, sem PII): DELETE em lotes das linhas com mais de 12 meses (por `createdAt`).
 *
 *  - `AuditLog` (decisão do dono, 05/10/2026: 24 MESES — a política de privacidade promete o expurgo automático por idade): DELETE em lotes das linhas
 *    com `occurredAt` mais antigo que o prazo. O trigger append-only NÃO foi alterado: ele já recusa UPDATE/TRUNCATE sempre e DELETE de linha mais nova que
 *    `now() - interval '24 months'` (ver `retencaoAuditLog`).
 *
 * O QUE NUNCA PURGA (por desenho, sem opção de configuração): `WalletEntry`, `PaymentIntent`, `Debt`, `ChargingSession` e o restante do financeiro.
 * `WalletEntry` tem trigger append-only (UPDATE/DELETE/TRUNCATE); a política e o procedimento manual estão em docs/DEPLOY-EASYPANEL.md ("Partições e retenção").
 *
 * PROTEÇÃO DE REFERÊNCIAS: antes de apagar uma partição, confere se alguma sessão que se sobrepõe àquele mês (com margem de 2 dias para
 * relógio de carregador) ainda precisa do log/leituras: sessão ABERTA (não STOPPED — a reconciliação usa `MeterSample` e o
 * StopTransaction do `OcppMessage`), com `Debt` OPEN, ou com `PaymentIntent` em andamento (CREATED, AUTHORIZED,
 * CAPTURE_PENDING, PENDING). Chargeback NÃO protege: ao registrar a disputa o sistema tira um snapshot do dossiê (L1.8), que não depende destas tabelas depois de salvo — decisão do dono, DL6. Achou? NÃO apaga e alerta
 * (`retention_partition_blocked`). A mesma checagem roda de novo DENTRO da transação do DROP.
 */

export interface ConfigRetencao {
  habilitada: boolean
  dryRun: boolean
  ocppMessageDias: number
  meterSampleDias: number
  webhookEventDias: number
  /** L1.6/DL6: prazo do `NotificationLog` (12 meses por padrão). Ausente = 365. */
  notificationLogDias?: number
  /** Prazo do `AuditLog` (24 meses por padrão). Ausente = 730. NUNCA vale menos que {@link DIAS_MINIMOS_AUDIT_LOG}: o trigger do banco recusa o resto. */
  auditLogDias?: number
  /** Teto de lotes (de 1000 linhas) do AuditLog por rodada. Ausente = 200 (200 mil linhas). Existe para o teste provar o teto sem inserir 200 mil linhas; não há env para isto. */
  auditLogMaxLotes?: number
}

/** Piso duro em código (o env também valida): ninguém "limpa tudo" por engano com um 0 ou 1 digitado errado. */
export const DIAS_MINIMOS_RETENCAO = 30
const MARGEM_SESSAO_MS = 2 * 24 * 3_600_000
const LOTE_WEBHOOK = 1000
const MAX_LOTES_WEBHOOK_POR_RODADA = 200
const LOTE_NOTIFICATION_LOG = 1000
const MAX_LOTES_NOTIFICATION_LOG_POR_RODADA = 200
export const NOTIFICATION_LOG_DIAS_PADRAO = 365
const LOTE_AUDIT_LOG = 1000
const MAX_LOTES_AUDIT_LOG_POR_RODADA = 200
/** 24 meses em dias (2 x 365). O trigger usa `interval '24 months'` (calendário: 730 ou 731 dias, conforme caia um 29/02 na janela) — o piso em dias é o MENOR dos dois e a consulta ainda se limita ao corte do banco (ver `retencaoAuditLog`). */
export const DIAS_MINIMOS_AUDIT_LOG = 730
export const AUDIT_LOG_DIAS_PADRAO = 730

const REGEX_PARTICAO: Record<TabelaParticionada, RegExp> = {
  MeterSample: /^MeterSample_\d{4}_\d{2}$/,
  OcppMessage: /^OcppMessage_\d{4}_\d{2}$/,
}

export interface AcaoRetencao {
  tabela: string
  acao: 'partition_dropped' | 'dry_run_partition' | 'partition_blocked' | 'partition_skipped' | 'webhook_deleted' | 'dry_run_webhook' | 'notification_log_deleted' | 'dry_run_notification_log' | 'audit_log_deleted' | 'dry_run_audit_log' | 'audit_log_skipped'
  particao?: string
  linhas?: number
  motivo?: string
}

export interface RelatorioRetencao {
  habilitada: boolean
  dryRun: boolean
  acoes: AcaoRetencao[]
  erros: string[]
}

type Tx = Prisma.TransactionClient
type Db = PrismaClient | Tx

function clamp(dias: number): number {
  return Math.max(DIAS_MINIMOS_RETENCAO, Math.trunc(dias))
}

/** Prazo efetivo do AuditLog: nunca abaixo de 730 dias; valor ausente/inválido (NaN, Infinity) cai no padrão — nunca em "0 dias". */
export function prazoAuditLogEfetivo(dias: number | undefined): number {
  if (dias === undefined || !Number.isFinite(dias)) return AUDIT_LOG_DIAS_PADRAO
  return Math.max(DIAS_MINIMOS_AUDIT_LOG, Math.trunc(dias))
}

interface SessaoProtegida {
  id: string
  status: string
}

/** Sessões que ainda dependem do log/leituras do intervalo da partição (ver o comentário do módulo). */
export async function buscarSessoesProtegidas(db: Db, particao: Pick<ParticaoInfo, 'inicio' | 'fim'>, agora: Date): Promise<SessaoProtegida[]> {
  const ate = new Date(particao.fim.getTime() + MARGEM_SESSAO_MS)
  const desde = new Date(particao.inicio.getTime() - MARGEM_SESSAO_MS)
  return db.$queryRaw<SessaoProtegida[]>(Prisma.sql`
    SELECT cs.id, cs.status::text AS "status"
      FROM "ChargingSession" cs
     WHERE cs."startedAt" < ${ate}
       AND COALESCE(cs."stoppedAt", CASE WHEN cs.status = 'STOPPED' THEN cs."startedAt" ELSE ${agora}::timestamptz END) >= ${desde}
       AND (
         cs.status <> 'STOPPED'
         OR EXISTS (SELECT 1 FROM "Debt" d WHERE d."chargingSessionId" = cs.id AND d.status = 'OPEN')
         OR EXISTS (
           SELECT 1 FROM "PaymentIntent" pi
            WHERE pi."chargingSessionId" = cs.id
              AND (pi.status IN ('CREATED', 'AUTHORIZED', 'CAPTURE_PENDING', 'PENDING'))
         )
       )
     LIMIT 5
  `)
}

async function retencaoParticionada(db: PrismaClient, tabela: TabelaParticionada, diasBrutos: number, cfg: ConfigRetencao, agora: Date, relatorio: RelatorioRetencao): Promise<void> {
  const dias = clamp(diasBrutos)
  const corte = new Date(agora.getTime() - dias * 86_400_000)
  // Com lock_timeout: ler as bordas pede AccessShareLock nas partições e esperaria sem fim atrás de um lock exclusivo alheio.
  const todas = await db.$transaction(async (tx) => {
    await definirLockTimeout(tx, LOCK_TIMEOUT_MS)
    return listarParticoes(tx, tabela)
  })
  const elegiveis = todas.filter((p) => p.fim.getTime() <= corte.getTime())
  logger.info(
    { event: 'retention_scan', tabela, dias, corte: corte.toISOString(), particoes: todas.length, elegiveis: elegiveis.length, dryRun: cfg.dryRun },
    `[retencao] ${tabela}: ${elegiveis.length} de ${todas.length} partição(ões) além do prazo de ${dias} dias${cfg.dryRun ? ' (DRY-RUN: nada será apagado)' : ''}`,
  )

  for (const p of elegiveis) {
    if (!REGEX_PARTICAO[tabela].test(p.nome)) {
      logger.warn({ event: 'retention_partition_skipped', tabela, particao: p.nome }, `[retencao] ${p.nome} não segue o padrão de nome esperado — ignorada`)
      relatorio.acoes.push({ tabela, acao: 'partition_skipped', particao: p.nome, motivo: 'nome fora do padrão' })
      continue
    }

    const protegidas = await buscarSessoesProtegidas(db, p, agora)
    if (protegidas.length > 0) {
      logger.warn(
        { alert: 'retention_partition_blocked', tabela, particao: p.nome, sessoes: protegidas.map((s) => ({ id: s.id, status: s.status })) },
        `[retencao] ALERTA: ${p.nome} NÃO foi apagada — há sessão aberta, dívida em aberto ou pagamento em andamento/estornado que depende dela (resolva a sessão e a próxima rodada apaga)`,
      )
      relatorio.acoes.push({ tabela, acao: 'partition_blocked', particao: p.nome, motivo: `${protegidas.length}+ sessão(ões) dependem` })
      continue
    }

    if (cfg.dryRun) {
      logger.info(
        { event: 'retention_dry_run', tabela, particao: p.nome, inicio: p.inicio.toISOString(), fim: p.fim.toISOString(), linhasEstimadas: p.linhasEstimadas, bytes: p.bytes },
        `[retencao] DRY-RUN: ${p.nome} seria removida (~${Math.max(0, Math.round(p.linhasEstimadas))} linhas, ${p.bytes} bytes)`,
      )
      relatorio.acoes.push({ tabela, acao: 'dry_run_partition', particao: p.nome, linhas: Math.max(0, Math.round(p.linhasEstimadas)) })
      continue
    }

    try {
      const apagada = await db.$transaction(
        async (tx) => {
          await definirLockTimeout(tx, LOCK_TIMEOUT_MS)
          if (!(await tentarLockManutencao(tx))) return 'sem_lock' as const
          // Revalida DENTRO da transação (uma sessão pode ter aberto/virado dívida entre a leitura e o DROP).
          const de_novo = (await listarParticoes(tx, tabela)).find((x) => x.nome === p.nome)
          if (!de_novo || de_novo.fim.getTime() > corte.getTime()) return 'mudou' as const
          if ((await buscarSessoesProtegidas(tx, de_novo, agora)).length > 0) return 'bloqueada' as const
          await tx.$executeRaw(Prisma.sql`ALTER TABLE ${referenciaTabela(tabela)} DETACH PARTITION ${referenciaTabela(p.nome)}`)
          await tx.$executeRaw(Prisma.sql`DROP TABLE ${referenciaTabela(p.nome)}`)
          return 'ok' as const
        },
        { timeout: 120_000, maxWait: 15_000 },
      )
      if (apagada === 'ok') {
        logger.info(
          { event: 'retention_partition_dropped', tabela, particao: p.nome, inicio: p.inicio.toISOString(), fim: p.fim.toISOString(), linhasEstimadas: p.linhasEstimadas, bytes: p.bytes },
          `[retencao] partição ${p.nome} removida (DETACH + DROP; ~${Math.max(0, Math.round(p.linhasEstimadas))} linhas, ${p.bytes} bytes)`,
        )
        relatorio.acoes.push({ tabela, acao: 'partition_dropped', particao: p.nome, linhas: Math.max(0, Math.round(p.linhasEstimadas)) })
      } else {
        logger.warn({ event: 'retention_partition_skipped', tabela, particao: p.nome, motivo: apagada }, `[retencao] ${p.nome} não apagada nesta rodada (${apagada})`)
        relatorio.acoes.push({ tabela, acao: apagada === 'bloqueada' ? 'partition_blocked' : 'partition_skipped', particao: p.nome, motivo: apagada })
      }
    } catch (err) {
      const lockTimeout = ehErroDeLockTimeout(err)
      logger.error({ err, tabela, particao: p.nome, alert: lockTimeout ? 'retention_lock_timeout' : 'retention_failed' }, `[retencao] falha ao remover ${p.nome}${lockTimeout ? ' (lock indisponível — tenta de novo na próxima rodada)' : ''}`)
      relatorio.erros.push(`${p.nome}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

const FILTRO_WEBHOOK_PROTEGIDO = Prisma.sql`
  EXISTS (
    SELECT 1 FROM "PaymentIntent" pi
     WHERE pi.id = we."paymentIntentId"
       AND (pi.status IN ('CREATED', 'AUTHORIZED', 'CAPTURE_PENDING', 'PENDING'))
  )`

async function retencaoWebhookEvent(db: PrismaClient, diasBrutos: number, cfg: ConfigRetencao, agora: Date, relatorio: RelatorioRetencao): Promise<void> {
  const dias = clamp(diasBrutos)
  const corte = new Date(agora.getTime() - dias * 86_400_000)

  // Evento antigo NÃO processado nunca é apagado (é sinal de falha a investigar) — só avisa.
  const [pendentes] = await db.$queryRaw<{ n: number }[]>(
    Prisma.sql`SELECT count(*)::float8 AS "n" FROM "WebhookEvent" WHERE "receivedAt" < ${corte} AND "processedAt" IS NULL`,
  )
  if (Number(pendentes.n) > 0) {
    logger.warn({ alert: 'retention_webhook_unprocessed_kept', quantidade: Number(pendentes.n), corte: corte.toISOString() }, `[retencao] ${Number(pendentes.n)} WebhookEvent antigo(s) NÃO processado(s) mantido(s) — investigue o motivo`)
  }

  if (cfg.dryRun) {
    const [r] = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::float8 AS "n" FROM "WebhookEvent" we
       WHERE we."receivedAt" < ${corte} AND we."processedAt" IS NOT NULL AND NOT ${FILTRO_WEBHOOK_PROTEGIDO}
    `)
    logger.info({ event: 'retention_dry_run', tabela: 'WebhookEvent', dias, corte: corte.toISOString(), linhas: Number(r.n) }, `[retencao] DRY-RUN: ${Number(r.n)} WebhookEvent processado(s) seriam removidos`)
    relatorio.acoes.push({ tabela: 'WebhookEvent', acao: 'dry_run_webhook', linhas: Number(r.n) })
    return
  }

  let total = 0
  for (let lote = 0; lote < MAX_LOTES_WEBHOOK_POR_RODADA; lote++) {
    const apagadas = await db.$executeRaw(Prisma.sql`
      WITH alvo AS (
        SELECT we.id FROM "WebhookEvent" we
         WHERE we."receivedAt" < ${corte} AND we."processedAt" IS NOT NULL AND NOT ${FILTRO_WEBHOOK_PROTEGIDO}
         ORDER BY we."receivedAt"
         LIMIT ${LOTE_WEBHOOK}
      )
      DELETE FROM "WebhookEvent" w USING alvo WHERE w.id = alvo.id
    `)
    total += apagadas
    if (apagadas < LOTE_WEBHOOK) break
  }
  logger.info({ event: 'retention_webhook_deleted', tabela: 'WebhookEvent', dias, corte: corte.toISOString(), linhas: total }, `[retencao] ${total} WebhookEvent processado(s) com mais de ${dias} dias removido(s)`)
  relatorio.acoes.push({ tabela: 'WebhookEvent', acao: 'webhook_deleted', linhas: total })
}

/**
 * `NotificationLog` (L1.6, DL6): log operacional SEM PII (só ids, tipo, estado e códigos) das notificações por e-mail — DELETE em lotes das linhas com mais de N dias (12 meses por padrão), por
 * `createdAt` (índice próprio). NÃO é append-only e não é particionada, então o expurgo é por idade, não por DETACH. Mesmas guardas do resto: só roda com RETENTION_ENABLED, respeita o
 * DRY_RUN e o piso de 30 dias (`clamp`). Apagar uma linha antiga libera a reserva do fato — irrelevante: o job de um fato com mais de 12 meses não existe mais na fila.
 */
async function retencaoNotificationLog(db: PrismaClient, diasBrutos: number, cfg: ConfigRetencao, agora: Date, relatorio: RelatorioRetencao): Promise<void> {
  const dias = clamp(diasBrutos)
  const corte = new Date(agora.getTime() - dias * 86_400_000)

  if (cfg.dryRun) {
    const [r] = await db.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::float8 AS "n" FROM "NotificationLog" WHERE "createdAt" < ${corte}`)
    logger.info({ event: 'retention_dry_run', tabela: 'NotificationLog', dias, corte: corte.toISOString(), linhas: Number(r.n) }, `[retencao] DRY-RUN: ${Number(r.n)} NotificationLog com mais de ${dias} dias seriam removidos`)
    relatorio.acoes.push({ tabela: 'NotificationLog', acao: 'dry_run_notification_log', linhas: Number(r.n) })
    return
  }

  let total = 0
  for (let lote = 0; lote < MAX_LOTES_NOTIFICATION_LOG_POR_RODADA; lote++) {
    const apagadas = await db.$executeRaw(Prisma.sql`
      WITH alvo AS (
        SELECT nl.id FROM "NotificationLog" nl
         WHERE nl."createdAt" < ${corte}
         ORDER BY nl."createdAt"
         LIMIT ${LOTE_NOTIFICATION_LOG}
      )
      DELETE FROM "NotificationLog" n USING alvo WHERE n.id = alvo.id
    `)
    total += apagadas
    if (apagadas < LOTE_NOTIFICATION_LOG) break
  }
  logger.info({ event: 'retention_notification_log_deleted', tabela: 'NotificationLog', dias, corte: corte.toISOString(), linhas: total }, `[retencao] ${total} NotificationLog com mais de ${dias} dias removido(s)`)
  relatorio.acoes.push({ tabela: 'NotificationLog', acao: 'notification_log_deleted', linhas: total })
}

/**
 * `AuditLog` (decisão do dono, 05/10/2026): expurgo AUTOMÁTICO por idade, 24 meses — a política de privacidade promete "expurgo automático por idade (24 meses)".
 *
 * O trigger `audit_log_restrict_delete` (migration 20260917150000_audit_log, NÃO alterado) recusa DELETE de linha com `occurredAt >= now() - interval '24 months'` — e UPDATE/TRUNCATE sempre.
 * `interval '24 months'` é de CALENDÁRIO, no fuso da sessão: vale 730 ou 731 dias conforme caia um 29/02 na janela. Por isso o corte NUNCA é só `agora - N dias`: é
 * `LEAST(agora - N dias, now() - interval '24 months')`, com a MESMA expressão e o mesmo `now()` (início da transação) que o trigger usa — uma linha que o corte
 * escolhe nunca é uma que o trigger recusa (senão o lote inteiro falharia). `<` estrito aqui, `>=` lá: complementares, sem fresta na fronteira. O prazo configurável só pode
 * ser MAIOR que 24 meses ({@link prazoAuditLogEfetivo}); menor, o banco recusaria.
 *
 * Tudo numa transação só (lock consultivo da manutenção + lotes de 1000, até 200 lotes por rodada; o resto fica para a próxima): a linha de auditoria DA PRÓPRIA purga
 * (ator SYSTEM, `OTHER`, contagem + intervalo + corte, sem PII e sem o conteúdo apagado) entra na mesma transação — ou apagou E ficou registrado, ou nada aconteceu. Ela nasce com
 * `occurredAt = now()`, então só será apagada daqui a 24 meses. Rodada que não apagou nada NÃO grava linha (seria uma linha por dia, para sempre, dizendo "0").
 * O DELETE é IRREVERSÍVEL: backup antes de ligar (docs/DEPLOY-EASYPANEL.md, 7.4).
 */
async function retencaoAuditLog(db: PrismaClient, diasBrutos: number | undefined, cfg: ConfigRetencao, agora: Date, relatorio: RelatorioRetencao): Promise<void> {
  const dias = prazoAuditLogEfetivo(diasBrutos)
  const maxLotes = cfg.auditLogMaxLotes !== undefined && Number.isInteger(cfg.auditLogMaxLotes) && cfg.auditLogMaxLotes >= 1 ? cfg.auditLogMaxLotes : MAX_LOTES_AUDIT_LOG_POR_RODADA
  const corteConfigurado = new Date(agora.getTime() - dias * 86_400_000)
  const corteSql = Prisma.sql`LEAST(${corteConfigurado}::timestamptz, now() - interval '24 months')`

  if (cfg.dryRun) {
    const [r] = await db.$queryRaw<{ n: number; corte: Date }[]>(Prisma.sql`SELECT count(*)::float8 AS "n", ${corteSql} AS "corte" FROM "AuditLog" WHERE "occurredAt" < ${corteSql}`)
    logger.info({ event: 'retention_dry_run', tabela: 'AuditLog', dias, corte: r.corte.toISOString(), linhas: Number(r.n) }, `[retencao] DRY-RUN: ${Number(r.n)} AuditLog com mais de ${dias} dias seriam removidos`)
    relatorio.acoes.push({ tabela: 'AuditLog', acao: 'dry_run_audit_log', linhas: Number(r.n) })
    return
  }

  const resultado = await db.$transaction(
    async (tx) => {
      await definirLockTimeout(tx, LOCK_TIMEOUT_MS)
      if (!(await tentarLockManutencao(tx))) return null
      const [c] = await tx.$queryRaw<{ corte: Date }[]>(Prisma.sql`SELECT ${corteSql} AS "corte"`)
      let total = 0
      let lotes = 0
      let maisAntiga: Date | null = null
      let maisNova: Date | null = null
      let esgotou = false
      while (lotes < maxLotes) {
        const [r] = await tx.$queryRaw<{ n: number; minimo: Date | null; maximo: Date | null }[]>(Prisma.sql`
          WITH alvo AS (
            SELECT al.id FROM "AuditLog" al
             WHERE al."occurredAt" < ${corteSql}
             ORDER BY al."occurredAt"
             LIMIT ${LOTE_AUDIT_LOG}
          ),
          apagadas AS (
            DELETE FROM "AuditLog" a USING alvo WHERE a.id = alvo.id RETURNING a."occurredAt"
          )
          SELECT count(*)::int AS "n", min("occurredAt") AS "minimo", max("occurredAt") AS "maximo" FROM apagadas
        `)
        lotes++
        const n = Number(r.n)
        if (n === 0) {
          esgotou = true
          break
        }
        total += n
        if (r.minimo && (maisAntiga === null || r.minimo < maisAntiga)) maisAntiga = r.minimo
        if (r.maximo && (maisNova === null || r.maximo > maisNova)) maisNova = r.maximo
        if (n < LOTE_AUDIT_LOG) {
          esgotou = true
          break
        }
      }
      if (total > 0) {
        // Fail-closed: se o registro da purga falhar, a transação inteira volta e nada foi apagado. Sem PII e sem conteúdo apagado: só contagem, intervalo e corte.
        await writeAuditLog(
          {
            actorUserId: SYSTEM_ACTOR.userId,
            actorRole: 'SYSTEM',
            actorEmail: SYSTEM_ACTOR.email,
            actorName: SYSTEM_ACTOR.name,
            actorOperatorId: null,
            action: 'OTHER',
            actionDetail: 'retention:audit_log_purged',
            outcome: 'SUCCESS',
            entityType: 'AuditLog',
            changes: {
              deletedCount: { to: total },
              oldestDeletedAt: { to: maisAntiga?.toISOString() ?? null },
              newestDeletedAt: { to: maisNova?.toISOString() ?? null },
              cutoff: { to: c.corte.toISOString() },
              retentionDays: { to: dias },
              batches: { to: lotes },
            },
          },
          tx,
        )
      }
      return { total, lotes, corte: c.corte, maisAntiga, maisNova, limitada: !esgotou }
    },
    { timeout: 300_000, maxWait: 15_000 },
  )

  if (resultado === null) {
    logger.info({ event: 'retention_audit_log_skipped', tabela: 'AuditLog', motivo: 'sem_lock' }, '[retencao] AuditLog: outra execução segura o lock da manutenção — nada feito nesta rodada')
    relatorio.acoes.push({ tabela: 'AuditLog', acao: 'audit_log_skipped', motivo: 'sem_lock' })
    return
  }
  logger.info(
    {
      event: 'retention_audit_deleted',
      tabela: 'AuditLog',
      dias,
      corte: resultado.corte.toISOString(),
      linhas: resultado.total,
      lotes: resultado.lotes,
      de: resultado.maisAntiga?.toISOString() ?? null,
      ate: resultado.maisNova?.toISOString() ?? null,
      limitadaPorRodada: resultado.limitada,
    },
    `[retencao] ${resultado.total} AuditLog com mais de ${dias} dias removido(s)${resultado.limitada ? ' (teto de lotes da rodada atingido — o resto sai na próxima)' : ''}`,
  )
  relatorio.acoes.push({ tabela: 'AuditLog', acao: 'audit_log_deleted', linhas: resultado.total })
}

/** Ponto de entrada. Desligada => retorna sem tocar no banco (nem para ler). */
export async function aplicarRetencao(db: PrismaClient, cfg: ConfigRetencao, agora: Date = new Date()): Promise<RelatorioRetencao> {
  const relatorio: RelatorioRetencao = { habilitada: cfg.habilitada, dryRun: cfg.dryRun, acoes: [], erros: [] }
  if (!cfg.habilitada) {
    logger.info({ event: 'retention_disabled' }, '[retencao] DESLIGADA (RETENTION_ENABLED=false) — nenhum dado é purgado. Ligue por env só depois de o dono decidir os prazos.')
    return relatorio
  }

  const passos: { nome: string; rodar: () => Promise<void> }[] = [
    { nome: 'OcppMessage', rodar: () => retencaoParticionada(db, 'OcppMessage', cfg.ocppMessageDias, cfg, agora, relatorio) },
    { nome: 'MeterSample', rodar: () => retencaoParticionada(db, 'MeterSample', cfg.meterSampleDias, cfg, agora, relatorio) },
    { nome: 'WebhookEvent', rodar: () => retencaoWebhookEvent(db, cfg.webhookEventDias, cfg, agora, relatorio) },
    { nome: 'NotificationLog', rodar: () => retencaoNotificationLog(db, cfg.notificationLogDias ?? NOTIFICATION_LOG_DIAS_PADRAO, cfg, agora, relatorio) },
    { nome: 'AuditLog', rodar: () => retencaoAuditLog(db, cfg.auditLogDias, cfg, agora, relatorio) },
  ]
  for (const passo of passos) {
    try {
      await passo.rodar()
    } catch (err) {
      logger.error({ err, tabela: passo.nome, alert: 'retention_failed' }, `[retencao] falha na retenção de ${passo.nome}`)
      relatorio.erros.push(`${passo.nome}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return relatorio
}
