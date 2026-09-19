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
 * Puro em relação a I/O: o armazenamento entra por injeção (`ThrottleStore`) — testável sem Redis.
 */

export interface ThrottleStore {
  get(key: string): Promise<number>
  /** INCR atômico que define o TTL na criação da chave. Devolve o novo valor. */
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>
  /** Segundos restantes (0 se a chave não existe). */
  ttlSeconds(key: string): Promise<number>
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

export type LoginGate = { allowed: true } | { allowed: false; retryAfterSeconds: number }

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
    /** ANTES de verificar a senha: conta trancada = recusa (com o tempo restante para o `Retry-After`). */
    async check(email: string): Promise<LoginGate> {
      const remaining = await store.ttlSeconds(lockKey(email))
      return remaining > 0 ? { allowed: false, retryAfterSeconds: remaining } : { allowed: true }
    },

    /** Falha de autenticação de uma conta que EXISTE. Devolve se esta falha ATIVOU um trancamento (e por quanto) — para alertar. */
    async registerFailure(email: string): Promise<{ lockedNow: boolean; lockSeconds: number; failures: number }> {
      const failures = await store.incrWithTtl(failKey(email), config.windowSeconds)
      if (failures < config.maxFailures) return { lockedNow: false, lockSeconds: 0, failures }

      const strike = await store.incrWithTtl(strikesKey(email), config.strikesTtlSeconds)
      const lockSeconds = lockDurationSeconds(strike, config)
      await store.setWithTtl(lockKey(email), 1, lockSeconds)
      await store.del([failKey(email)]) // recomeça a contar depois do trancamento
      return { lockedNow: true, lockSeconds, failures }
    },

    /** Login OK: zera as falhas recentes (as reincidências continuam lembradas — não vale "limpar" o histórico acertando uma vez). */
    async registerSuccess(email: string): Promise<void> {
      await store.del([failKey(email)])
    },
  }
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>
