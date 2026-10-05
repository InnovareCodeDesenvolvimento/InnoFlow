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

/**
 * Polling do Pix PENDING (conta Cielo compartilhada, sem webhook do InnoFlow) — job REPEATABLE sem dado próprio; ver `services/pagamentos/pollTopupsPix.ts`.
 */
export const POLL_TOPUPS_PIX_QUEUE_NAME = 'poll-topups-pix'
export type PollTopupsPixJobData = Record<string, never>

/** Sem dado próprio: cada disparo varre tudo que estiver vencido NO MOMENTO em que roda (nunca usa dado fixado no agendamento). */
export type ExpirarTopupsPixJobData = Record<string, never>

/**
 * Captura de sessão CARD (F5.4, 2026-09-30) — enfileirada por
 * `finalizarSessao.ts` DEPOIS do commit que marca `CAPTURE_PENDING` (rede não
 * entra em transação de banco). Ver `services/pagamentos/capturarSessaoCartao.ts`.
 */
export const CAPTURAR_SESSAO_CARTAO_QUEUE_NAME = 'capturar-sessao-cartao'

export interface CapturarSessaoCartaoJobData {
  paymentIntentId: string
}

/**
 * Varredor periódico de pré-autorizações de cartão (F5.4) — job REPEATABLE
 * (mesmo padrão de `expirarTopupsPixJob.ts`): cancela pré-auth abandonada
 * sem sessão (+`CARD_PREAUTH_ABANDON_MINUTES`), reconsulta intents `CREATED`
 * que nunca resolveram, e alerta sobre `CAPTURE_PENDING` antigo demais (a
 * Cielo pode levar até 5 dias úteis para capturar — não é erro automático).
 * Ver `services/pagamentos/varrerPreAutorizacoesCartao.ts`.
 */
export const VARRER_PREAUTORIZACOES_CARTAO_QUEUE_NAME = 'varrer-preautorizacoes-cartao'

/** Sem dado próprio — mesmo espírito de `ExpirarTopupsPixJobData`. */
export type VarrerPreAutorizacoesCartaoJobData = Record<string, never>

/**
 * Watchdog de sessões de recarga travadas (F5.9, 9b1) — job REPEATABLE (`upsertJobScheduler`, mesmo padrão de
 * `varrerPreAutorizacoesCartaoJob.ts`), sem dado próprio: cada disparo reavalia TODAS as sessões abertas/em confirmação no momento em
 * que roda. Ver `services/sessao/vigiarSessoes.ts`.
 */
export const VIGIAR_SESSOES_QUEUE_NAME = 'vigiar-sessoes'

/** Sem dado próprio — mesmo espírito de `VarrerPreAutorizacoesCartaoJobData`. */
export type VigiarSessoesJobData = Record<string, never>

/**
 * Manutenção de partições + retenção (N-11, Cronos 2026-10-05) — job REPEATABLE (`upsertJobScheduler`, agendado em `entrypoints/worker.ts`), sem dado
 * próprio: cada disparo garante as partições futuras de MeterSample/OcppMessage e, só se RETENTION_ENABLED, aplica a retenção. Ver `services/manutencao/`.
 */
export const MANTER_PARTICOES_QUEUE_NAME = 'manter-particoes'

/** Sem dado próprio — mesmo espírito de `VigiarSessoesJobData`. */
export type ManterParticoesJobData = Record<string, never>
