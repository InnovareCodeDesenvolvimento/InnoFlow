import { createHash } from 'node:crypto'

/**
 * Limite de tentativas de autenticação do gateway OCPP (Órion A1, 2026-09-19; reserva antes de
 * avaliar: Íris/Vega, 2026-09-19; teto de concorrência separado do de falhas: Íris/Vega, 2026-09-19).
 *
 * O desenho anterior contava falhas só por `ocppIdentity` — e a identidade é PÚBLICA
 * (`GET /api/sites` devolve `ocppIdentity` de todo carregador): qualquer um errava 5 senhas e o
 * carregador REAL, com a credencial certa, tomava 429 por 5 min (lockout provado pelo Órion).
 * Agora há três contadores, cada um com um papel:
 *
 *  1. (identidade + IP) — barra a adivinhação de senha contra uma identidade, mas só a partir
 *     do IP de quem errou: o atacante trava o SEU par, nunca o carregador legítimo (outro IP).
 *     É zerado quando a autenticação DÁ CERTO (o carregador real não acumula falhas antigas).
 *  2. falhas do IP — barra o flood (identidade inexistente, hoje cada tentativa vira consulta
 *     ao banco + bcrypt sem freio). Conta SÓ falhas confirmadas: o sucesso nunca entra aqui. NÃO é
 *     zerado por sucesso (senão um IP intercalaria sucesso e falha para nunca estourar); só expira
 *     pela janela.
 *  3. em andamento do IP — quantas tentativas estão avaliando (banco + bcrypt) AGORA. Barra a
 *     rajada de concorrência (é o que impede N handshakes paralelos de fazer N consultas antes de a
 *     primeira falha ser contada) sem tratar tentativa em andamento como falha.
 *
 * RESERVA ANTES DE AVALIAR (causa raiz do furo de concorrência): o desenho "ler o contador ->
 * consultar o banco/bcrypt -> só então contar a falha" deixava uma rajada de N handshakes paralelos
 * ler 0 em todas as N tentativas: 40 paralelas com limite 5 avaliaram 40 e barraram 0. A decisão
 * era tomada sobre um sinal instantâneo (o contador de agora), enquanto a contagem só acontecia
 * ~250 ms depois (bcrypt). Agora `reserve` decide E conta num passo atômico ANTES de qualquer
 * trabalho caro: cada tentativa em andamento já ocupa uma vaga do PAR e uma de "em andamento".
 *
 * A vaga de "em andamento" NÃO pode ser a mesma das falhas do IP (a 1ª versão da reserva era): com
 * bcrypt de custo 12 as tentativas duram centenas de ms e se sobrepõem, então os 30 carregadores
 * LEGÍTIMOS de um mesmo NAT reconectando juntos (restart do gateway) ocupavam as 30 vagas de falha e
 * os excedentes levavam 429 com a senha certa e zero falha — contra a regra "o sucesso não conta como
 * falha". Custo aceito da separação: uma rajada de tentativas que FALHAM pode produzir até
 * `maxConcurrentPerIp` falhas de uma vez (todas avaliadas antes de a 1ª ser contada) em vez de parar
 * exatamente em `maxFailuresPerIp`; depois disso o IP fica bloqueado pela janela inteira. O teto de
 * concorrência é o botão que troca folga para frotas atrás de NAT por rigor contra rajada.
 *
 * O resultado depois da reserva:
 *  - falha (identidade desconhecida/inativa ou senha errada): `registerFailure` conta a falha no IP e
 *    devolve a vaga de "em andamento"; a vaga do par fica gasta (é a falha);
 *  - sucesso: `registerSuccess` zera o par e devolve a vaga de "em andamento" (o sucesso não conta como
 *    falha nem zera as falhas alheias daquele IP);
 *  - erro inesperado no meio (banco fora do ar, p.ex.): `release` devolve a vaga do par e a de "em
 *    andamento" — a indisponibilidade NOSSA não pode virar lockout do carregador.
 *
 * Toda a decisão é pura e o armazenamento é injetado (`AuthCounterStore`) — testável sem Redis.
 */

/** TTL do contador "em andamento": uma tentativa dura segundos; se o processo morrer no meio, a vaga se libera sozinha logo. */
export const IN_FLIGHT_TTL_SECONDS = 60

export interface AuthCounterKeys {
  pair: string
  ipFailures: string
  ipInflight: string
}

export interface AuthCounterStore {
  /**
   * ATÔMICO: se o par, as falhas do IP e a concorrência do IP estão abaixo dos limites, incrementa o par e
   * o "em andamento" (TTL na criação) e devolve o par novo e as falhas do IP (sem esta tentativa); senão
   * devolve qual barrou e NÃO toca em chave nenhuma.
   */
  reserve(
    keys: AuthCounterKeys,
    limits: { maxPair: number; maxIpFailures: number; maxIpInflight: number },
    ttls: { windowSeconds: number; inflightSeconds: number },
  ): Promise<{ ok: true; pairCount: number; ipFailures: number } | { ok: false; scope: AuthBlockScope }>
  /** ATÔMICO: conta UMA falha no IP (TTL da janela na criação) e devolve uma vaga de "em andamento". Devolve as falhas do IP já com esta. */
  settleFailure(keys: { ipFailures: string; ipInflight: string }, windowSeconds: number): Promise<number>
  /** Devolve UMA reserva de cada chave (nunca negativa, nunca recria chave ausente). */
  release(keys: string[]): Promise<void>
  del(keys: string[]): Promise<void>
}

