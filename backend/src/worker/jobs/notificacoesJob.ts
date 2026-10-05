import { Worker, type Job } from 'bullmq'
import { createRedisConnection, redis } from '../../lib/redis'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { prisma } from '../../lib/prisma'
import { resolverBaseUrlPublica } from '../../core/auth/redefinicaoSenha'
import { codigoSeguroDeMotivo } from '../../core/notificacoes/politica'
import { dadosPublicosDaEmpresa } from '../../services/legal/consentimento'
import { enviarEmailTransacional } from '../../services/comunicacao/email'
import { criarProcessadorDeNotificacoes } from '../../services/notificacoes/processarNotificacao'
import { NOTIFICACOES_QUEUE_NAME, type NotificacaoJobData } from '../queues'

/**
 * Worker das notificações por e-mail ao motorista (L1.6). A decisão e o envio estão em `services/notificacoes/processarNotificacao.ts`; aqui só a cola com o BullMQ:
 *  - resultado `REPETIR` (SMTP fora, lock ocupado) vira exceção SÓ com o CÓDIGO do motivo (a mensagem crua do SMTP nunca chega ao `failedReason`, que fica no Redis) e o BullMQ reagenda
 *    com backoff exponencial (30 s, 1, 2, 4, 8 min);
 *  - ao ESGOTAR as tentativas: a linha de `NotificationLog` vai para `FAILED` (com o código), o payload do job perde o endereço (`ACCOUNT_DELETED`) e sai o alerta
 *    `communication_notification_failed` — o dono é avisado de que o e-mail NÃO chegou (SMTP fora de verdade, não um soluço).
 */

const processador = criarProcessadorDeNotificacoes({
  prisma,
  redis,
  enviar: (msg) => enviarEmailTransacional(msg),
  baseUrl: () => resolverBaseUrlPublica({ publicAppUrl: env.PUBLIC_APP_URL, corsOrigins: env.CORS_ALLOWED_ORIGINS, producao: env.NODE_ENV === 'production' }),
  empresa: dadosPublicosDaEmpresa, // painel > env, com cache de 30 s (nunca lança: banco fora => env)
  log: logger,
})

export function startNotificacoesWorker(): Worker<NotificacaoJobData> {
  const worker = new Worker<NotificacaoJobData>(
    NOTIFICACOES_QUEUE_NAME,
    async (job: Job<NotificacaoJobData>) => {
      const r = await processador.processar(job.data)
      if (r.status === 'REPETIR') throw new Error(r.codigo)
      return r.status
    },
    // lockDuration > o prazo do envio (20 s) + banco: o job não é dado como "stalled" no meio do SMTP.
    { connection: createRedisConnection(), concurrency: 5, lockDuration: 60_000 },
  )

  worker.on('failed', (job, err) => {
    if (!job) return
    const codigo = codigoSeguroDeMotivo(err.message)
    const ultima = job.attemptsMade >= (job.opts.attempts ?? 1)
    logger.warn({ event: 'notification_job_failed', tipo: job.data.tipo, userId: job.data.userId, entityId: job.data.entityId, tentativa: job.attemptsMade, ultima, motivo: codigo }, '[worker][notificacoes] tentativa de envio falhou')
    if (!ultima) return
    void (async () => {
      const marcou = await processador.marcarEsgotada(job.data, codigo)
      // O endereço do ACCOUNT_DELETED não fica no Redis depois de desistir (removeOnFail guarda o job por 1 dia).
      if (job.data.destinatario) await job.updateData({ ...job.data, destinatario: undefined }).catch(() => undefined)
      if (marcou) {
        // SEM userId/entityId no alerta (entram na chave de dedupe e cada e-mail perdido viraria um aviso): o alerta é por TIPO + MOTIVO; os ids estão no log acima.
        logger.error(
          { alert: 'communication_notification_failed', escopo: job.data.tipo, motivo: codigo, tentativas: job.attemptsMade },
          '[worker][notificacoes] e-mail ao motorista NÃO enviado após todas as tentativas — conferir o SMTP (Admin > Comunicação)',
        )
      }
    })().catch((e: unknown) => logger.error({ err: e }, '[worker][notificacoes] falha ao encerrar a notificação esgotada'))
  })
  worker.on('completed', (job, resultado: unknown) => {
    logger.info({ event: 'notification_job_done', tipo: job.data.tipo, entityId: job.data.entityId, resultado }, '[worker][notificacoes] job concluído')
  })

  logger.info('[worker][notificacoes] worker ativo')
  return worker
}
