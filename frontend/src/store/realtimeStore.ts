import { create } from "zustand"

/**
 * Saúde do canal SSE — estado GLOBAL de verdade (igual `authStore`), porque
 * hooks de polling fora da árvore da conexão (`useDashboardLive`,
 * `useActiveSession`) precisam ler "o push está vivo?" pra decidir o próprio
 * intervalo, sem precisar de Context Provider por cima de cada tela.
 *
 * `healthy` só vira `true` quando um evento/heartbeat É recebido — abrir a
 * conexão não basta (ver `useRealtimeStream`). Regra da Nova: "stream vivo =
 * rede de segurança de 60s; stream caído/nunca provado = polling agressivo
 * de hoje continua".
 */
interface RealtimeState {
  connected: boolean
  lastEventAt: number | null
  healthy: boolean
  markConnected: () => void
  markEvent: () => void
  markDisconnected: () => void
  reset: () => void
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  connected: false,
  lastEventAt: null,
  healthy: false,
  markConnected: () => set({ connected: true }),
  markEvent: () => set({ lastEventAt: Date.now(), healthy: true }),
  markDisconnected: () => set({ connected: false, healthy: false }),
  reset: () => set({ connected: false, lastEventAt: null, healthy: false }),
}))

/** Conveniência: "dá pra confiar no push agora?" — ver `useDashboardLive`/`useActiveSession`. */
export function useRealtimeHealthy(): boolean {
  return useRealtimeStore((s) => s.healthy)
}
