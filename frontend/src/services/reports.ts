import { api } from "./api"
import type {
  DailyMovementQuery,
  DailyMovementResponse,
  PaymentsReportQuery,
  PaymentsReportResponse,
  RevenueReportQuery,
  RevenueReportResponse,
  SessionDetail,
  SessionsReportQuery,
  SessionsReportResponse,
} from "@/types/api"

export const reportsService = {
  async dailyMovement(params: DailyMovementQuery): Promise<DailyMovementResponse> {
    const { data } = await api.get<DailyMovementResponse>("/api/admin/reports/daily-movement", { params })
    return data
  },

  async revenue(params: RevenueReportQuery): Promise<RevenueReportResponse> {
    const { data } = await api.get<RevenueReportResponse>("/api/admin/reports/revenue", { params })
    return data
  },

  async sessions(params: SessionsReportQuery): Promise<SessionsReportResponse> {
    const { data } = await api.get<SessionsReportResponse>("/api/admin/reports/sessions", { params })
    return data
  },

  async sessionDetail(id: string): Promise<SessionDetail> {
    const { data } = await api.get<SessionDetail>(`/api/admin/reports/sessions/${id}`)
    return data
  },

  async payments(params: PaymentsReportQuery): Promise<PaymentsReportResponse> {
    const { data } = await api.get<PaymentsReportResponse>("/api/admin/reports/payments", { params })
    return data
  },
}
