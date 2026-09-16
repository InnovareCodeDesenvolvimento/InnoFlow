import { useQuery } from "@tanstack/react-query"
import { reportsService } from "@/services/reports"
import type { DailyMovementQuery, PaymentsReportQuery, RevenueReportQuery, SessionsReportQuery } from "@/types/api"

export const reportsKeys = {
  dailyMovement: (params: DailyMovementQuery) => ["reports", "daily-movement", params] as const,
  revenue: (params: RevenueReportQuery) => ["reports", "revenue", params] as const,
  sessions: (params: SessionsReportQuery) => ["reports", "sessions", params] as const,
  sessionDetail: (id: string | undefined) => ["reports", "sessions", "detail", id] as const,
  payments: (params: PaymentsReportQuery) => ["reports", "payments", params] as const,
}

export function useDailyMovementReport(params: DailyMovementQuery) {
  return useQuery({
    queryKey: reportsKeys.dailyMovement(params),
    queryFn: () => reportsService.dailyMovement(params),
    placeholderData: (prev) => prev,
  })
}

export function useRevenueReport(params: RevenueReportQuery) {
  return useQuery({
    queryKey: reportsKeys.revenue(params),
    queryFn: () => reportsService.revenue(params),
    placeholderData: (prev) => prev,
  })
}

export function useSessionsReport(params: SessionsReportQuery) {
  return useQuery({
    queryKey: reportsKeys.sessions(params),
    queryFn: () => reportsService.sessions(params),
    placeholderData: (prev) => prev,
  })
}

/** Drill-down de uma sessão — só busca quando `id` está definido (dialog aberto). */
export function useSessionDetail(id: string | undefined) {
  return useQuery({
    queryKey: reportsKeys.sessionDetail(id),
    queryFn: () => reportsService.sessionDetail(id as string),
    enabled: Boolean(id),
  })
}

export function usePaymentsReport(params: PaymentsReportQuery) {
  return useQuery({
    queryKey: reportsKeys.payments(params),
    queryFn: () => reportsService.payments(params),
    placeholderData: (prev) => prev,
  })
}