export interface AuthRateLimitConfig {
  /** Tentativas do par (identidade + IP) na janela até bloquear. */
  maxAttemptsPerIdentityIp: number
  /** FALHAS de um IP (qualquer identidade) na janela até bloquear. */
  maxFailuresPerIp: number
  /**
   * Tentativas de um IP em andamento ao mesmo tempo (frota atrás de NAT reconectando junta). Sem valor =
   * `maxFailuresPerIp` (o comportamento rígido anterior: tentativa em andamento ocupa vaga de falha).
   */
  maxConcurrentPerIp?: number
  windowSeconds: number
}

export interface AuthAttempt {
  identity: string
  ip: string
}

export type AuthBlockScope = 'identity_ip' | 'ip'

/** A vaga reservada por uma tentativa em andamento, com os contadores no instante da reserva. */
export interface AuthReservation {
  /** Tentativas do par, contando esta. */
  identityIpCount: number
  /** Falhas do IP no instante da reserva (esta tentativa NÃO conta: só vira falha em `registerFailure`). */
  ipFailureCount: number
}

export type AuthGate = ({ allowed: true } & AuthReservation) | { allowed: false; scope: AuthBlockScope }

export interface AuthFailureOutcome {
  identityIpCount: number
  /** Falhas do IP na janela, já contando esta. */
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
const ipFailuresKey = (ip: string): string => `ocpp:auth:fail:ip:${ip}`
// Prefixo `inflight` (não `fail`): não é falha, e quem varre `ocpp:auth:fail:*` para diagnosticar/limpar não o confunde com uma.
const ipInflightKey = (ip: string): string => `ocpp:auth:inflight:ip:${ip}`

export function createOcppAuthRateLimiter(store: AuthCounterStore, config: AuthRateLimitConfig) {
  const maxConcurrentPerIp = config.maxConcurrentPerIp ?? config.maxFailuresPerIp
  return {
    /**
     * Reserva a tentativa ANTES de qualquer consulta ao banco/bcrypt. Barrada = não escreve nada.
     * O IP (falhas e concorrência) tem precedência sobre o par (é o que protege o banco).
     */
    async reserve(attempt: AuthAttempt): Promise<AuthGate> {
      const result = await store.reserve(
        { pair: identityIpKey(attempt), ipFailures: ipFailuresKey(attempt.ip), ipInflight: ipInflightKey(attempt.ip) },
        { maxPair: config.maxAttemptsPerIdentityIp, maxIpFailures: config.maxFailuresPerIp, maxIpInflight: maxConcurrentPerIp },
        { windowSeconds: config.windowSeconds, inflightSeconds: IN_FLIGHT_TTL_SECONDS },
      )
      if (!result.ok) return { allowed: false, scope: result.scope }
      return { allowed: true, identityIpCount: result.pairCount, ipFailureCount: result.ipFailures }
    },

    /**
     * Falha REAL de autenticação (identidade desconhecida/inativa ou senha errada): a vaga do par já foi
     * gasta na reserva; aqui se conta a falha no IP, se devolve a vaga de "em andamento" e se decide o ALERTA.
     */
    async registerFailure(attempt: AuthAttempt, reservation: AuthReservation): Promise<AuthFailureOutcome> {
      const ipFailures = await store.settleFailure({ ipFailures: ipFailuresKey(attempt.ip), ipInflight: ipInflightKey(attempt.ip) }, config.windowSeconds)
      return {
        identityIpCount: reservation.identityIpCount,
        ipCount: ipFailures,
        identityIpBlockedNow: reservation.identityIpCount === config.maxAttemptsPerIdentityIp,
        ipBlockedNow: ipFailures === config.maxFailuresPerIp,
      }
    },

    /** Autenticação OK: zera o contador do PAR e devolve a vaga de "em andamento" (as falhas do IP ficam — ver cabeçalho). */
    async registerSuccess(attempt: AuthAttempt): Promise<void> {
      await Promise.all([store.del([identityIpKey(attempt)]), store.release([ipInflightKey(attempt.ip)])])
    },

    /** Erro NOSSO no meio da avaliação (não é falha do carregador): devolve a vaga do par e a de "em andamento". */
    async release(attempt: AuthAttempt): Promise<void> {
      await store.release([identityIpKey(attempt), ipInflightKey(attempt.ip)])
    },
  }
}

export type OcppAuthRateLimiter = ReturnType<typeof createOcppAuthRateLimiter>
