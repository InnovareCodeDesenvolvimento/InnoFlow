import { api } from "./api"
import type { CommunicationSettingsDTO, DomainCheckResponse, TestChannelResult, TestEmailRequest, TestSmtpConnectionRequest, TestSmtpConnectionResult, TestWhatsappRequest, UpdateCommunicationSettingsRequest } from "@/types/api"

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

  /** Só conecta, negocia TLS e autentica (não envia e-mail). SEMPRE 200 com o estágio; 400/403/429/503 são falha da rota. */
  async testSmtpConnection(payload: TestSmtpConnectionRequest): Promise<TestSmtpConnectionResult> {
    const { data } = await api.post<TestSmtpConnectionResult>("/api/admin/communication-settings/test-smtp-connection", payload)
    return data
  },

  /** Diagnóstico de SPF/DKIM/DMARC do remetente SALVO. Falha de DNS vem como `ERRO` no registro (200); 400/403/429/503 são falha da rota. */
  async domainCheck(selector?: string): Promise<DomainCheckResponse> {
    const { data } = await api.get<DomainCheckResponse>("/api/admin/communication-settings/domain-check", { params: selector ? { selector } : undefined })
    return data
  },

  async testWhatsapp(payload: TestWhatsappRequest): Promise<TestChannelResult> {
    const { data } = await api.post<TestChannelResult>("/api/admin/communication-settings/test-whatsapp", payload)
    return data
  },
}
