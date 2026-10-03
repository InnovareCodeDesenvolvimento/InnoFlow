import { randomUUID } from 'node:crypto'
import type Redis from 'ioredis'

/**
 * Lock exclusivo com TTL sobre o Redis (SET NX PX + token). O TTL é a rede de segurança: o dono que morre no meio
 * (processo morto, deploy) NÃO deixa o recurso preso para sempre — a chave expira sozinha.
 *
 * O token existe para o `liberar` não apagar o lock de OUTRO: se o TTL expirou durante o trabalho e um segundo dono já
 * pegou, apagar "a chave" liberaria o lock dele. Comparar-e-apagar tem de ser UM passo (Lua) — GET + DEL separados
 * deixam outro cliente adquirir entre os dois.
 */

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

/** Devolve o token do dono (guarde-o para liberar) ou `null` se outro já segura o lock. Erro de Redis PROPAGA (quem chama decide: falha fechada). */
export async function adquirirLock(redis: Redis, chave: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID()
  return (await redis.set(chave, token, 'PX', ttlMs, 'NX')) === 'OK' ? token : null
}

/** Libera só se o lock ainda é do `token`. Retorna `false` quando já expirou/foi de outro (nada apagado). */
export async function liberarLock(redis: Redis, chave: string, token: string): Promise<boolean> {
  return Number(await redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, chave, token)) === 1
}
