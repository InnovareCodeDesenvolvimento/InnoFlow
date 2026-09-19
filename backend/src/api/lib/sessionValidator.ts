import { avaliarSessao, type AfirmacoesDoToken, type ResultadoSessao, type UsuarioParaSessao } from '../../core/auth/sessaoValida'

/**
 * Validador de sessão com CACHE curto em memória por usuário — o `authenticate` roda em toda
 * request; bater no banco em cada uma seria um custo novo e desnecessário.
 *
 * TRADE-OFF (documentado, decisão do Atlas): revogação (desativar conta, trocar senha, vincular
 * Google, mudar papel) vale em até `ttlMs` (30s) em OUTRAS instâncias/processos. No processo que
 * FEZ a mudança, `invalidate(userId)` derruba o cache na hora — a troca de senha do próprio
 * usuário e o `set-password` na mesma instância valem imediatamente. Com 1 réplica da API (hoje)
 * isso cobre tudo; com N réplicas, o pior caso é 30s.
 *
 * Fábrica com dependências injetadas (`load`, `now`) para testar TTL/coalescência sem banco.
 */

export interface SessionValidatorOptions {
  load: (userId: string) => Promise<UsuarioParaSessao | null>
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

interface Entry {
  user: UsuarioParaSessao | null
  cachedAt: number
}

export interface SessionValidator {
  validate(userId: string, token: AfirmacoesDoToken): Promise<ResultadoSessao>
  invalidate(userId: string): void
  clear(): void
}

export function createSessionValidator(options: SessionValidatorOptions): SessionValidator {
  const ttlMs = options.ttlMs ?? 30_000
  const maxEntries = options.maxEntries ?? 10_000
  const now = options.now ?? Date.now
  const cache = new Map<string, Entry>()
  // Várias requests simultâneas do mesmo usuário no vencimento do cache = UMA consulta.
  const inflight = new Map<string, Promise<UsuarioParaSessao | null>>()

  async function getUser(userId: string): Promise<UsuarioParaSessao | null> {
    const hit = cache.get(userId)
    if (hit && now() - hit.cachedAt < ttlMs) return hit.user

    const pending = inflight.get(userId)
    if (pending) return pending

    const promise = options
      .load(userId)
      .then((user) => {
        if (cache.size >= maxEntries) cache.clear() // teto de memória: limpar tudo é simples e seguro (só custa reconsultas)
        cache.set(userId, { user, cachedAt: now() })
        return user
      })
      .finally(() => inflight.delete(userId))
    inflight.set(userId, promise)
    return promise
  }

  return {
    async validate(userId, token) {
      return avaliarSessao(token, await getUser(userId))
    },
    invalidate(userId) {
      cache.delete(userId)
    },
    clear() {
      cache.clear()
    },
  }
}
