import { isValidCnpj, formatCnpj, normalizeCnpj, normalizeWebsite } from "@/lib/companyProfile"
import type { CompanyProfileDTO, LegalDataSource, UpdateCompanyProfileRequest } from "@/types/api"

/**
 * Espelho (no que a tela precisa provar) de `GET/PUT /api/admin/company-profile` (Admin > Configurações > Geral). Formato: `docs/CONTRATO-EMPRESA-ADMIN.md`.
 * NADA aqui foi provado contra o backend real.
 *
 * Regras espelhadas: campo ausente = não mexer; `null`/vazio = limpar; `strict` (campo desconhecido = 400); ao menos um campo além de `confirmVersionChange` (400);
 * valores NORMALIZADOS (CNPJ só com 14 caracteres e formatado na resposta, site canônico, e-mail em minúsculas); a 1ª gravação de dado da empresa faz o painel assumir o grupo
 * (`source` vira `db`); MUDAR a versão efetiva dos Termos/Privacidade sem `confirmVersionChange: true` = 409 `VERSION_CHANGE_NOT_CONFIRMED` (nada gravado, com `driversAffected`).
 *
 * CENÁRIOS (mesmas contas de `communicationData.ts`; estado por usuário, em memória da PÁGINA):
 *  - `admin@innoelektron.com`                    -> `env`: razão social, CNPJ e telefone vindos das variáveis `LEGAL_*`; versões do servidor;
 *  - `comunicacao-pronta@` e `-rede-privada@`    -> `db`: dados completos e versões salvas no painel;
 *  - `comunicacao-vazia@`                        -> `env`, nada informado e `LEGAL_CNPJ` com valor inválido (`invalidEnvFields`);
 *  - `comunicacao-indisponivel@`                 -> o GET devolve 503 `LEGAL_SETTINGS_UNAVAILABLE`.
 * GATILHOS (o PUT NÃO grava): razão social `Limite Ltda` -> 429 `RATE_LIMITED`; `Erro 500 Ltda` -> 500.
 */

type Fields = CompanyProfileDTO["profile"]

interface Scenario {
  source: LegalDataSource
  profile: Fields
  termsVersion: string
  privacyVersion: string
  termsSource: LegalDataSource
  privacySource: LegalDataSource
  envTermsVersion: string
  envPrivacyVersion: string
  invalidEnvFields: string[]
  updatedAt: string | null
}

const ENV_VERSION = "2026-09-01"
export const MOCK_DRIVERS_AFFECTED = 42

const EMPTY: Fields = { legalName: null, tradeName: null, cnpj: null, supportEmail: null, supportPhone: null, address: null, website: null, dpoName: null, dpoEmail: null }

function seed(userId: string): Scenario {
  const base = { envTermsVersion: ENV_VERSION, envPrivacyVersion: ENV_VERSION, invalidEnvFields: [] as string[] }
  switch (userId) {
    case "user_admin_comunicacao_pronta":
    case "user_admin_comunicacao_rede_privada":
    case "user_admin_comunicacao_indisponivel":
      return {
        ...base,
        source: "db",
        profile: {
          legalName: "InnoFlow Mobilidade Elétrica Ltda",
          tradeName: "InnoFlow",
          cnpj: "11.222.333/0001-81",
          supportEmail: "suporte@innoflow.example",
          supportPhone: "(11) 4000-1234",
          address: "Av. Paulista, 1000, São Paulo/SP",
          website: "https://www.innoflow.example",
          dpoName: "Marina Souza",
          dpoEmail: "dpo@innoflow.example",
        },
        termsVersion: "2026-10-01",
        privacyVersion: "2026-10-01",
        termsSource: "db",
        privacySource: "db",
        updatedAt: "2026-10-04T13:20:00.000Z",
      }
    case "user_admin_comunicacao_vazia":
      return { ...base, invalidEnvFields: ["LEGAL_CNPJ"], source: "env", profile: { ...EMPTY }, termsVersion: ENV_VERSION, privacyVersion: ENV_VERSION, termsSource: "env", privacySource: "env", updatedAt: null }
    default:
      return {
        ...base,
        source: "env",
        profile: { ...EMPTY, legalName: "InnoFlow Mobilidade Elétrica Ltda", cnpj: "11.222.333/0001-81", supportEmail: "suporte@innoflow.example", supportPhone: "(11) 4000-1234" },
        termsVersion: ENV_VERSION,
        privacyVersion: ENV_VERSION,
        termsSource: "env",
        privacySource: "env",
        updatedAt: null,
      }
  }
}

