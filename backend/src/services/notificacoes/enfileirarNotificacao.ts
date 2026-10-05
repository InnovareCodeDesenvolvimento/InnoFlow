import { Queue } from 'bullmq'
import { redis } from '../../lib/redis'
import { logger } from '../../lib/logger'
import { withDeadline } from '../../lib/withDeadline'
import { createLogGate } from '../../lib/rateLimitedLog'
import { NOTIFICACOES_QUEUE_NAME, type NotificacaoJobData } from '../../worker/queues'
import { jobIdDaNotificacao, NOTIFICACAO_JOB_ATTEMPTS, NOTIFICACAO_JOB_BACKOFF_MS, NOTIFICATION_TYPES } from '../../core/notificacoes/politica'

/**
 * Lado PRODUTOR das notificações ao motorista (L1.6): quem tem o fato (finalizarSessao, creditarTopupPix, rotas de auth...) chama uma função de `gatilhos.ts` DEPOIS do commit, e
 * isto vira um job na fila `notificacoes`.
 *
 * REGRA DE OURO: nunca derruba nem atrasa transação de dinheiro. Por isso:
 *  - FIRE-AND-FORGET: o chamador não espera (`dispararEmSegundoPlano` devolve `void`); toda falha — Redis fora, fila cheia, payload inválido — vira log, nunca exceção;
 *  - COM PRAZO (`PRAZO_DO_ENFILEIRAMENTO_MS`): com o Redis fora o ioredis (`maxRetriesPerRequest: null`, exigência do BullMQ) não rejeita, só espera reconectar — o `add` abandonado
 *    conclui sozinho se o Redis voltar (o `jobId` determinístico impede duplicata);
 *  - TETO de tarefas em voo (`MAX_EM_VOO`): com o Redis fora por muito tempo o excesso é DESCARTADO e contado — nunca acumula memória/conexões sem limite;
 *  - a fila é UMA por processo, criada na primeira necessidade, sobre a conexão geral do processo (`lib/redis`) — nenhuma conexão extra.
 * Trade-off assumido e documentado: Redis fora no instante do fato PERDE o aviso (não há rascunho em banco para um varredor refazer — o contexto de alguns tipos não está no banco). O
 * fato em si (cobrança, dívida, saldo) está íntegro e visível no app; só o e-mail não sai.
 */

export const PRAZO_DO_ENFILEIRAMENTO_MS = 3_000
const MAX_EM_VOO = 200
const gateTetoDeTarefas = createLogGate(60_000)
const gateFalhaAoEnfileirar = createLogGate(30_000)

/** Só o NOME (e o código, se houver) do erro: a mensagem de uma biblioteca de rede/banco pode embutir host, credencial ou dado da linha. */
function nomeDoErro(err: unknown): string {
  if (!(err instanceof Error)) return 'erro'
  const codigo = (err as { code?: unknown }).code
  return typeof codigo === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(codigo) ? `${err.name}:${codigo}` : err.name
}

let filaDoProcesso: Queue | null = null
function filaDasNotificacoes(): Queue {
  // Reaproveita a conexão geral do processo (`lib/redis`): um `Queue` PRODUTOR pode dividir conexão (só o Worker precisa da dele), e assim não há conexão extra por processo nem handle que ninguém fecha.
  filaDoProcesso ??= new Queue(NOTIFICACOES_QUEUE_NAME, { connection: redis })
  return filaDoProcesso
}

/** Só para teste/encerramento: fecha a conexão do processo. */
export async function fecharFilaDasNotificacoes(): Promise<void> {
  const f = filaDoProcesso
  filaDoProcesso = null
  if (f) await f.close().catch(() => undefined)
}

export type PedidoDeNotificacao = NotificacaoJobData

/** Só para teste: encolhe a política do job (6 x 30 s exponencial) para um teste não esperar minutos. Produção nunca passa isto. */
export interface DepsDoEnfileiramento {
  queue?: Queue
  prazoMs?: number
  opcoesDoJob?: { attempts?: number; backoffMs?: number }
}

export type ResultadoDoEnfileiramento = 'ENFILEIRADO' | 'RECUSADO' | 'FALHOU'

const TIPOS = new Set<string>(NOTIFICATION_TYPES)

