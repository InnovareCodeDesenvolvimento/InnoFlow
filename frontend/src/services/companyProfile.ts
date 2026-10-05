import { api } from "./api"
import type { CompanyProfileDTO, UpdateCompanyProfileRequest } from "@/types/api"

/**
 * `/api/admin/company-profile` — dados da empresa (controlador) e versões dos Termos/Privacidade. ADMIN-only (403 `FORBIDDEN` para OPERATOR). Contrato literal: `docs/CONTRATO-EMPRESA-ADMIN.md` (tipos em `types/api.ts`). Sem segredo, sem step-up de senha.
 */
export const companyProfileService = {
  async get(): Promise<CompanyProfileDTO> {
    const { data } = await api.get<CompanyProfileDTO>("/api/admin/company-profile")
    return data
  },

  /** Envia SÓ o que mudou. Devolve o DTO já atualizado. 409 `VERSION_CHANGE_NOT_CONFIRMED` (nada gravado) pede `confirmVersionChange: true`. */
  async update(payload: UpdateCompanyProfileRequest): Promise<CompanyProfileDTO> {
    const { data } = await api.put<CompanyProfileDTO>("/api/admin/company-profile", payload)
    return data
  },
}
