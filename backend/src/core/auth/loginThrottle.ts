import { createHash } from 'node:crypto'

/**
 * Throttle de falhas de login POR CONTA (e-mail), com backoff (Órion M7, 2026-09-19).
 *
 * O `authRateLimit` por IP não cobre o risco real: brute-force de uma conta ADMIN DISTRIBUÍDO por
 * vários IPs (cada IP dentro do limite dele). Aqui o balde é a CONTA, não o IP: depois de
 * `maxFailures` falhas na janela, a conta fica TRANCADA por um tempo que DOBRA a cada reincidência
 * (60s, 120s, 240s ... até `maxLockSeconds`), e uma tentativa durante o trancamento é recusada
 * mesmo com a senha certa (senão o atacante continuaria adivinhando durante o trancamento).
 *
 * Trade-off ASSUMIDO (o mesmo do lockout do carregador OCPP, mas aqui sem alternativa de "outro
 * IP"): quem sabe o e-mail de um ADMIN consegue trancá-lo por até `maxLockSeconds` gastando
 * `maxFailures` requisições por ciclo. É o preço de barrar o brute-force distribuído; o teto é curto
 * (15 min) e o trancamento é só de LOGIN POR SENHA (a sessão já aberta não cai; motorista tem o
 * Google). Falha do Redis = FAIL-OPEN (o login segue; a proteção por IP continua) — indisponibilidade
 * do Redis não pode tirar todo mundo do sistema.
 *
 * RESERVA ANTES DE AVALIAR (achado da Íris, 2026-09-19): o desenho "ler o trancamento -> bcrypt ->
 * só então contar a falha" decidia sobre um sinal INSTANTÂNEO (o estado de agora) enquanto a
 * contagem só acontecia depois do bcrypt: 15 logins errados em paralelo liam "não trancada" e os 15
 * eram avaliados. Agora `reserveAttempt` checa o trancamento E ocupa uma vaga num passo atômico
 * ANTES do trabalho caro; a falha só confirma (a vaga já foi gasta), o sucesso zera as falhas e um
 * erro nosso (banco fora do ar) devolve a vaga (`release`). O balde por IP (`loginRateLimit`,
 * express-rate-limit) já era assim: incrementa na ENTRADA da requisição e devolve no sucesso.
 *
 * Puro em relação a I/O: o armazenamento entra por injeção (`ThrottleStore`) — testável sem Redis.
 */

export type ReserveResult = { status: 'ok'; count: number } | { status: 'locked'; retryAfterSeconds: number } | { status: 'full' }

export interface ThrottleStore {
  /**
   * ATÔMICO: conta trancada -> `locked`; já há `maxFailures` tentativas reservadas na janela ->
   * `full`; senão INCR (TTL na criação) e devolve a contagem. `locked`/`full` não escrevem nada.
   */
  reserve(keys: { lock: string; failures: string }, maxFailures: number, windowSeconds: number): Promise<ReserveResult>
  /** Devolve UMA reserva da chave (nunca negativa, nunca recria chave ausente). */
  release(key: string): Promise<void>
  /** INCR atômico que define o TTL na criação da chave. Devolve o novo valor. */
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>
  setWithTtl(key: string, value: number, ttlSeconds: number): Promise<void>
  del(keys: string[]): Promise<void>
}

export interface LoginThrottleConfig {
  /** Falhas dentro da janela até trancar. */
  maxFailures: number
  windowSeconds: number
  /** 1º trancamento; dobra a cada reincidência. */
  baseLockSeconds: number
  maxLockSeconds: number
  /** Por quanto tempo o contador de reincidências ("strikes") lembra. */
  strikesTtlSeconds: number
}

export const DEFAULT_LOGIN_THROTTLE: LoginThrottleConfig = {
  maxFailures: 5,
  windowSeconds: 15 * 60,
  baseLockSeconds: 60,
  maxLockSeconds: 15 * 60,
  strikesTtlSeconds: 24 * 60 * 60,
}

