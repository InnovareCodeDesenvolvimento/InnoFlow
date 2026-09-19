import { createHash } from 'node:crypto'

/**
 * Limite de tentativas de autenticação do gateway OCPP (Órion A1, 2026-09-19).
 *
 * O desenho anterior contava falhas só por `ocppIdentity` — e a identidade é PÚBLICA
 * (`GET /api/sites` devolve `ocppIdentity` de todo carregador): qualquer um errava 5 senhas e o
 * carregador REAL, com a credencial certa, tomava 429 por 5 min (lockout provado pelo Órion).
 * Agora dois contadores independentes, ambos só de FALHAS:
 *
 *  1. (identidade + IP) — barra a adivinhação de senha contra uma identidade, mas só a partir
 *     do IP de quem errou: o atacante trava o SEU par, nunca o carregador legítimo (outro IP).
 *     É zerado quando a autenticação DÁ CERTO (o carregador real não acumula falhas antigas).
 *  2. global por IP — barra o flood (identidade inexistente, hoje cada tentativa vira consulta
 *     ao banco + bcrypt sem freio). NÃO é zerado por sucesso (senão um IP intercalaria sucesso
 *     e falha para nunca estourar); só expira pela janela.
 *
 * Toda a decisão é pura e o armazenamento é injetado (`AuthCounterStore`) — testável sem Redis.
 */

export interface AuthCounterStore {
  /** Valores atuais (0 se a chave não existe), na ordem das chaves. */
  getMany(keys: string[]): Promise<number[]>
  /** INCR atômico que define o TTL na criação da chave. Devolve o novo valor. */
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>
  del(keys: string[]): Promise<void>
}

export interface AuthRateLimitConfig {
  /** Falhas do par (identidade + IP) na janela até bloquear. */
  maxAttemptsPerIdentityIp: number
  /** Falhas de um IP (qualquer identidade) na janela até bloquear. */
  maxFailuresPerIp: number
  windowSeconds: number
}

export interface AuthAttempt {
  identity: string
  ip: string
}

export type AuthBlockScope = 'identity_ip' | 'ip'

export type AuthGate = { allowed: true } | { allowed: false; scope: AuthBlockScope }

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
    /** Checa ANTES de qualquer consulta ao banco/bcrypt. O global do IP tem precedência (é o que protege o banco). */
    async check(attempt: AuthAttempt): Promise<AuthGate> {
      const [identityIpCount, ipCount] = await store.getMany([identityIpKey(attempt), ipKey(attempt.ip)])
      if (ipCount >= config.maxFailuresPerIp) return { allowed: false, scope: 'ip' }
      if (identityIpCount >= config.maxAttemptsPerIdentityIp) return { allowed: false, scope: 'identity_ip' }
      return { allowed: true }
    },

    /** Só para FALHA real de autenticação (identidade desconhecida/inativa ou senha errada). Tentativa bloqueada NÃO chama isto (não cria chave nova). */
    async registerFailure(attempt: AuthAttempt): Promise<AuthFailureOutcome> {
      const [identityIpCount, ipCount] = await Promise.all([
        store.incrWithTtl(identityIpKey(attempt), config.windowSeconds),
        store.incrWithTtl(ipKey(attempt.ip), config.windowSeconds),
      ])
      return {
        identityIpCount,
        ipCount,
        identityIpBlockedNow: identityIpCount === config.maxAttemptsPerIdentityIp,
        ipBlockedNow: ipCount === config.maxFailuresPerIp,
      }
    },

    /** Autenticação OK: zera o contador do PAR (não o global do IP — ver cabeçalho). */
    async clearFailures(attempt: AuthAttempt): Promise<void> {
      await store.del([identityIpKey(attempt)])
    },
  }
}

export type OcppAuthRateLimiter = ReturnType<typeof createOcppAuthRateLimiter>
