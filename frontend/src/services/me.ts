import { api } from "./api"
import type {
  MeActiveSessionResponse,
  MeCommandStatusResponse,
  MeCreateTopupRequest,
  MeSessionDetail,
  MeSessionsListResponse,
  MeSessionsQuery,
  MeStartSessionRequest,
  MeStartSessionResponse,
  MeStopSessionResponse,
  MeTopupDTO,
  MeWalletQuery,
  MeWalletResponse,
} from "@/types/api"

/**
 * Rotas `/api/me/*` (DRIVER only) — o núcleo de negócio é o mesmo da F4
 * (`avaliarInicioSessao`/`calcularTetoReserva`/`calcularCustoSessao`),
 * escopado por `userId` (o token) em vez de `operatorId`. Ver
 * PROGRESSO.md §PWA do motorista.
 */
export const meService = {
  /** 202 — fire-and-forget, confirma só o enfileiramento do comando OCPP. */
  async startSession(payload: MeStartSessionRequest): Promise<MeStartSessionResponse> {
    const { data } = await api.post<MeStartSessionResponse>("/api/me/sessions/start", payload)
    return data
  },

  /** `session: null` (200) quando não há sessão ativa agora — nunca 404. */
  async activeSession(): Promise<MeActiveSessionResponse> {
    const { data } = await api.get<MeActiveSessionResponse>("/api/me/sessions/active")
    return data
  },

  async listSessions(params: MeSessionsQuery = {}): Promise<MeSessionsListResponse> {
    const { data } = await api.get<MeSessionsListResponse>("/api/me/sessions", { params })
    return data
  },

  async sessionDetail(id: string): Promise<MeSessionDetail> {
    const { data } = await api.get<MeSessionDetail>(`/api/me/sessions/${id}`)
    return data
  },

  /** 202 — mesma semântica fire-and-forget de `startSession`. */
  async stopSession(id: string): Promise<MeStopSessionResponse> {
    const { data } = await api.post<MeStopSessionResponse>(`/api/me/sessions/${id}/stop`)
    return data
  },

  /** Consulta o resultado real do comando disparado por `startSession`/`stopSession` — conserta o "202 cego". */
  async commandStatus(correlationId: string): Promise<MeCommandStatusResponse> {
    const { data } = await api.get<MeCommandStatusResponse>(`/api/me/commands/${correlationId}`)
    return data
  },

  async wallet(params: MeWalletQuery = {}): Promise<MeWalletResponse> {
    const { data } = await api.get<MeWalletResponse>("/api/me/wallet", { params })
    return data
  },

  /** 201 — o QR/copia-e-cola já vem prontos (a rota real ainda não existe no backend, ver PROGRESSO.md §F5.1). */
  async createTopup(payload: MeCreateTopupRequest): Promise<MeTopupDTO> {
    const { data } = await api.post<MeTopupDTO>("/api/me/wallet/topups", payload)
    return data
  },

  /** Consulta o status real do Pix — mecanismo PRINCIPAL de descoberta (polling), ver `useMeTopup`. */
  async getTopup(id: string): Promise<MeTopupDTO> {
    const { data } = await api.get<MeTopupDTO>(`/api/me/wallet/topups/${id}`)
    return data
  },
}
