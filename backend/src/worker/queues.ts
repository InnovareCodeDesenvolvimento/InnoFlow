import { Queue } from 'bullmq'
import { createRedisConnection } from '../lib/redis'

/**
 * Fábrica de filas BullMQ — cada chamador abre a conexão que precisa (mesmo
 * espírito de `lib/redis.ts`: BullMQ exige conexão dedicada, não
 * compartilhada com pub/sub comum).
 */
export function createQueue(name: string): Queue {
  return new Queue(name, { connection: createRedisConnection() })
}

/**
 * Fila de retry da liquidação financeira do `StopTransaction` (F4, Vega
 * 2026-09-17) — ver `services/carteira/liquidarSessao.ts` e
 * `worker/jobs/liquidarSessaoJob.ts`. Nome de fila compartilhado entre quem
 * enfileira (o handler OCPP, quando a transação de liquidação falha) e quem
 * processa (o worker) — mesmo cuidado de `ocpp/commands.ts` (nomes de canal
 * num lugar só, para os dois lados nunca divergirem em silêncio).
 */
export const LIQUIDAR_SESSAO_QUEUE_NAME = 'liquidar-sessao'

export interface LiquidarSessaoJobData {
  sessionId: string
}

/**
 * Processamento assíncrono do webhook da Cielo (F5.2, Vega 2026-09-30) —
 * enfileirado por `api/routes/webhooksCielo.routes.ts` depois de gravar a
 * caixa de entrada (`WebhookEvent`) e responder 200. Ver
 * `services/pagamentos/creditarTopupPix.ts`.
 */
export const CREDITAR_TOPUP_PIX_QUEUE_NAME = 'creditar-topup-pix'

export interface CreditarTopupPixJobData {
  webhookEventId: string
}

/**
 * Varredor periódico de expiração da recarga Pix (F5.2) — job REPEATABLE
 * (BullMQ `upsertJobScheduler`, agendado em `entrypoints/worker.ts`), sem
 * dado próprio (sempre varre tudo que está vencido no momento em que roda).
 */
export const EXPIRAR_TOPUPS_PIX_QUEUE_NAME = 'expirar-topups-pix'

/** Sem dado próprio: cada disparo varre tudo que estiver vencido NO MOMENTO em que roda (nunca usa dado fixado no agendamento). */
export type ExpirarTopupsPixJobData = Record<string, never>
