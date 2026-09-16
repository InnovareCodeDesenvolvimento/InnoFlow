import { api } from "./api"
import type { DashboardLiveResponse, DashboardSummaryResponse, ReportPeriodParams } from "@/types/api"

export const dashboardService = {
  async summary(params: ReportPeriodParams): Promise<DashboardSummaryResponse> {
    const { data } = await api.get<DashboardSummaryResponse>("/api/admin/dashboard/summary", { params })
    return data
  },

  /** `GET /dashboard/live` — sem SSE nesta fase, quem chama faz polling (ver `useDashboardLive`). */
  async live(operatorId?: string): Promise<DashboardLiveResponse> {
    const { data } = await api.get<DashboardLiveResponse>("/api/admin/dashboard/live", { params: { operatorId } })
    return data
  },
}
