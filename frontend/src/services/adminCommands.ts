import { api } from "./api"
import type { AdminCommandStatusResponse } from "@/types/api"

/** `GET /api/admin/commands/:correlationId` (L1.5, só ADMIN). 404 `COMMAND_NOT_FOUND` = inexistente, expirado (2 min) ou fora do escopo — indistinguíveis de propósito. */
export const adminCommandsService = {
  async status(correlationId: string, signal?: AbortSignal): Promise<AdminCommandStatusResponse> {
    const { data } = await api.get<AdminCommandStatusResponse>(`/api/admin/commands/${correlationId}`, { signal })
    return data
  },
}
