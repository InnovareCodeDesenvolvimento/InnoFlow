/**
 * Dedupe/throttle dos avisos ao dono COMPARTILHADO entre api/ocpp/worker (Redis) com queda para memória. Ver `core/alertas/dedupe.ts`.
 *
 * Degradação: qualquer erro/prazo do Redis abre um disjuntor curto (`COOLDOWN_REDIS_MS`) — nesse tempo cai direto na memória do processo, sem nem
 * tentar o Redis (não empilha comando, não atrasa o aviso). Nunca lança: o aviso ao dono é o ÚLTIMO lugar onde uma falha de Redis pode derrubar algo.
 * Custo aceito da queda: cada processo dedupa só os seus avisos (pode chegar mais de um e-mail igual) — melhor repetir que calar.
 */
import { withDeadline } from '../withDeadline'
import {
  MemoriaDedupeStore,
  resultadoDaVaga,
  type DedupeStore,
  type ResultadoOcorrencia,
  type ResultadoVaga,
} from '../../core/alertas/dedupe'
import type { SeveridadeNotificacao } from '../../core/alertas/severidade'

/** O mínimo do cliente ioredis que usamos (facilita o duplo nos testes). */
export interface RedisMinimo {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

const PREFIXO = 'alert'
const PRAZO_REDIS_MS = 1_500
const COOLDOWN_REDIS_MS = 30_000
/** O contador de repetições sobrevive à janela (o próximo aviso, que pode vir horas depois, ainda informa quantas vezes ocorreu). */
const TTL_CONTADOR_SEGUNDOS = 24 * 3600
const TTL_VAGA_SEGUNDOS = 2 * 3600

/** KEYS[1]=cooldown KEYS[2]=contador; ARGV[1]=janela(s) ARGV[2]=ttl do contador. Devolve -1 (suprimido) ou o nº de repetições engolidas (avisar). */
const LUA_OCORRENCIA = `
local ok = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1])
if ok then
  local n = redis.call('GET', KEYS[2])
  redis.call('DEL', KEYS[2])
  if n then return tonumber(n) end
  return 0
end
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return -1
`

/** KEYS[1]=contador da hora; ARGV[1]=ttl. Devolve o contador depois do INCR. */
const LUA_VAGA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`

export class RedisDedupeStore implements DedupeStore {
  constructor(private readonly redis: RedisMinimo) {}

  async registrarOcorrencia(chave: string, janelaSegundos: number): Promise<ResultadoOcorrencia> {
    const r = Number(
      await withDeadline(
        this.redis.eval(LUA_OCORRENCIA, 2, `${PREFIXO}:cool:${chave}`, `${PREFIXO}:cnt:${chave}`, janelaSegundos, TTL_CONTADOR_SEGUNDOS),
        PRAZO_REDIS_MS,
        'dedupe de alerta',
      ),
    )
    if (!Number.isFinite(r)) throw new Error('resposta inesperada do Redis no dedupe de alerta')
    return r < 0 ? { avisar: false, suprimidas: 0 } : { avisar: true, suprimidas: r }
  }

  async reservarVagaPorHora(severidade: SeveridadeNotificacao, hora: string, limite: number): Promise<ResultadoVaga> {
    const n = Number(await withDeadline(this.redis.eval(LUA_VAGA, 1, `${PREFIXO}:cap:${severidade}:${hora}`, TTL_VAGA_SEGUNDOS), PRAZO_REDIS_MS, 'teto de alertas por hora'))
    if (!Number.isFinite(n)) throw new Error('resposta inesperada do Redis no teto de alertas')
    return resultadoDaVaga(n, limite)
  }
}

/** Redis primeiro; qualquer falha => memória (e disjuntor por `COOLDOWN_REDIS_MS`). `aoDegradar` é só para log (uma vez por abertura do disjuntor). */
export class DedupeStoreComFallback implements DedupeStore {
  private redisAteOk = 0

  constructor(
    private readonly redisStore: DedupeStore | null,
    private readonly memoria: DedupeStore = new MemoriaDedupeStore(),
    private readonly agora: () => number = Date.now,
    private readonly aoDegradar: (motivo: string) => void = () => {},
  ) {}

  private async tentar<T>(op: (s: DedupeStore) => Promise<T>): Promise<T> {
    if (this.redisStore && this.agora() >= this.redisAteOk) {
      try {
        return await op(this.redisStore)
      } catch (err) {
        this.redisAteOk = this.agora() + COOLDOWN_REDIS_MS
        try {
          this.aoDegradar(err instanceof Error ? err.message : 'erro')
        } catch {
          /* log do degradar nunca derruba */
        }
      }
    }
    return op(this.memoria)
  }

  registrarOcorrencia(chave: string, janelaSegundos: number): Promise<ResultadoOcorrencia> {
    return this.tentar((s) => s.registrarOcorrencia(chave, janelaSegundos))
  }

  reservarVagaPorHora(severidade: SeveridadeNotificacao, hora: string, limite: number): Promise<ResultadoVaga> {
    return this.tentar((s) => s.reservarVagaPorHora(severidade, hora, limite))
  }
}
