import { api } from "./api"
import type { MeAcceptConsentsRequest, MeConsentStatus, PublicLegalConfig } from "@/types/api"

export const legalService = {
  /** `GET /api/public/legal` (sem auth) - versões vigentes e dados da empresa (campos `null` = o dono ainda não informou; nunca inventar). */
  async getPublic(): Promise<PublicLegalConfig> {
    const { data } = await api.get<PublicLegalConfig>("/api/public/legal")
    return data
  },

  /** `GET /api/me/consents` (DRIVER) - `upToDate=false` = existe versão nova dos termos que a pessoa ainda não aceitou. */
  async getConsents(): Promise<MeConsentStatus> {
    const { data } = await api.get<MeConsentStatus>("/api/me/consents")
    return data
  },

  /** `POST /api/me/consents` (DRIVER) - 201; idempotente. Versão que não é a vigente = 409 `TERMS_VERSION_OUTDATED`. */
  async acceptConsents(payload: MeAcceptConsentsRequest): Promise<MeConsentStatus> {
    const { data } = await api.post<MeConsentStatus>("/api/me/consents", payload)
    return data
  },
}
