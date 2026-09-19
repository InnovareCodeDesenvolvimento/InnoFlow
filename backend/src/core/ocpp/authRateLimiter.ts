import { createHash } from 'node:crypto'

/**
 * Limite de tentativas de autenticação do gateway OCPP (Órion A1, 2026-09-19; reserva antes de
 * avaliar: Íris/Vega, 2026-09-19).
 *
 * O desenho anterior contava falhas só por `ocppIdentity` — e a identidade é PÚBLICA
 * (`GET /api/sites` devolve `ocppIdentity` de todo carregador): qualquer um errava 5 senhas e o
 * carregador REAL, com a credencial certa, tomava 429 por 5 min (lockout provado pelo Órion).
 * Agora dois contadores independentes:
 *
 *  1. (identidade + IP) — barra a adivinhação de senha contra uma identidade, mas só a partir
 *     do IP de quem errou: o atacante trava o SEU par, nunca o carregador legítimo (outro IP).
 *     É zerado quando a autenticação DÁ CERTO (o carregador real não acumula falhas antigas).
 *  2. global por IP — barra o flood (identidade inexistente, hoje cada tentativa vira consulta
 *     ao banco + bcrypt sem freio). NÃO é zerado por sucesso (senão um IP intercalaria sucesso
 *     e falha para nunca estourar); só expira pela janela.
 *
 * RESERVA ANTES DE AVALIAR (causa raiz do furo de concorrência): o desenho "ler o contador ->
 * consultar o banco/bcrypt -> só então contar a falha" deixava uma rajada de N handshakes paralelos
 * ler 0 em todas as N tentativas: 40 paralelas com limite 5 avaliaram 40 e barraram 0. A decisão
 * era tomada sobre um sinal instantâneo (o contador de agora), enquanto a contagem só acontecia
 * ~250 ms depois (bcrypt). Agora `reserve` decide E conta num passo atômico ANTES de qualquer
 * trabalho caro: cada tentativa em andamento já ocupa uma vaga. O resultado depois disso:
 *  - falha (identidade desconhecida/inativa ou senha errada): a vaga fica gasta (é a falha) —
 *    `describeFailure` só calcula o alerta, sem tocar no armazenamento;
 *  - sucesso: `registerSuccess` zera o par e DEVOLVE a vaga do global do IP (o sucesso não pode
 *    contar como falha nem zerar as falhas alheias daquele IP);
 *  - erro inesperado no meio (banco fora do ar, p.ex.): `release` devolve as duas vagas — a
 *    indisponibilidade NOSSA não pode virar lockout do carregador.
 *
 * Toda a decisão é pura e o armazenamento é injetado (`AuthCounterStore`) — testável sem Redis.
 */

export interface AuthCounterStore {
  /**
   * ATÔMICO: se AMBOS os contadores estão abaixo dos limites, incrementa os dois (TTL na criação) e
   * devolve os novos valores; senão devolve qual barrou e NÃO toca em chave nenhuma.
   */
  reserve(keys: { pair: string; ip: string }, limits: { maxPair: number; maxIp: number }, ttlSeconds: number): Promise<{ ok: true; pairCount: number; ipCount: number } | { ok: false; scope: AuthBlockScope }>
  /** Devolve UMA reserva de cada chave (nunca negativa, nunca recria chave ausente). */
  release(keys: string[]): Promise<void>
  del(keys: string[]): Promise<void>
}

export interface AuthRateLimitConfig {
  /** Tentativas do par (identidade + IP) na janela até bloquear. */
  maxAttemptsPerIdentityIp: number
  /** Tentativas de um IP (qualquer identidade) na janela até bloquear. */
  maxFailuresPerIp: number
  windowSeconds: number
}

export interface AuthAttempt {
  identity: string
  ip: string
}

export type AuthBlockScope = 'identity_ip' | 'ip'

/** A vaga reservada por uma tentativa em andamento, com os contadores no instante da reserva. */
export interface AuthReservation {
  identityIpCount: number
  ipCount: number
}

export type AuthGate = ({ allowed: true } & AuthReservation) | { allowed: false; scope: AuthBlockScope }

export interface AuthFailureOutcome {
  identityIpCount: number
  ipCount: number
  /** Esta falha foi a que ATIVOU o bloqueio do par (identidade+IP) — momento certo de alertar (uma vez). */
  identityIpBlockedNow: boolean
  /** Idem para o bloqueio global do IP. */
  ipBlockedNow: boolean
}

/**
 * Chaves derivadas com SHA-256 da identidade: ela vem da URL (controlada pelo atacante, tamanho
 * livre) — hash mantém a chave curta e de tamanho fixo. O IP entra em claro (já normalizado).
 */
function identityIpKey(a: AuthAttempt): string {
  return `ocpp:auth:fail:id:${createHash('sha256').update(a.identity).digest('hex').slice(0, 32)}:${a.ip}`
}
const ipKey = (ip: string): string => `ocpp:auth:fail:ip:${ip}`

export function createOcppAuthRateLimiter(store: AuthCounterStore, config: AuthRateLimitConfig) {
  return {
    /**
     * Reserva a tentativa ANTES de qualquer consulta ao banco/bcrypt. Barrada = não escreve nada.
     * O global do IP tem precedência (é o que protege o banco).
     */
    async reserve(attempt: AuthAttempt): Promise<AuthGate> {
      const result = await store.reserve(
        { pair: identityIpKey(attempt), ip: ipKey(attempt.ip) },
        { maxPair: config.maxAttemptsPerIdentityIp, maxIp: config.maxFailuresPerIp },
        config.windowSeconds,
      )
      if (!result.ok) return { allowed: false, scope: result.scope }
      return { allowed: true, identityIpCount: result.pairCount, ipCount: result.ipCount }
    },

    /**
     * Falha REAL de autenticação (identidade desconhecida/inativa ou senha errada): a vaga já foi
     * gasta na reserva, então aqui só se decide o ALERTA — pura, não escreve nada.
     */
    describeFailure(reservation: AuthReservation): AuthFailureOutcome {
      return {
        identityIpCount: reservation.identityIpCount,
        ipCount: reservation.ipCount,
        identityIpBlockedNow: reservation.identityIpCount === config.maxAttemptsPerIdentityIp,
        ipBlockedNow: reservation.ipCount === config.maxFailuresPerIp,
      }
    },

    /** Autenticação OK: zera o contador do PAR e devolve a vaga do global do IP (não o zera — ver cabeçalho). */
    async registerSuccess(attempt: AuthAttempt): Promise<void> {
      await Promise.all([store.del([identityIpKey(attempt)]), store.release([ipKey(attempt.ip)])])
    },

    /** Erro NOSSO no meio da avaliação (não é falha do carregador): devolve as duas vagas. */
    async release(attempt: AuthAttempt): Promise<void> {
      await store.release([identityIpKey(attempt), ipKey(attempt.ip)])
    },
  }
}

export type OcppAuthRateLimiter = ReturnType<typeof createOcppAuthRateLimiter>