const scenarios = new Map<string, Scenario>()
function scenarioFor(userId: string): Scenario {
  let scenario = scenarios.get(userId)
  if (!scenario) {
    scenario = seed(userId)
    scenarios.set(userId, scenario)
  }
  return scenario
}

function toDto(s: Scenario): CompanyProfileDTO {
  return {
    source: s.source,
    profile: { ...s.profile },
    versions: {
      termsVersion: s.termsVersion,
      privacyVersion: s.privacyVersion,
      termsSource: s.termsSource,
      privacySource: s.privacySource,
      envTermsVersion: s.envTermsVersion,
      envPrivacyVersion: s.envPrivacyVersion,
    },
    invalidEnvFields: s.source === "env" ? [...s.invalidEnvFields] : [],
    updatedAt: s.updatedAt,
  }
}

type Status = 400 | 409 | 429 | 500 | 503
export type CompanyFailure = { ok: false; status: Status; code: string; message: string; details?: unknown; headers?: Record<string, string> }
export type CompanyResult = { ok: true; dto: CompanyProfileDTO } | CompanyFailure
const fail = (status: Status, code: string, message: string, details?: unknown, headers?: Record<string, string>): CompanyFailure => ({ ok: false, status, code, message, details, headers })

export function getCompanyProfile(userId: string): CompanyResult {
  if (userId === "user_admin_comunicacao_indisponivel") return fail(503, "LEGAL_SETTINGS_UNAVAILABLE", "Não foi possível ler os dados da empresa.")
  return { ok: true, dto: toDto(scenarioFor(userId)) }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const FIELD_KEYS = ["legalName", "tradeName", "cnpj", "supportEmail", "supportPhone", "address", "website", "dpoName", "dpoEmail"] as const
const KNOWN = new Set<string>([...FIELD_KEYS, "termsVersion", "privacyVersion", "confirmVersionChange"])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[0-9+()\s.-]{8,30}$/
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/
const LIMITS: Record<(typeof FIELD_KEYS)[number], number> = { legalName: 160, tradeName: 120, cnpj: 100, supportEmail: 180, supportPhone: 100, address: 300, website: 2000, dpoName: 120, dpoEmail: 180 }

const oneLine = (v: unknown): string | null => (typeof v === "string" ? v.replace(/[\n\r\t]/g, " ").trim() || null : null)
const validationFail = (path: string, message: string) => fail(400, "VALIDATION_ERROR", `${path}: ${message}`, [{ path, message }])

/** Aplica um PUT. Valida tudo ANTES de mexer no estado (um 4xx/5xx nunca deixa meia alteração). */
export function updateCompanyProfile(userId: string, body: unknown): CompanyResult {
  const scenario = scenarioFor(userId)
  const input = (isObject(body) ? body : {}) as UpdateCompanyProfileRequest & Record<string, unknown>

  if (input.legalName === "Limite Ltda") return fail(429, "RATE_LIMITED", "Muitas alterações. Aguarde um minuto.", undefined, { "retry-after": "60" })
  if (input.legalName === "Erro 500 Ltda") return fail(500, "INTERNAL_ERROR", "Erro interno.")

  for (const key of Object.keys(input)) if (!KNOWN.has(key)) return validationFail(key, "campo desconhecido.")
  if (!Object.entries(input).some(([k, v]) => k !== "confirmVersionChange" && v !== undefined)) return validationFail("body", "informe ao menos um campo para alterar.")
  if (input.confirmVersionChange !== undefined && typeof input.confirmVersionChange !== "boolean") return validationFail("confirmVersionChange", "deve ser booleano.")

  // Normaliza cada campo informado (undefined = não mexer; null = limpar).
  const next: Partial<Record<(typeof FIELD_KEYS)[number], string | null>> = {}
  for (const key of FIELD_KEYS) {
    const raw = input[key]
    if (raw === undefined) continue
    if (raw !== null && typeof raw !== "string") return validationFail(key, "deve ser texto ou nulo.")
    const text = oneLine(raw)
    if (text !== null && text.length > LIMITS[key]) return validationFail(key, `use no máximo ${LIMITS[key]} caracteres.`)
    if (text === null) {
      next[key] = null
      continue
    }
    if (key === "cnpj") {
      if (!isValidCnpj(text)) return validationFail("cnpj", "CNPJ inválido: confira os números (os dois últimos são os dígitos verificadores).")
      next.cnpj = formatCnpj(normalizeCnpj(text))
    } else if (key === "supportEmail" || key === "dpoEmail") {
      const email = text.toLowerCase()
      if (email.length > 180 || !EMAIL_RE.test(email)) return validationFail(key, "e-mail inválido.")
      next[key] = email
    } else if (key === "supportPhone") {
      if (!(PHONE_RE.test(text) && (text.match(/\d/g)?.length ?? 0) >= 8)) return validationFail(key, "telefone inválido.")
      next[key] = text
    } else if (key === "website") {
      const site = normalizeWebsite(text)
      if (site === null) return validationFail(key, "endereço do site inválido.")
      next[key] = site
    } else {
      next[key] = text
    }
  }
  const versions: { termsVersion?: string | null; privacyVersion?: string | null } = {}
  for (const key of ["termsVersion", "privacyVersion"] as const) {
    const raw = input[key]
    if (raw === undefined) continue
    if (raw !== null && typeof raw !== "string") return validationFail(key, "deve ser texto ou nulo.")
    const text = oneLine(raw)
    if (text !== null && !VERSION_RE.test(text)) return validationFail(key, "versão inválida.")
    versions[key] = text
  }

  // Versão EFETIVA antes x depois (a env é a reserva de quem fica em branco).
  const nextTerms = versions.termsVersion === undefined ? scenario.termsVersion : (versions.termsVersion ?? scenario.envTermsVersion)
  const nextPrivacy = versions.privacyVersion === undefined ? scenario.privacyVersion : (versions.privacyVersion ?? scenario.envPrivacyVersion)
  const versionChanged = nextTerms !== scenario.termsVersion || nextPrivacy !== scenario.privacyVersion
  if (versionChanged && input.confirmVersionChange !== true) {
    return fail(409, "VERSION_CHANGE_NOT_CONFIRMED", "Confirme a mudança de versão.", [
      {
        field: "confirmVersionChange",
        reason: "REQUIRED_TRUE",
        currentTermsVersion: scenario.termsVersion,
        currentPrivacyVersion: scenario.privacyVersion,
        newTermsVersion: nextTerms,
        newPrivacyVersion: nextPrivacy,
        driversAffected: MOCK_DRIVERS_AFFECTED,
      },
    ])
  }

  if (Object.keys(next).length > 0) {
    scenario.profile = { ...scenario.profile, ...next }
    scenario.source = "db"
  }
  if (versions.termsVersion !== undefined) {
    scenario.termsVersion = nextTerms
    scenario.termsSource = versions.termsVersion === null ? "env" : "db"
  }
  if (versions.privacyVersion !== undefined) {
    scenario.privacyVersion = nextPrivacy
    scenario.privacySource = versions.privacyVersion === null ? "env" : "db"
  }
  scenario.updatedAt = new Date().toISOString()
  return { ok: true, dto: toDto(scenario) }
}
