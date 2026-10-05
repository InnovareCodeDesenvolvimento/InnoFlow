import axios from "axios"
import type { CompanyProfileDTO, VersionChangeDetail, UpdateCompanyProfileRequest } from "@/types/api"

/**
 * Regras PURAS da aba Geral (dados da empresa e versões dos Termos/Privacidade). Nada aqui toca rede, DOM nem React. A validação ESPELHA a do servidor (`companyProfile.schema.ts`,
 * `core/legal/cnpj.ts`): o cliente só barra o óbvio e mostra o erro no campo; a palavra final é do servidor (400 `VALIDATION_ERROR`).
 */

// ---------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------

export const PROFILE_FIELDS = ["legalName", "tradeName", "cnpj", "supportEmail", "supportPhone", "address", "website", "dpoName", "dpoEmail"] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]
export const VERSION_FIELDS = ["termsVersion", "privacyVersion"] as const
export type VersionField = (typeof VERSION_FIELDS)[number]
export type CompanyField = ProfileField | VersionField

/** Rascunho: `undefined` = o admin não mexeu; string (mesmo "") = valor digitado. Em branco = LIMPAR (`null`) — diferente da comunicação, aqui vazio é uma escolha válida. */
export type CompanyDraft = Partial<Record<CompanyField, string>>
export type CompanyErrors = Partial<Record<CompanyField, string>>

export const MAX_LENGTH: Record<ProfileField, number> = { legalName: 160, tradeName: 120, cnpj: 100, supportEmail: 180, supportPhone: 100, address: 300, website: 200, dpoName: 120, dpoEmail: 180 }

export const FIELD_LABELS: Record<CompanyField, string> = {
  legalName: "Razão social",
  tradeName: "Nome fantasia",
  cnpj: "CNPJ",
  supportEmail: "E-mail de suporte",
  supportPhone: "Telefone de suporte",
  address: "Endereço",
  website: "Site",
  dpoName: "Nome do encarregado de dados (DPO)",
  dpoEmail: "E-mail do encarregado de dados (DPO)",
  termsVersion: "Versão dos Termos de Uso",
  privacyVersion: "Versão da Política de Privacidade",
}

// ---------------------------------------------------------------------------
// CNPJ (numérico e alfanumérico, vigente desde julho/2026): módulo 11, valor do caractere = código ASCII - 48
// ---------------------------------------------------------------------------

const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
const PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]

/** Tira a pontuação usual (`.`, `/`, `-`, espaço) e põe em maiúsculas. Qualquer outro caractere é mantido para a validação recusar. */
export function normalizeCnpj(raw: string): string {
  return raw.replace(/[.\-/\s]/g, "").toUpperCase()
}

function checkDigit(base: string, weights: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < weights.length; i += 1) sum += (base.charCodeAt(i) - 48) * weights[i]
  const rest = sum % 11
  return rest < 2 ? 0 : 11 - rest
}

/** `true` só para 14 caracteres NORMALIZADOS (12 alfanuméricos + 2 dígitos), não repetidos e com os dois dígitos verificadores corretos. */
export function isValidNormalizedCnpj(normalized: string): boolean {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(normalized)) return false
  if (/^(.)\1{13}$/.test(normalized)) return false
  const dv1 = checkDigit(normalized, PESOS_DV1)
  const dv2 = checkDigit(normalized.slice(0, 12) + String(dv1), PESOS_DV2)
  return normalized.endsWith(`${dv1}${dv2}`)
}

export const isValidCnpj = (raw: string) => isValidNormalizedCnpj(normalizeCnpj(raw))

/** Máscara `12.345.678/0001-95` para um CNPJ normalizado (a mesma para numérico e alfanumérico). */
export function formatCnpj(normalized: string): string {
  return normalized.length === 14 ? `${normalized.slice(0, 2)}.${normalized.slice(2, 5)}.${normalized.slice(5, 8)}/${normalized.slice(8, 12)}-${normalized.slice(12)}` : normalized
}

// ---------------------------------------------------------------------------
// Outros campos
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[0-9+()\s.-]{8,30}$/
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/

/** Site como o servidor guarda: completa `https://` quando falta; `null` se inválido (credenciais, sem ponto no host, espaço, mais de 200 caracteres). */
export function normalizeWebsite(raw: string): string | null {
  const t = raw.trim()
  if (t === "" || t.length > 200 || /\s/.test(t)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username !== "" || url.password !== "") return null
  if (!url.hostname.includes(".") || url.hostname.endsWith(".")) return null
  const text = url.toString()
  return url.pathname === "/" && url.search === "" && url.hash === "" ? text.replace(/\/$/, "") : text
}

const trimmed = (value: string | undefined) => (value === undefined ? undefined : value.replace(/\s+/g, " ").trim())

