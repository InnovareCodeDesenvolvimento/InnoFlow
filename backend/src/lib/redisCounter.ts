import type Redis from 'ioredis'

/**
 * Primitivas ATÔMICAS de contador sobre o Redis (scripts Lua), compartilhadas pelo limite de
 * tentativas do gateway OCPP e pelo throttle de login.
 *
 * Por que Lua e não vários comandos: cada script roda inteiro, sem intercalar com outro cliente.
 * Isso importa em duas frentes:
 *  - `INCR` + `EXPIRE` em dois comandos separados: uma queda entre eles deixa a chave SEM TTL para
 *    sempre = bloqueio/contador permanente;
 *  - "ler o contador, decidir, incrementar" em comandos separados deixa uma RAJADA passar toda pelo
 *    portão (todas leem 0 antes de qualquer uma escrever). Aqui a decisão e o INCR são um passo só —
 *    é o que faz o limite valer sob concorrência (achado da Íris, 2026-09-19).
 */

const INCR_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`

export async function incrWithTtl(redis: Redis, key: string, ttlSeconds: number): Promise<number> {
  return Number(await redis.eval(INCR_WITH_TTL_SCRIPT, 1, key, String(ttlSeconds)))
}

/**
 * Reserva de tentativa do gateway OCPP. TRÊS contadores, com papéis diferentes:
 *  - par (identidade+IP): tentativas do par na janela. Sobe na reserva, FICA na falha, zera no sucesso;
 *  - falhas do IP: só falhas JÁ CONFIRMADAS (`settleFailure`), na janela. É o que protege o banco;
 *  - em andamento do IP: quantas tentativas estão avaliando (bcrypt) agora. Sobe na reserva e desce quando
 *    a avaliação termina, de qualquer jeito (sucesso, falha ou erro nosso). TTL curto e próprio: uma
 *    tentativa que morreu no meio (processo morto) não pode ocupar capacidade por minutos.
 * Por que separar: com um só contador do IP (falhas + em andamento) os 30 carregadores LEGÍTIMOS de um
 * mesmo NAT reconectando juntos ocupavam as 30 vagas de FALHA e os excedentes levavam 429 com a senha certa.
 * A rajada de tentativas ainda é limitada — pelo teto de concorrência, que o operador dimensiona para o
 * maior site atrás de um NAT; a falha extra que uma rajada pode produzir fica limitada a esse teto.
 *
 * A reserva só acontece se TODOS estão abaixo do limite — uma tentativa barrada não toca em chave nenhuma
 * (o flood contra um par trancado não incha o Redis nem estende o bloqueio). Ordem da recusa: falhas do IP
 * e concorrência do IP (ambas `scope: ip`, é o que protege o banco) antes do par.
 * KEYS = [par, falhasIp, andamentoIp]; ARGV = [maxPar, maxFalhasIp, maxAndamentoIp, ttlJanela, ttlAndamento].
 * Retorno: {status, contagemPar, falhasIp} (0 = reservou, 1 = barrado pelo IP, 2 = barrado pelo par).
 */
const RESERVE_ATTEMPT_SCRIPT = `
local fails = tonumber(redis.call('GET', KEYS[2]) or '0')
if fails >= tonumber(ARGV[2]) then return {1, 0, fails} end
local inflight = tonumber(redis.call('GET', KEYS[3]) or '0')
if inflight >= tonumber(ARGV[3]) then return {1, 0, fails} end
local pair = tonumber(redis.call('GET', KEYS[1]) or '0')
if pair >= tonumber(ARGV[1]) then return {2, pair, fails} end
pair = redis.call('INCR', KEYS[1])
if pair == 1 then redis.call('EXPIRE', KEYS[1], ARGV[4]) end
inflight = redis.call('INCR', KEYS[3])
if inflight == 1 then redis.call('EXPIRE', KEYS[3], ARGV[5]) end
return {0, pair, fails}
`

export type AttemptReservation = { ok: true; pairCount: number; ipFailures: number } | { ok: false; scope: 'identity_ip' | 'ip' }

export async function reserveAttempt(
  redis: Redis,
  keys: { pair: string; ipFailures: string; ipInflight: string },
  limits: { maxPair: number; maxIpFailures: number; maxIpInflight: number },
  ttls: { windowSeconds: number; inflightSeconds: number },
): Promise<AttemptReservation> {
  const [status, pairCount, ipFailures] = (await redis.eval(
    RESERVE_ATTEMPT_SCRIPT,
    3,
    keys.pair,
    keys.ipFailures,
    keys.ipInflight,
    String(limits.maxPair),
    String(limits.maxIpFailures),
    String(limits.maxIpInflight),
    String(ttls.windowSeconds),
    String(ttls.inflightSeconds),
  )) as number[]
  if (status === 1) return { ok: false, scope: 'ip' }
  if (status === 2) return { ok: false, scope: 'identity_ip' }
  return { ok: true, pairCount, ipFailures }
}

/**
 * Falha CONFIRMADA de uma tentativa reservada: conta a falha no IP (TTL da janela só na criação) e
 * devolve a vaga de "em andamento" — juntas, num passo só (uma queda entre as duas deixaria a tentativa
 * contada como em andamento E como falha, ou como nenhuma). Devolve as falhas do IP já com esta.
 * KEYS = [falhasIp, andamentoIp]; ARGV = [ttlJanela].
 */
const SETTLE_FAILURE_SCRIPT = `
local fails = redis.call('INCR', KEYS[1])
if fails == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local v = tonumber(redis.call('GET', KEYS[2]) or '0')
if v > 1 then redis.call('DECR', KEYS[2]) elseif v == 1 then redis.call('DEL', KEYS[2]) end
return fails
`

export async function settleAttemptFailure(redis: Redis, keys: { ipFailures: string; ipInflight: string }, windowSeconds: number): Promise<number> {
  return Number(await redis.eval(SETTLE_FAILURE_SCRIPT, 2, keys.ipFailures, keys.ipInflight, String(windowSeconds)))
}

/**
 * Reserva de tentativa de login de UMA conta: recusa se a conta está trancada (chave de lock com
 * TTL) ou se já há `max` tentativas reservadas na janela; senão INCR. Tudo num passo só — sem isso,
 * 40 logins em paralelo liam "não trancada" antes de a 1ª falha ser contada e as 40 eram avaliadas.
 * KEYS = [lock, falhas]; ARGV = [max, janela]. Retorno: {status, valor}
 * (0 = reservou (valor = contagem), 1 = trancada (valor = segundos restantes), 2 = cheia (valor = contagem)).
 */
const RESERVE_LOGIN_SCRIPT = `
local ttl = redis.call('TTL', KEYS[1])
if ttl > 0 then return {1, ttl} end
local n = tonumber(redis.call('GET', KEYS[2]) or '0')
if n >= tonumber(ARGV[1]) then return {2, n} end
n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
return {0, n}
`

export type LoginReservation = { status: 'ok'; count: number } | { status: 'locked'; retryAfterSeconds: number } | { status: 'full' }

export async function reserveLoginAttempt(redis: Redis, keys: { lock: string; failures: string }, maxFailures: number, windowSeconds: number): Promise<LoginReservation> {
  const [status, value] = (await redis.eval(RESERVE_LOGIN_SCRIPT, 2, keys.lock, keys.failures, String(maxFailures), String(windowSeconds))) as number[]
  if (status === 1) return { status: 'locked', retryAfterSeconds: value }
  if (status === 2) return { status: 'full' }
  return { status: 'ok', count: value }
}

/**
 * Devolve UMA reserva (`DECR`) de cada chave. Nunca deixa o contador negativo e nunca recria uma
 * chave que já expirou/foi zerada (um `DECR` cru numa chave inexistente cria `-1` SEM TTL — bloqueio
 * às avessas para sempre): chave ausente = nada a devolver; em 1, apaga (0 = ausente).
 */
const RELEASE_SCRIPT = `
for i = 1, #KEYS do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 1 then redis.call('DECR', KEYS[i]) elseif v == 1 then redis.call('DEL', KEYS[i]) end
end
return 1
`

export async function releaseReservations(redis: Redis, keys: string[]): Promise<void> {
  if (keys.length === 0) return
  await redis.eval(RELEASE_SCRIPT, keys.length, ...keys)
}
