import { useQuery } from "@tanstack/react-query"
import { dashboardService } from "@/services/dashboard"
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

/** Painel "ao vivo": sessões ativas + carregadores online/offline/faulted. Polling de 15s — SSE não existe ainda (ver PROGRESSO.md). */
export function useDashboardLive(operatorId?: string) {
  return useQuery({
    queryKey: dashboardKeys.live(operatorId),
    queryFn: () => dashboardService.live(operatorId),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
  })
}