// ---------------------------------------------------------------------------
// Valores atuais (DTO) e validação
// ---------------------------------------------------------------------------

/** O valor SALVO de cada campo, como texto de formulário (vazio = não informado). */
export function savedValue(dto: CompanyProfileDTO, field: CompanyField): string {
  if (field === "termsVersion") return dto.versions.termsSource === "db" ? dto.versions.termsVersion : ""
  if (field === "privacyVersion") return dto.versions.privacySource === "db" ? dto.versions.privacyVersion : ""
  return dto.profile[field] ?? ""
}

/** O valor MOSTRADO: rascunho sobre o salvo. */
export const shownValue = (dto: CompanyProfileDTO, draft: CompanyDraft, field: CompanyField): string => draft[field] ?? savedValue(dto, field)

function sameValue(field: CompanyField, a: string, b: string): boolean {
  if (field === "cnpj") return normalizeCnpj(a) === normalizeCnpj(b)
  if (field === "website") return (normalizeWebsite(a) ?? a.trim()) === (normalizeWebsite(b) ?? b.trim())
  if (field === "supportEmail" || field === "dpoEmail") return a.trim().toLowerCase() === b.trim().toLowerCase()
  return trimmed(a) === trimmed(b)
}

/** Erros de campo do rascunho. Só avalia o que o admin MEXEU; vazio é válido (limpa o campo). */
export function validateCompanyDraft(draft: CompanyDraft): CompanyErrors {
  const errors: CompanyErrors = {}
  for (const field of [...PROFILE_FIELDS, ...VERSION_FIELDS] as const) {
    const raw = draft[field]
    if (raw === undefined) continue
    const value = trimmed(raw) ?? ""
    if (value === "") continue
    if (field in MAX_LENGTH && value.length > MAX_LENGTH[field as ProfileField]) {
      errors[field] = `Use no máximo ${MAX_LENGTH[field as ProfileField]} caracteres.`
      continue
    }
    if (field === "cnpj" && !isValidCnpj(value)) errors.cnpj = "CNPJ inválido: confira os números (os dois últimos são os dígitos verificadores)."
    else if ((field === "supportEmail" || field === "dpoEmail") && !EMAIL_RE.test(value)) errors[field] = "E-mail inválido."
    else if (field === "supportPhone" && !(PHONE_RE.test(value) && (value.match(/\d/g)?.length ?? 0) >= 8)) errors.supportPhone = "Telefone inválido: use números, DDD e, se quiser, +55 ( ) - e espaços."
    else if (field === "website" && normalizeWebsite(value) === null) errors.website = "Endereço do site inválido: use algo como https://www.suaempresa.com.br."
    else if ((field === "termsVersion" || field === "privacyVersion") && !VERSION_RE.test(value)) errors[field] = "Versão inválida: até 32 caracteres entre letras, números, ponto, hífen e sublinhado (ex.: 2026-10-06)."
  }
  return errors
}

// ---------------------------------------------------------------------------
// PUT (só o diff)
// ---------------------------------------------------------------------------

/** Só entra o que mudou. Texto em branco (num campo que tinha valor) = `null` (limpa). */
export function buildCompanyPayload(dto: CompanyProfileDTO, draft: CompanyDraft): UpdateCompanyProfileRequest {
  const payload: UpdateCompanyProfileRequest = {}
  for (const field of [...PROFILE_FIELDS, ...VERSION_FIELDS] as const) {
    const raw = draft[field]
    if (raw === undefined) continue
    const value = trimmed(raw) ?? ""
    const saved = savedValue(dto, field)
    if (sameValue(field, value, saved)) continue
    payload[field] = value === "" ? null : value
  }
  return payload
}

export const hasCompanyChanges = (payload: UpdateCompanyProfileRequest): boolean => Object.keys(payload).some((key) => key !== "confirmVersionChange")

export interface CompanyChangeItem {
  key: string
  label: string
  from: string
  to: string
}

/** Resumo do que muda (para o aviso de status). Nunca vazio de sentido: "(vazio)" para campo limpo. */
export function describeCompanyChanges(dto: CompanyProfileDTO, payload: UpdateCompanyProfileRequest): CompanyChangeItem[] {
  return (Object.keys(payload) as Array<keyof UpdateCompanyProfileRequest>)
    .filter((key): key is CompanyField => key !== "confirmVersionChange")
    .map((field) => ({ key: field, label: FIELD_LABELS[field], from: savedValue(dto, field) || "(vazio)", to: (payload[field] as string | null) ?? "(vazio)" }))
}

