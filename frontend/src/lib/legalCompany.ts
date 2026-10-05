import type { PublicLegalConfig } from "@/types/api"

/**
 * Dados da empresa para as páginas legais (L1.9). Os campos vêm de `GET /api/public/legal` e ficam `null` até o DONO informar (CNPJ, razão social, e-mail de suporte, encarregado/DPO
 * não foram dados ainda): a tela mostra SÓ o que veio preenchido - nunca placeholder nem valor inventado. Lógica PURA.
 */
export type CompanyData = PublicLegalConfig["company"]

export interface CompanyRow {
  label: string
  value: string
  /** `mailto:` / `tel:` quando o valor é um contato. */
  href?: string
}

function filled(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/** Telefone para `tel:`: só dígitos e `+`. */
function telHref(phone: string): string | undefined {
  const cleaned = phone.replace(/[^\d+]/g, "")
  return cleaned.replace(/\D/g, "").length >= 8 ? `tel:${cleaned}` : undefined
}

/** Linhas do bloco "Responsável", na ordem de leitura, sem as vazias. */
export function companyRows(company: CompanyData): CompanyRow[] {
  const rows: CompanyRow[] = []
  if (filled(company.name)) rows.push({ label: "Razão social", value: company.name.trim() })
  if (filled(company.cnpj)) rows.push({ label: "CNPJ", value: company.cnpj.trim() })
  if (filled(company.supportEmail)) rows.push({ label: "Atendimento (e-mail)", value: company.supportEmail.trim(), href: `mailto:${company.supportEmail.trim()}` })
  if (filled(company.supportPhone)) rows.push({ label: "Atendimento (telefone)", value: company.supportPhone.trim(), href: telHref(company.supportPhone) })
  if (filled(company.dpoEmail)) rows.push({ label: "Encarregado de dados (DPO)", value: company.dpoEmail.trim(), href: `mailto:${company.dpoEmail.trim()}` })
  return rows
}

export function hasCompanyData(company: CompanyData | undefined): boolean {
  return company !== undefined && companyRows(company).length > 0
}
