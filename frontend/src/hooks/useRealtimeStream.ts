import { useEffect, useRef } from "react"
import { API_BASE_URL, TOKEN_STORAGE_KEY } from "@/services/api"
import { useRealtimeStore } from "@/store/realtimeStore"
import { extractSseData, splitSseEvents } from "@/lib/sse"
import type { RealtimeEvent } from "@/types/api"

/**
 * Sem heartbeat/evento nenhum nesse tempo, considera o stream morto mesmo que
 * a conexão TCP pareça viva (rádio dormindo, iOS suspendendo o PWA, proxy
 * segurando o buffer) — gatilho da Nova: "~30-40s sem sinal = morto".
 */
const HEARTBEAT_TIMEOUT_MS = 35_000
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

/**
 * Cliente SSE via `fetch` + `ReadableStream` (NÃO `EventSource` nativo — não
 * manda header `Authorization` custom, ver decisoes-tempo-real-sse.md item 4).
 * Reconecta sozinho com backoff exponencial e usa um "watchdog" de heartbeat:
 * se nada chegar por `HEARTBEAT_TIMEOUT_MS`, força reconexão mesmo sem erro
 * de rede — é exatamente o jeito como esse tipo de conexão morre "em
 * silêncio". O polling de cada tela consulta `useRealtimeHealthy()`
 * (`store/realtimeStore.ts`) pra saber se pode relaxar o próprio intervalo.
 *
 * `path`: `null` desliga a conexão (ex.: usuário deslogado, papel sem canal).
 * `onEvent`: chamado a cada evento de negócio (não a cada heartbeat).
 */
export function useRealtimeStream(path: string | null, onEvent: (event: RealtimeEvent) => void) {
  const onEventRef = useRef(onEvent)
  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    if (!path) {
      useRealtimeStore.getState().reset()
      return
    }

    let stopped = false
    let controller: AbortController | null = null
    let backoff = BASE_BACKOFF_MS
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    async function connectOnce() {
      controller = new AbortController()
      const token = localStorage.getItem(TOKEN_STORAGE_KEY)
      const url = new URL(path as string, API_BASE_URL || window.location.origin)

      try {
        const response = await fetch(url.toString(), {
          headers: { Authorization: token ? `Bearer ${token}` : "", Accept: "text/event-stream" },
          signal: controller.signal,
        })
        if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`)

        backoff = BASE_BACKOFF_MS // conectou de verdade — zera o backoff pra próxima queda
        useRealtimeStore.getState().markConnected()

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (!stopped) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const { events, rest } = splitSseEvents(buffer)
          buffer = rest
          for (const raw of events) {
            useRealtimeStore.getState().markEvent()
            const data = extractSseData(raw)
            if (!data) continue // heartbeat/comentário puro — só prova que está vivo
            try {
              onEventRef.current(JSON.parse(data) as RealtimeEvent)
            } catch {
              // payload malformado — ignora este frame específico, não derruba a conexão inteira
            }
          }
        }
      } catch {
        // erro de rede OU abort (unmount, troca de papel, watchdog de heartbeat)
        // — em qualquer caso cai para o agendamento de reconexão abaixo,
        // exceto quando `stopped` (aí é desmontagem de verdade).
      } finally {
        useRealtimeStore.getState().markDisconnected()
      }

      if (!stopped) {
        reconnectTimer = setTimeout(connectOnce, backoff)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }

    connectOnce()

    const healthWatchdog = setInterval(() => {
      const { lastEventAt } = useRealtimeStore.getState()
      if (lastEventAt && Date.now() - lastEventAt > HEARTBEAT_TIMEOUT_MS) {
        controller?.abort() // stream "zumbi" — força reconexão mesmo sem erro
      }
    }, 5_000)

    return () => {
      stopped = true
      controller?.abort()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(healthWatchdog)
      useRealtimeStore.getState().reset()
    }
    // `onEvent` é lido via ref (onEventRef, atualizado no efeito acima) de
    // propósito — só `path` deve reabrir a conexão.
  }, [path])
}
