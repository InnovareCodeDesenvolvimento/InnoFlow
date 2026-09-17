import { createRedisConnection } from '../lib/redis'
import { env } from '../lib/env'

/**
 * Rate limit de tentativas de autenticação do gateway OCPP — achado
 * "importante" da auditoria do Órion (2026-09-17): `authenticateChargePoint`
 * (`server.ts`) não tinha nenhum limite, então um atacante podia tentar
 * senhas Basic Auth infinitamente contra qualquer `ocppIdentity` conhecida.
 *
 * Contador em REDIS (não em memória do processo) pelo mesmo motivo do lock
 * anti-split-brain de `registry.ts`: o gateway não tem por que continuar
 * limitado a 1 réplica para sempre, e o estado de tentativas precisa
 * sobreviver a um restart do processo (reiniciar o gateway não pode zerar
 * o contador de um ataque em andamento).
 *
 * Escopo: por IDENTITY, não por IP — o handshake do `ocpp-rpc` já entrega
 * `handshake.identity` antes de qualquer verificação de senha, e escopar por
 * IP puniria uma frota inteira atrás do mesmo NAT/proxy por causa de UM
 * carregador com credencial comprometida. Trade-off aceito (documentado
 * para a próxima auditoria): um atacante que enumera identidades novas a
 * cada tentativa contorna o limite por identity — mitigar isso exigiria um
 * limite GLOBAL adicional por IP, fora de escopo desta correção.
 */

const redisCmd = createRedisConnection()

const rateLimitKey = (identity: string): string => `ocpp:auth:fail:${identity}`

/** Verifica ANTES de gastar um bcrypt.compare — bloqueia mesmo tentativas com senha certa se a janela já estourou (a credencial pode ter vazado). */
export async function isAuthRateLimited(identity: string): Promise<boolean> {
  const count = await redisCmd.get(rateLimitKey(identity))
  return count !== null && Number(count) >= env.OCPP_AUTH_RATE_LIMIT_MAX_ATTEMPTS
}

/**
 * Chamar só quando a autenticação FALHOU (identity desconhecida/inativa OU
 * senha incorreta) — sucesso não reseta o contador de propósito: um
 * atacante que acerta a senha depois de várias tentativas erradas não devia
 * "limpar" o histórico dentro da mesma janela.
 */
export async function registerAuthFailure(identity: string): Promise<number> {
  const key = rateLimitKey(identity)
  const count = await redisCmd.incr(key)
  if (count === 1) {
    await redisCmd.expire(key, env.OCPP_AUTH_RATE_LIMIT_WINDOW_SECONDS)
  }
  return count
}
