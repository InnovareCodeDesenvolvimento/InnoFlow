import { useQuery } from "@tanstack/react-query"
import { dashboardService } from "@/services/dashboard"
import { useRealtimeHealthy } from "@/store/realtimeStore"
import type { ReportPeriodParams } from "@/types/api"

export const dashboardKeys = {
  summary: (params: ReportPeriodParams) => ["dashboard", "summary", params] as const,
  live: (operatorId: string | undefined) => ["dashboard", "live", operatorId] as const,
}

export function useDashboardSummary(params: ReportPeriodParams) {
  return useQuery({
    queryKey: dashboardKeys.summary(params),
    queryFn: () => dashboardService.summary(params),
    placeholderData: (prev) => prev,
  })
}

/**
 * Painel "ao vivo": sessões ativas + carregadores online/offline/faulted.
 * `chargepoint.status`/`session.started`/`session.stopped`/`dashboard.dirty`
 * (ver `RealtimeConnection`) já invalidam esta query no evento — o polling
 * abaixo é a REDE DE SEGURANÇA, não o mecanismo principal: 15s quando o SSE
 * está fora do ar (ou nunca provou que está vivo), 60s quando está saudável
 * (Nova, `decisoes-tempo-real-sse.md` item 7 — stream morre de formas que
 * parecem sucesso, então nunca desligamos o polling de vez).
 */
export function useDashboardLive(operatorId?: string) {
  const realtimeHealthy = useRealtimeHealthy()
  return useQuery({
    queryKey: dashboardKeys.live(operatorId),
    queryFn: () => dashboardService.live(operatorId),
    refetchInterval: realtimeHealthy ? 60000 : 15000,
    refetchIntervalInBackground: false,
  })
}
