import { api } from "./api"
import type {
  MeAccountDeletionRequest,
  MeAccountDeletionResponse,
  MeActiveSessionResponse,
  MeCardTokenizationSessionResponse,
  MeCommandStatusResponse,
  MeCreatePaymentMethodRequest,
  MeCreateTopupRequest,
  MeDataExport,
  MeNotificationPreferences,
  MeProfile,
  MePaymentMethodDTO,
  MePaymentMethodsResponse,
  MeSessionDetail,
  MeSessionsListResponse,
  MeSessionsQuery,
  MeStartSessionRequest,
  MeStartSessionResponse,
  MeStopSessionResponse,
  MeTopupDTO,
  MeWalletQuery,
  MeWalletResponse,
  UpdateMeNotificationPreferencesRequest,
  UpdateMeProfileRequest,
} from "@/types/api"

/**
 * Rotas `/api/me/*` (DRIVER only) — o núcleo de negócio é o mesmo da F4
 * (`avaliarInicioSessao`/`calcularTetoReserva`/`calcularCustoSessao`),
 * escopado por `userId` (o token) em vez de `operatorId`. Ver
 * PROGRESSO.md §PWA do motorista.
 */
export const meService = {
  /** `GET /api/me/profile` (L1.2) - `cpfMasked` sempre mascarado; o e-mail não é editável. */
  async getProfile(): Promise<MeProfile> {
    const { data } = await api.get<MeProfile>("/api/me/profile")
    return data
  },

  /** `PATCH /api/me/profile` (L1.2) - corpo estrito, ao menos um campo; devolve o DTO já atualizado. `null` em `phone`/`cpf` apaga. */
  async updateProfile(payload: UpdateMeProfileRequest): Promise<MeProfile> {
    const { data } = await api.patch<MeProfile>("/api/me/profile", payload)
    return data
  },

  /**
   * `GET /api/me/data-export` (L1.4) - a cópia dos dados do titular, para BAIXAR (a tela não a renderiza). Lido como JSON (e não como blob) de propósito: com `responseType: "blob"` o
   * corpo do ERRO (429 `RATE_LIMITED_EXPORT`) também chegaria como Blob e o `code` não seria legível. Timeout maior que o padrão (a exportação é síncrona e pode ser grande).
   */
  async exportData(): Promise<MeDataExport> {
    const { data } = await api.get<MeDataExport>("/api/me/data-export", { timeout: 60_000 })
    return data
  },

  /**
   * `POST /api/me/account/deletion` (L1.4) - ANONIMIZA a conta. Reautenticação obrigatória no corpo (`currentPassword` ou `googleCredential`). 200 `{ status }`; depois dele o token
   * deixa de valer. Erros: ver `MeAccountDeletionErrorCode` e `lib/accountDeletion.ts`.
   */
  async deleteAccount(payload: MeAccountDeletionRequest): Promise<MeAccountDeletionResponse> {
    const { data } = await api.post<MeAccountDeletionResponse>("/api/me/account/deletion", payload)
    return data
  },

  /** `GET /api/me/notification-preferences` (L1.6) - sem linha salva volta o padrão (`true`, `true`, 2000). */
  async getNotificationPreferences(): Promise<MeNotificationPreferences> {
    const { data } = await api.get<MeNotificationPreferences>("/api/me/notification-preferences")
    return data
  },

  /** `PATCH /api/me/notification-preferences` (L1.6) - só as 3 chaves, ao menos uma; devolve o objeto COMPLETO. */
  async updateNotificationPreferences(payload: UpdateMeNotificationPreferencesRequest): Promise<MeNotificationPreferences> {
    const { data } = await api.patch<MeNotificationPreferences>("/api/me/notification-preferences", payload)
    return data
  },

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

  // ---- Cartão salvo (F5.3 — ver types/api.ts e pagamento-cartao/) -----------

  async listPaymentMethods(): Promise<MePaymentMethodsResponse> {
    const { data } = await api.get<MePaymentMethodsResponse>("/api/me/payment-methods")
    return data
  },

  /** Autenticado normalmente (JWT) — o resultado é repassado ao documento isolado por `postMessage`, nunca por querystring (ver `types/cardTokenizationChannel.ts`). */
  async createTokenizationSession(): Promise<MeCardTokenizationSessionResponse> {
    const { data } = await api.post<MeCardTokenizationSessionResponse>("/api/me/payment-methods/tokenization-session")
    return data
  },

  /** Recebe SÓ `cardToken`+`brand` — nunca PAN/CVV (ver `MeCreatePaymentMethodRequest`). */
  async createPaymentMethod(payload: MeCreatePaymentMethodRequest): Promise<MePaymentMethodDTO> {
    const { data } = await api.post<MePaymentMethodDTO>("/api/me/payment-methods", payload)
    return data
  },

  /** Corpo `{ isDefault: true }` — contrato literal do Vega (`meUpdatePaymentMethodSchema`, `z.literal(true)`); não existe "desmarcar sem marcar outro". */
  async setDefaultPaymentMethod(id: string): Promise<MePaymentMethodDTO> {
    const { data } = await api.patch<MePaymentMethodDTO>(`/api/me/payment-methods/${id}`, { isDefault: true })
    return data
  },

  /** Soft-delete (204) — mesmo padrão do resto da API (ver memória da Lyra). */
  async deletePaymentMethod(id: string): Promise<void> {
    await api.delete(`/api/me/payment-methods/${id}`)
  },
}
