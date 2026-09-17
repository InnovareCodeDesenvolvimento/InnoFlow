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