/** O PUT altera a versão EFETIVA dos Termos ou da Privacidade? Em branco volta a valer a versão do servidor (`env...Version`). Espelha o servidor; ele confere de novo (409). */
export function versionWouldChange(dto: CompanyProfileDTO, payload: UpdateCompanyProfileRequest): boolean {
  const nextTerms = payload.termsVersion === undefined ? dto.versions.termsVersion : (payload.termsVersion ?? dto.versions.envTermsVersion)
  const nextPrivacy = payload.privacyVersion === undefined ? dto.versions.privacyVersion : (payload.privacyVersion ?? dto.versions.envPrivacyVersion)
  return nextTerms !== dto.versions.termsVersion || nextPrivacy !== dto.versions.privacyVersion
}

// ---------------------------------------------------------------------------
// Erros HTTP por `code`
// ---------------------------------------------------------------------------

export interface CompanyError {
  code: string | undefined
  status: number | undefined
  /** Texto pronto, escolhido por `code`/status. NUNCA o `error` do servidor. */
  message: string
  /** Campos do formulário a que o erro aponta (`VALIDATION_ERROR` com `details[].path`). */
  fields: CompanyField[]
  /** `409 VERSION_CHANGE_NOT_CONFIRMED`: o que mudaria e quantos motoristas aceitam de novo. */
  versionChange?: VersionChangeDetail
  draftKept: boolean
}

export const MSG_COMPANY_FORBIDDEN = "Somente administradores podem ver e alterar os dados da empresa."
export const MSG_COMPANY_SESSION = "Sua sessão expirou. Entre de novo para continuar — nada foi alterado."
export const MSG_COMPANY_RATE_LIMITED = "Muitas alterações em pouco tempo. Aguarde um minuto e tente de novo."
export const MSG_COMPANY_UNAVAILABLE = "O servidor não conseguiu ler os dados da empresa agora. Nada foi alterado. Tente de novo em instantes."
export const MSG_COMPANY_INTERNAL = "Não foi possível concluir e nada foi alterado. Tente novamente."
export const MSG_COMPANY_NETWORK = "Não foi possível falar com o servidor. Confira a conexão e tente de novo — nada foi alterado."

const isField = (value: string): value is CompanyField => (PROFILE_FIELDS as readonly string[]).includes(value) || (VERSION_FIELDS as readonly string[]).includes(value)

/** Traduz o erro do GET/PUT por `code` (na falta dele, por status). Nunca ecoa o corpo da requisição nem o texto do servidor. */
export function parseCompanyError(err: unknown): CompanyError {
  const base = { code: undefined, status: undefined, fields: [] as CompanyField[], draftKept: true }
  if (!axios.isAxiosError(err) || !err.response) return { ...base, message: MSG_COMPANY_NETWORK }
  const status = err.response.status
  const body = err.response.data as { code?: unknown; details?: unknown } | undefined
  const code = typeof body?.code === "string" ? body.code : undefined
  const details = Array.isArray(body?.details) ? body.details.filter((d): d is Record<string, unknown> => !!d && typeof d === "object") : []
  const out = (message: string, extra: Partial<CompanyError> = {}): CompanyError => ({ ...base, code, status, message, ...extra })

  if (code === "UNAUTHORIZED" || (code === undefined && status === 401)) return out(MSG_COMPANY_SESSION, { draftKept: false })
  switch (code) {
    case "FORBIDDEN":
      return out(MSG_COMPANY_FORBIDDEN)
    case "RATE_LIMITED":
    case "RATE_LIMITED_COMMUNICATION_SETTINGS":
      return out(MSG_COMPANY_RATE_LIMITED)
    case "VERSION_CHANGE_NOT_CONFIRMED": {
      const d = details[0]
      const versionChange =
        d && typeof d.driversAffected === "number"
          ? ({
              field: "confirmVersionChange",
              reason: "REQUIRED_TRUE",
              currentTermsVersion: String(d.currentTermsVersion ?? ""),
              currentPrivacyVersion: String(d.currentPrivacyVersion ?? ""),
              newTermsVersion: String(d.newTermsVersion ?? ""),
              newPrivacyVersion: String(d.newPrivacyVersion ?? ""),
              driversAffected: d.driversAffected,
            } satisfies VersionChangeDetail)
          : undefined
      return out("Mudar a versão dos Termos ou da Privacidade obriga todos os motoristas a aceitar de novo. Confirme para continuar.", { versionChange })
    }
    case "VALIDATION_ERROR": {
      const fields = details.map((d) => (typeof d.path === "string" ? d.path : "")).filter(isField)
      const labels = [...new Set(fields.map((f) => FIELD_LABELS[f]))]
      return out(`O servidor não aceitou algum valor${labels.length > 0 ? ` (${labels.join(", ")})` : ""}. Revise os campos e tente de novo.`, { fields })
    }
    default:
      if (status === 429) return out(MSG_COMPANY_RATE_LIMITED)
      if (status === 503) return out(MSG_COMPANY_UNAVAILABLE)
      return out(status >= 500 ? MSG_COMPANY_INTERNAL : "Não foi possível concluir a operação. Tente de novo em instantes.")
  }
}
