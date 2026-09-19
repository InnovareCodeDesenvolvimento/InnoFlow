/**
 * Teto de streams SSE simultâneos (Órion A2, 2026-09-19): sem teto, qualquer conta cadastrada
 * abria conexões longas sem limite (o `publicRateLimit`/`adminRateLimit` contam REQUISIÇÕES, não
 * duração) — exaustão de descritores/memória do processo da API.
 *
 * Três tetos, com política diferente de propósito:
 *  - por USUÁRIO: quando estoura, EXPULSA o stream mais antigo do próprio usuário e aceita o novo.
 *    Rejeitar o novo trancaria o motorista fora depois de trocar de rede no celular — a conexão
 *    velha fica "zumbi" (sem FIN) até o TCP desistir, minutos depois. Expulsar a mais antiga
 *    mantém o teto e nunca pune quem só reconectou.
 *  - por IP: REJEITA o novo (429). Expulsar aqui derrubaria OUTROS usuários atrás do mesmo NAT.
 *    Teto generoso (várias pessoas num mesmo IP de garagem/empresa).
 *  - total do processo: REJEITA o novo (503) — trava de sanidade contra exaustão global.
 *
 * Puro (sem timers/rede): quem abre o stream diz quando encerrar via `close()` injetado.
 */

export interface StreamLimits {
  perUser: number
  perIp: number
  total: number
}

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'IP_LIMIT' | 'TOTAL_LIMIT' }

interface Slot {
  userId: string
  ip: string
  close: () => void
}

export function createStreamLimiter(limits: StreamLimits) {
  const slots = new Set<Slot>() // ordem de inserção = do mais antigo para o mais novo

  const countBy = (pick: (s: Slot) => string, value: string): number => {
    let n = 0
    for (const s of slots) if (pick(s) === value) n++
    return n
  }

  return {
    /** `close` é chamado se este stream for EXPULSO pelo teto por usuário. */
    acquire(userId: string, ip: string, close: () => void): AcquireResult {
      if (slots.size >= limits.total) return { ok: false, reason: 'TOTAL_LIMIT' }
      if (countBy((s) => s.ip, ip) >= limits.perIp) return { ok: false, reason: 'IP_LIMIT' }

      // Expulsa os MAIS ANTIGOS do usuário até sobrar lugar para o novo.
      while (countBy((s) => s.userId, userId) >= limits.perUser) {
        const oldest = [...slots].find((s) => s.userId === userId)
        if (!oldest) break
        slots.delete(oldest)
        try {
          oldest.close()
        } catch {
          // fechar um stream já morto não pode impedir o novo
        }
      }

      const slot: Slot = { userId, ip, close }
      slots.add(slot)
      return { ok: true, release: () => void slots.delete(slot) }
    },

    stats() {
      return { total: slots.size }
    },
  }
}

export type StreamLimiter = ReturnType<typeof createStreamLimiter>
