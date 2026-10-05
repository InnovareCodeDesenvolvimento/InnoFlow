import { api } from "./api"
import type {
  ChargePoint,
  ChargePointCommandType,
  CommandDispatchResult,
  CreateChargePointInput,
  PaginatedResponse,
  PaginationParams,
  RemoteStartRequest,
  RemoteStartResponse,
  UpdateChargePointInput,
} from "@/types/api"

export interface ResetCommandParams {
  type?: "Hard" | "Soft"
}
export interface UnlockCommandParams {
  connectorId: number
}
export interface ChangeAvailabilityParams {
  connectorId: number
  type: "Inoperative" | "Operative"
}
export interface TriggerMessageParams {
  requestedMessage:
    | "BootNotification"
    | "DiagnosticsStatusNotification"
    | "FirmwareStatusNotification"
    | "Heartbeat"
    | "MeterValues"
    | "StatusNotification"
  connectorId?: number
}

export const chargePointsService = {
  async list(params: PaginationParams = {}): Promise<PaginatedResponse<ChargePoint>> {
    const { data } = await api.get<PaginatedResponse<ChargePoint>>("/api/admin/charge-points", { params })
    return data
  },

  async get(id: string): Promise<ChargePoint> {
    const { data } = await api.get<ChargePoint>(`/api/admin/charge-points/${id}`)
    return data
  },

  async create(payload: CreateChargePointInput): Promise<ChargePoint> {
    const { data } = await api.post<ChargePoint>("/api/admin/charge-points", payload)
    return data
  },

  async update(id: string, payload: UpdateChargePointInput): Promise<ChargePoint> {
    const { data } = await api.patch<ChargePoint>(`/api/admin/charge-points/${id}`, payload)
    return data
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/api/admin/charge-points/${id}`)
  },

  /**
   * Comandos remotos: fire-and-forget de verdade. O 202 só confirma que o
   * comando foi ENFILEIRADO (`correlationId` + `status: "PENDING"`) — não
   * há canal de entrega do resultado nesta fase (SSE é stub, ver
   * PROGRESSO.md). A UI não pode prometer "carregador reiniciado", só
   * "comando enviado".
   */
  async sendCommand(
    id: string,
    command: ChargePointCommandType,
    params: ResetCommandParams | UnlockCommandParams | ChangeAvailabilityParams | TriggerMessageParams | Record<string, never> = {},
  ): Promise<CommandDispatchResult> {
    const { data } = await api.post<CommandDispatchResult>(`/api/admin/charge-points/${id}/commands/${command}`, params)
    return data
  },

  /**
   * L1.5 — recarga remota pela administração (só ADMIN, DL4). 202 `{ correlationId, status: "PENDING", ... }`; o RESULTADO vem de
   * `adminCommandsService.status(correlationId)`. Só carteira (sem cartão). `reason` obrigatório (10–200) — vai para a auditoria.
   */
  async remoteStart(id: string, payload: RemoteStartRequest): Promise<RemoteStartResponse> {
    const { data } = await api.post<RemoteStartResponse>(`/api/admin/charge-points/${id}/commands/remote-start`, payload)
    return data
  },
}
