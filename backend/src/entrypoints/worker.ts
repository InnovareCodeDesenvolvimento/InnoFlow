import 'dotenv/config'
import { logger } from '../lib/logger'

// Nenhuma fila registrada ainda nesta fase — ver src/worker/queues.ts.
// O worker sobe só para provar que o processo inicializa e loga.
logger.info('worker ok')
