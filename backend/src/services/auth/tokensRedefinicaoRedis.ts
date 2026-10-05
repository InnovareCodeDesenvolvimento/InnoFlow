import type Redis from 'ioredis'
import { gerarTokenRedefinicao, hashDoToken, TTL_TOKEN_REDEFINICAO_SEGUNDOS } from '../../core/auth/redefinicaoSenha'

/**
 * Armazém dos tokens de redefinição de senha (L1.3) sobre o Redis. DESENHO:
 *  - `pwdreset:{sha256(token)}` -> `{ userId, emitidoEm, impressao }` com TTL. O token em claro NUNCA é gravado (nem no valor, nem na chave): um dump do Redis não dá
 *    link utilizável. O valor também não leva e-mail (só ids/hash);
 *  - `pwdreset:user:{userId}` -> hash do ÚLTIMO token emitido (mesmo TTL): pedir de novo invalida o anterior (um ativo por usuário);
 *  - consumo = ler e apagar num passo só (script Lua: o equivalente de `GETDEL`, que só existe no Redis >= 6.2; o script roda em qualquer versão e é igualmente atômico):
 *    duas requisições simultâneas com o mesmo token => exatamente UMA recebe o valor.
 * Os scripts usam o prefixo recebido em ARGV (chaves derivadas dentro do script) — vale para Redis standalone (o deste projeto), não para cluster.
 */

const PREFIXO_TOKEN = 'pwdreset:'
const PREFIXO_USUARIO = 'pwdreset:user:'

export interface ValorDoToken {
  userId: string
  /** Epoch ms da emissão. */
  emitidoEm: number
  /** `impressaoDaSenha(passwordHash)` no momento do pedido. */
  impressao: string
}

export interface PortaDeTokensDeRedefinicao {
  /** Gera um token NOVO, grava só o hash e invalida o token anterior do mesmo usuário. Devolve o token em claro (só para ir ao link do e-mail). */
  emitir(userId: string, impressao: string): Promise<string>
  /** Lê e APAGA (uso único, atômico). `null` = inexistente/expirado/já usado. */
  consumir(token: string): Promise<ValorDoToken | null>
  /** Devolve um token consumido cuja operação FALHOU por erro nosso (banco fora) — só se ainda for o último do usuário e ainda houver vida. Melhor esforço. */
  devolver(token: string, valor: ValorDoToken): Promise<void>
}

const EMITIR = `
local anterior = redis.call('GET', KEYS[2])
if anterior and anterior ~= ARGV[3] then redis.call('DEL', ARGV[4] .. anterior) end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
return 1
`

const CONSUMIR = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`

const DEVOLVER = `
if redis.call('GET', KEYS[2]) ~= ARGV[3] then return 0 end
return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX') and 1 or 0
`

function valorValido(bruto: unknown): ValorDoToken | null {
  if (typeof bruto !== 'object' || bruto === null) return null
  const v = bruto as Record<string, unknown>
  if (typeof v.userId !== 'string' || typeof v.emitidoEm !== 'number' || typeof v.impressao !== 'string') return null
  return { userId: v.userId, emitidoEm: v.emitidoEm, impressao: v.impressao }
}

export function criarTokensDeRedefinicaoRedis(redis: Redis, opcoes: { ttlSegundos?: number; agora?: () => number } = {}): PortaDeTokensDeRedefinicao {
  const ttl = opcoes.ttlSegundos ?? TTL_TOKEN_REDEFINICAO_SEGUNDOS
  const agora = opcoes.agora ?? Date.now
  return {
    async emitir(userId, impressao) {
      const token = gerarTokenRedefinicao()
      const hash = hashDoToken(token)
      const valor: ValorDoToken = { userId, emitidoEm: agora(), impressao }
      await redis.eval(EMITIR, 2, `${PREFIXO_TOKEN}${hash}`, `${PREFIXO_USUARIO}${userId}`, JSON.stringify(valor), String(ttl), hash, PREFIXO_TOKEN)
      return token
    },

    async consumir(token) {
      const bruto = await redis.eval(CONSUMIR, 1, `${PREFIXO_TOKEN}${hashDoToken(token)}`)
      if (typeof bruto !== 'string') return null
      try {
        return valorValido(JSON.parse(bruto))
      } catch {
        return null
      }
    },

    async devolver(token, valor) {
      const restante = Math.floor(ttl - (agora() - valor.emitidoEm) / 1000)
      if (restante < 5) return
      const hash = hashDoToken(token)
      await redis.eval(DEVOLVER, 2, `${PREFIXO_TOKEN}${hash}`, `${PREFIXO_USUARIO}${valor.userId}`, JSON.stringify(valor), String(restante), hash)
    },
  }
}
