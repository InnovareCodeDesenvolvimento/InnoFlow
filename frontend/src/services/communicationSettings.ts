import { api } from "./api"
import type { CommunicationSettingsDTO, TestChannelResult, TestEmailRequest, TestWhatsappRequest, UpdateCommunicationSettingsRequest } from "@/types/api"

/**
 * `/api/admin/communication-settings` — canais de aviso ao dono (e-mail SMTP e WhatsApp Evolution), N-7. ADMIN-only (403 `FORBIDDEN` para OPERATOR).
 * Contrato literal: `docs/CONTRATO-COMUNICACAO-ADMIN.md`. Segredos são só de escrita: o GET devolve `passwordSet`/`apiKeySet`, nunca o valor.
 */
export const communicationSettingsService = {
  async get(): Promise<CommunicationSettingsDTO> {
    const { data } = await api.get<CommunicationSettingsDTO>("/api/admin/communication-settings")
    return data
  },

  /** Envia SÓ o que mudou (campo ausente = "não mexer"). Devolve o DTO já atualizado. Erros por `code`: ver `parseCommunicationError`. */
  async update(payload: UpdateCommunicationSettingsRequest): Promise<CommunicationSettingsDTO> {
    const { data } = await api.put<CommunicationSettingsDTO>("/api/admin/communication-settings", payload)
    return data
  },

  /** Sempre 200 com o resultado (erro do provedor é RESULTADO, `ok: false`). Erros HTTP (400/403/429/503) são falha da rota. */
  async testEmail(payload: TestEmailRequest): Promise<TestChannelResult> {
    const { data } = await api.post<TestChannelResult>("/api/admin/communication-settings/test-email", payload)
    return data
  },

  async testWhatsapp(payload: TestWhatsappRequest): Promise<TestChannelResult> {
    const { data } = await api.post<TestChannelResult>("/api/admin/communication-settings/test-whatsapp", payload)
    return data
  },
}
