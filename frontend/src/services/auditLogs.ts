import { api } from "./api"
import type { AuditLogActorsQuery, AuditLogActorsResponse, AuditLogDetail, AuditLogListResponse, AuditLogQuery } from "@/types/api"

/** Rotas ADMIN-only (`/api/admin/audit-logs*`) — ver `decisoes-audit-log.md`. */
export const auditLogsService = {
  async list(params: AuditLogQuery): Promise<AuditLogListResponse> {
    const { data } = await api.get<AuditLogListResponse>("/api/admin/audit-logs", { params })
    return data
  },

  async detail(id: string): Promise<AuditLogDetail> {
    const { data } = await api.get<AuditLogDetail>(`/api/admin/audit-logs/${id}`)
    return data
  },

  async actors(params: AuditLogActorsQuery): Promise<AuditLogActorsResponse> {
    const { data } = await api.get<AuditLogActorsResponse>("/api/admin/audit-logs/actors", { params })
    return data
  },
}
