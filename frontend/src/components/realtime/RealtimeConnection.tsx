import { useMemo } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useAuthStore } from "@/store/authStore"
import { useRealtimeStream } from "@/hooks/useRealtimeStream"
import { handleRealtimeEvent } from "@/lib/realtimeEventHandlers"

/**
 * Monta a conexão SSE uma única vez, perto da raiz (ver `App.tsx`) — sem
 * visual, só efeito colateral (despachar eventos pro TanStack Query via
 * `handleRealtimeEvent`). O endpoint é decidido pelo PAPEL, não pela tela
 * atual: ADMIN/OPERATOR assinam o canal do painel, DRIVER assina o canal do
 * motorista (ver `decisoes-tempo-real-sse.md`). Sem sessão, sem conexão.
 */
export function RealtimeConnection() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const role = useAuthStore((s) => s.user?.role)
  const queryClient = useQueryClient()

  const path = useMemo(() => {
    if (!isAuthenticated) return null
    if (role === "ADMIN" || role === "OPERATOR") return "/api/admin/events"
    if (role === "DRIVER") return "/api/me/events"
    return null
  }, [isAuthenticated, role])

  useRealtimeStream(path, (event) => handleRealtimeEvent(event, queryClient))

  return null
}
