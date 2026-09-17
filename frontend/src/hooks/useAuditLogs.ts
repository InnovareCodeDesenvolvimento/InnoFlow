import { useQuery } from "@tanstack/react-query"
import { auditLogsService } from "@/services/auditLogs"
import type { AuditLogActorsQuery, AuditLogQuery } from "@/types/api"

export const auditLogsKeys = {
  all: ["auditLogs"] as const,
  list: (params: AuditLogQuery) => [...auditLogsKeys.all, "list", params] as const,
  detail: (id: string) => [...auditLogsKeys.all, "detail", id] as const,
  actors: (params: AuditLogActorsQuery) => [...auditLogsKeys.all, "actors", params] as const,
}

export function useAuditLogs(params: AuditLogQuery) {
  return useQuery({
    queryKey: auditLogsKeys.list(params),
    queryFn: () => auditLogsService.list(params),
    placeholderData: (prev) => prev,
  })
}

export function useAuditLogDetail(id: string | undefined) {
  return useQuery({
    queryKey: auditLogsKeys.detail(id ?? ""),
    queryFn: () => auditLogsService.detail(id as string),
    enabled: !!id,
  })
}

/** Alimenta o `<select>` de ator do filtro — não é uma lista de usuários separada, é derivada do próprio período em auditoria (ver PROGRESSO.md). */
export function useAuditLogActors(params: AuditLogActorsQuery) {
  return useQuery({
    queryKey: auditLogsKeys.actors(params),
    queryFn: () => auditLogsService.actors(params),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  })
}
