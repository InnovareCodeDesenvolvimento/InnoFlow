import { Queue } from 'bullmq'
import { createRedisConnection } from '../lib/redis'

/**
 * STUB — Fase 0. Nenhuma fila de negócio registrada ainda (jobs de
 * tarifação, liquidação de pagamento, retry de comando OCPP, etc. são do
 * Vega/Cronos, em `worker/jobs/`). Só confirma que dá para abrir uma
 * conexão BullMQ/Redis a partir do worker.
 */
export function createQueue(name: string): Queue {
  return new Queue(name, { connection: createRedisConnection() })
}
