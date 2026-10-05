import { Prisma, type PrismaClient } from '@prisma/client'
import { logger } from '../../lib/logger'
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
 * O QUE NUNCA PURGA (por desenho, sem opção de configuração): `AuditLog`, `WalletEntry`, `PaymentIntent`, `Debt`, `ChargingSession` e o
 * restante do financeiro. `WalletEntry` e `AuditLog` têm trigger append-only (UPDATE/DELETE/TRUNCATE); a política e o procedimento
 * manual estão em docs/DEPLOY-EASYPANEL.md ("Partições e retenção").
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
}

/** Piso duro em código (o env também valida): ninguém "limpa tudo" por engano com um 0 ou 1 digitado errado. */
export const DIAS_MINIMOS_RETENCAO = 30
const MARGEM_SESSAO_MS = 2 * 24 * 3_600_000
const LOTE_WEBHOOK = 1000
const MAX_LOTES_WEBHOOK_POR_RODADA = 200
const LOTE_NOTIFICATION_LOG = 1000
const MAX_LOTES_NOTIFICATION_LOG_POR_RODADA = 200
export const NOTIFICATION_LOG_DIAS_PADRAO = 365

const REGEX_PARTICAO: Record<TabelaParticionada, RegExp> = {
  MeterSample: /^MeterSample_\d{4}_\d{2}$/,
  OcppMessage: /^OcppMessage_\d{4}_\d{2}$/,
}

export interface AcaoRetencao {
  tabela: string
  acao: 'partition_dropped' | 'dry_run_partition' | 'partition_blocked' | 'partition_skipped' | 'webhook_deleted' | 'dry_run_webhook' | 'notification_log_deleted' | 'dry_run_notification_log'
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