/**
 * `allowed: true` traz a contagem da vaga RESERVADA (`failures`); ausente = não houve reserva
 * (Redis fora do ar, fail-open) e a falha, se vier, é contada à moda antiga (`incrWithTtl`).
 */
export type LoginGate = { allowed: true; failures?: number } | { allowed: false; retryAfterSeconds: number }

/** Chave da conta: e-mail normalizado (minúsculas — `/login` casa sem distinguir caixa) e hasheado (tamanho fixo, nada de e-mail em claro no Redis). */
function accountId(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)
}
const failKey = (email: string): string => `login:fail:${accountId(email)}`
const lockKey = (email: string): string => `login:lock:${accountId(email)}`
const strikesKey = (email: string): string => `login:strikes:${accountId(email)}`

/** Duração do n-ésimo trancamento (strike 1 = base, 2 = 2x, ...), com teto. Pura — testada à parte. */
export function lockDurationSeconds(strike: number, config: LoginThrottleConfig): number {
  const exponent = Math.max(0, strike - 1)
  return Math.min(config.baseLockSeconds * 2 ** exponent, config.maxLockSeconds)
}

export function createLoginThrottle(store: ThrottleStore, config: LoginThrottleConfig = DEFAULT_LOGIN_THROTTLE) {
  return {
    /**
     * ANTES de verificar a senha: RESERVA uma vaga de tentativa (atômico). Conta trancada = recusa
     * (com o tempo restante para o `Retry-After`) mesmo com a senha certa. Já há `maxFailures`
     * tentativas em andamento e a conta ainda não trancou (a última está no bcrypt) = recusa
     * também, com `baseLockSeconds` de sugestão — sem isto uma rajada paralela lia "não trancada"
     * em todas as tentativas e as N eram avaliadas (a decisão era sobre um sinal instantâneo; a
     * contagem só vinha depois do bcrypt). Recusa NÃO escreve nada no Redis.
     */
    async reserveAttempt(email: string): Promise<LoginGate> {
      const result = await store.reserve({ lock: lockKey(email), failures: failKey(email) }, config.maxFailures, config.windowSeconds)
      if (result.status === 'locked') return { allowed: false, retryAfterSeconds: result.retryAfterSeconds }
      if (result.status === 'full') return { allowed: false, retryAfterSeconds: config.baseLockSeconds }
      return { allowed: true, failures: result.count }
    },

    /**
     * Falha de autenticação (conta que EXISTE ou não — a resposta é uniforme). A vaga já foi gasta
     * na reserva (`reservedFailures`); sem reserva (fail-open) conta agora. Devolve se esta falha
     * ATIVOU um trancamento (e por quanto) — para alertar.
     */
    async registerFailure(email: string, reservedFailures?: number): Promise<{ lockedNow: boolean; lockSeconds: number; failures: number }> {
      const failures = reservedFailures ?? (await store.incrWithTtl(failKey(email), config.windowSeconds))
      if (failures < config.maxFailures) return { lockedNow: false, lockSeconds: 0, failures }

      const strike = await store.incrWithTtl(strikesKey(email), config.strikesTtlSeconds)
      const lockSeconds = lockDurationSeconds(strike, config)
      await store.setWithTtl(lockKey(email), 1, lockSeconds)
      await store.del([failKey(email)]) // recomeça a contar depois do trancamento
      return { lockedNow: true, lockSeconds, failures }
    },

    /** Login OK: zera as falhas recentes (as reincidências continuam lembradas — não vale "limpar" o histórico acertando uma vez). Zera também a vaga desta tentativa. */
    async registerSuccess(email: string): Promise<void> {
      await store.del([failKey(email)])
    },

    /** Erro NOSSO no meio da avaliação (banco fora do ar, p.ex.) — não é falha do usuário: devolve a vaga. */
    async release(email: string): Promise<void> {
      await store.release(failKey(email))
    },
  }
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>
