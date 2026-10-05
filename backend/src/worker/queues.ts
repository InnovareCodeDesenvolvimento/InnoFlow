import { Queue } from 'bullmq'
import { createRedisConnection } from '../lib/redis'
import type { TipoDeNotificacao } from '../core/notificacoes/politica'

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

/**
 * Confirmação das devoluções feitas no PORTAL DA CIELO (L1.8) — job REPEATABLE (`upsertJobScheduler`, agendado em `entrypoints/worker.ts`), sem dado próprio: cada disparo
 * reconsulta as devoluções `PENDING_CONFIRMATION` no momento em que roda. Baixa frequência (`REFUND_PORTAL_SCAN_INTERVAL_MS`). Ver `services/estornos/confirmarEstornosPortal.ts`.
 */
export const CONFIRMAR_ESTORNOS_PORTAL_QUEUE_NAME = 'confirmar-estornos-portal'

/** Sem dado próprio — mesmo espírito de `ManterParticoesJobData`. */
export type ConfirmarEstornosPortalJobData = Record<string, never>

/**
 * Notificações por e-mail ao motorista (L1.6) — enfileiradas DEPOIS do commit do fato (`services/notificacoes/enfileirarNotificacao.ts`), fire-and-forget com prazo; processadas pelo
 * worker (`worker/jobs/notificacoesJob.ts`). `jobId` = `notif-<tipo>-<entidade>` (um fato nunca tem dois jobs vivos); a idempotência DURÁVEL é a linha de `NotificationLog`
 * (unique userId+tipo+canal+entidade). O payload é só ids e valores em centavos — o ÚNICO dado pessoal possível é `destinatario`, do `ACCOUNT_DELETED` (a conta já foi anonimizada
 * quando o aviso sai): vive só no job, e é apagado ao concluir (`removeOnComplete`) e ao esgotar as tentativas.
 */
export const NOTIFICACOES_QUEUE_NAME = 'notificacoes'

export interface NotificacaoJobData {
  tipo: TipoDeNotificacao
  userId: string
  /** Id do FATO que gerou o aviso (sessão, WalletEntry, intent, correlationId, requestId...). ≤ 128. */
  entityId: string
  /** Quando o fato aconteceu (ISO), para os avisos que citam a hora (senha alterada, recarga iniciada pelo suporte). */
  ocorridoEm?: string
  /** `REMOTE_START_BY_SUPPORT`: o carregador (o fato em si não tem linha no banco: o `correlationId` só vive 2 min no Redis). */
  chargePointId?: string
  /** `TOPUP_CREDITED`: números do crédito (o intent não guarda o quanto quitou de dívida). Só centavos. */
  creditadoCents?: number
  quitouDividaCents?: number
  saldoCents?: number
  /** `ACCOUNT_DELETED`: único dado pessoal do payload (ver acima). */
  destinatario?: { email: string; nome: string }
}
