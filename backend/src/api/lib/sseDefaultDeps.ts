import { env } from '../../lib/env'
import { subscribeChannels } from '../../realtime/bus'
import { createStreamLimiter } from '../../core/realtime/streamLimiter'
import { sessionValidator } from './sessionValidatorInstance'
import type { SseDeps } from './sseStream'

/** Dependências reais dos endpoints SSE (hub compartilhado do Redis, teto de streams do processo, validação de sessão com cache). Uma instância por processo: o limiter é estado em memória. */
export const sseDeps: SseDeps = {
  subscribe: (channels, listener) => subscribeChannels(channels, listener),
  limiter: createStreamLimiter({ perUser: env.SSE_MAX_STREAMS_PER_USER, perIp: env.SSE_MAX_STREAMS_PER_IP, total: env.SSE_MAX_STREAMS_TOTAL }),
  validateSession: (user) => sessionValidator.validate(user.userId, user),
  heartbeatMs: env.SSE_HEARTBEAT_INTERVAL_SECONDS * 1000,
}