/** Valida o pedido antes de tocar no Redis (payload torto é bug de quem chamou: recusa e loga, não retenta nunca). */
export function pedidoValido(p: PedidoDeNotificacao): boolean {
  if (!TIPOS.has(p.tipo)) return false
  if (typeof p.userId !== 'string' || p.userId.length === 0 || p.userId.length > 64) return false
  if (typeof p.entityId !== 'string' || p.entityId.trim().length === 0 || p.entityId.length > 128) return false
  if (p.tipo === 'ACCOUNT_DELETED' && !(p.destinatario && p.destinatario.email && p.destinatario.nome !== undefined)) return false
  return true
}

/**
 * Enfileira UM aviso. NUNCA lança. `deps.queue` injeta uma fila (testes); no uso real vale a fila do processo.
 * Idempotente por `jobId`: o mesmo fato enfileirado de novo enquanto o job existe não duplica (o BullMQ ignora o `add`).
 */
export async function enfileirarNotificacao(pedido: PedidoDeNotificacao, deps: DepsDoEnfileiramento = {}): Promise<ResultadoDoEnfileiramento> {
  if (!pedidoValido(pedido)) {
    logger.error({ event: 'notification_enqueue_invalid', tipo: pedido?.tipo }, '[notificacoes] pedido de notificação inválido — descartado (bug de quem chamou)')
    return 'RECUSADO'
  }
  try {
    const queue = deps.queue ?? filaDasNotificacoes()
    await withDeadline(
      queue.add('notificar', pedido, {
        jobId: jobIdDaNotificacao(pedido.tipo, pedido.entityId),
        attempts: deps.opcoesDoJob?.attempts ?? NOTIFICACAO_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: deps.opcoesDoJob?.backoffMs ?? NOTIFICACAO_JOB_BACKOFF_MS },
        removeOnComplete: true, // o payload (que pode ter e-mail, no ACCOUNT_DELETED) não fica em repouso depois de concluído
        removeOnFail: { age: 24 * 3600, count: 500 }, // prazo curto: o motivo da falha fica visível por 1 dia, depois some
      }),
      deps.prazoMs ?? PRAZO_DO_ENFILEIRAMENTO_MS,
      'enfileirar notificação',
    )
    return 'ENFILEIRADO'
  } catch (err) {
    // SEM o destinatário, o payload nem a MENSAGEM do erro (a de uma biblioteca de rede pode embutir host/credencial): só o nome/código do erro.
    gateFalhaAoEnfileirar((suprimidos) =>
      logger.warn({ event: 'notification_enqueue_failed', erro: nomeDoErro(err), tipo: pedido.tipo, userId: pedido.userId, entityId: pedido.entityId, suprimidos }, '[notificacoes] não consegui enfileirar o aviso (o fato já foi gravado; só o e-mail deixa de sair)'),
    )
    return 'FALHOU'
  }
}

const emVoo = new Set<Promise<void>>()

/**
 * Roda `tarefa` FORA do caminho de quem chamou: devolve na hora, nunca lança, e conta o que está em voo (teto `MAX_EM_VOO`). `tarefa` pode fazer I/O (ex.: ler preferências no banco).
 */
export function dispararEmSegundoPlano(rotulo: string, tarefa: () => Promise<void>): void {
  if (emVoo.size >= MAX_EM_VOO) {
    gateTetoDeTarefas((suprimidos) => logger.warn({ event: 'notification_inflight_cap', rotulo, limite: MAX_EM_VOO, suprimidos }, '[notificacoes] muitas notificações em voo — aviso descartado (o fato está gravado)'))
    return
  }
  const p: Promise<void> = (async () => {
    try {
      await tarefa()
    } catch (err) {
      logger.warn({ event: 'notification_trigger_failed', erro: nomeDoErro(err), rotulo }, '[notificacoes] falha ao preparar o aviso ao motorista (ignorada: o fato já foi gravado)')
    }
  })()
  emVoo.add(p)
  void p.finally(() => emVoo.delete(p))
}

export function enfileirarEmSegundoPlano(pedido: PedidoDeNotificacao, deps: DepsDoEnfileiramento = {}): void {
  dispararEmSegundoPlano(`enfileirar:${pedido?.tipo}`, async () => {
    await enfileirarNotificacao(pedido, deps)
  })
}

/** Resolve quando nada está em voo (testes e encerramento ordenado). */
export async function aguardarNotificacoesEmVoo(): Promise<void> {
  while (emVoo.size > 0) await Promise.allSettled([...emVoo])
}
