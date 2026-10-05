/**
 * Mock do PERFIL do motorista (L1.2) e da TROCA DE SENHA - estado em memória por usuário e as mesmas regras do backend
 * (`backend/src/api/schemas/meProfile.schema.ts`, `auth.schema.ts#changePasswordSchema`, `auth.routes.ts` POST /password). NÃO é regra de negócio nova: é o suficiente para
 * provar no navegador que a tela fala o contrato de `types/api.ts`. O estado vive na PÁGINA (como o resto do MSW): `page.goto` o zera.
 *
 * Gatilhos de falha por `localStorage` (os handlers rodam na página):
 *  - `mock:profile-get`   = `network` | `500` | `empty` | `slow` -> falha o GET /api/me/profile (`empty` = 200 com corpo vazio; `slow` = responde com 4 s de atraso, para medir o esqueleto);
 *  - `mock:profile-patch` = `network` | `500` | `429`    -> falha o PATCH (o 400 e o 409 saem das regras: CPF inválido, `CPF_EM_USO`);
 *  - `mock:password-fail` = `network` | `500` | `429`    -> falha POST /api/auth/password (403/400 saem das regras: senha atual errada, nova igual).
 */
import { isValidCpf, onlyDigits } from "@/lib/cpf"
import { cardEligibilityFor, isMockDriverGoogleLinked } from "./meData"
import type { MockUser } from "./data"
import type { MeProfile } from "@/types/api"

/** CPF válido que o mock trata como "já é de OUTRA conta" (409 `CPF_IN_USE`). */
export const CPF_EM_USO_MOCK = "11144477735"

const PERFIL_DRIVER_ID = "user_driver_perfil"

interface ProfileState {
  phone: string | null
  cpf: string | null
}

const states = new Map<string, ProfileState>()

function stateFor(userId: string): ProfileState {
  let s = states.get(userId)
  if (!s) {
    s = userId === PERFIL_DRIVER_ID ? { phone: "(11) 91234-5678", cpf: "52998224725" } : { phone: null, cpf: null }
    states.set(userId, s)
  }
  return s
}

export function maskCpf(digits: string): string {
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`
}

export function mockHasPassword(user: MockUser): boolean {
  return user.hasPassword ?? user.password !== ""
}

export function getMockProfile(user: MockUser): MeProfile {
  const s = stateFor(user.id)
  const hasPassword = mockHasPassword(user)
  const googleLinked = isMockDriverGoogleLinked(user.id) || !hasPassword
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: s.phone,
    cpfMasked: s.cpf ? maskCpf(s.cpf) : null,
    hasPassword,
    googleLinked,
    // Mesma regra do I-7: só falta identidade para quem nunca vinculou o Google E o cartão está recusando por isso.
    identityVerified: cardEligibilityFor(user.id).reason !== "GOOGLE_LOGIN_REQUIRED",
    createdAt: "2026-08-15T12:00:00.000Z",
  }
}

export interface ProfileIssue {
  path: string
  message: string
}

/** Mesmas regras do `updateMeProfileSchema` (corpo estrito, ao menos um campo, nome 1-120, telefone 8-15 dígitos, CPF com dígito verificador). */
export function validateProfilePatch(body: unknown): { issues: ProfileIssue[]; patch: { name?: string; phone?: string | null; cpf?: string | null } } {
  const issues: ProfileIssue[] = []
  const patch: { name?: string; phone?: string | null; cpf?: string | null } = {}
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!["name", "phone", "cpf"].includes(key)) issues.push({ path: key, message: "Unrecognized key" })
  }
  if (raw.name !== undefined) {
    const name = typeof raw.name === "string" ? raw.name.trim() : ""
    if (name.length < 1 || name.length > 120) issues.push({ path: "name", message: "Informe o nome." })
    else patch.name = name
  }
  if (raw.phone !== undefined) {
    if (raw.phone === null) patch.phone = null
    else {
      const phone = typeof raw.phone === "string" ? raw.phone.trim() : ""
      const digits = onlyDigits(phone).length
      if (phone.length > 30 || !/^[0-9+()\s-]+$/.test(phone) || digits < 8 || digits > 15) issues.push({ path: "phone", message: "Telefone inválido." })
      else patch.phone = phone
    }
  }
  if (raw.cpf !== undefined) {
    if (raw.cpf === null) patch.cpf = null
    else {
      const digits = typeof raw.cpf === "string" ? onlyDigits(raw.cpf) : ""
      if (!isValidCpf(digits)) issues.push({ path: "cpf", message: "CPF inválido." })
      else patch.cpf = digits
    }
  }
  if (issues.length === 0 && Object.keys(patch).length === 0) issues.push({ path: "", message: "Informe ao menos um campo para alterar." })
  return { issues, patch }
}

export function applyProfilePatch(user: MockUser, patch: { name?: string; phone?: string | null; cpf?: string | null }): MeProfile {
  const s = stateFor(user.id)
  if (patch.name !== undefined) user.name = patch.name
  if (patch.phone !== undefined) s.phone = patch.phone
  if (patch.cpf !== undefined) s.cpf = patch.cpf
  return getMockProfile(user)
}

// ---- Sessões e troca de senha ---------------------------------------------------------------------------------------------------------------------------

/**
 * "Época" da sessão por usuário. `POST /api/auth/password` real grava `sessionsValidAfter = agora`, o que mata TODO token anterior. Aqui: o token carrega `v` (época em que
 * foi emitido) e um token de época MENOR que a atual é recusado (401). Só "menor": depois de `page.goto` o módulo recomeça na época 0 e o token novo (v1) continua valendo.
 */
const sessionEpochs = new Map<string, number>()

export function sessionEpochOf(userId: string): number {
  return sessionEpochs.get(userId) ?? 0
}

export function bumpSessionEpoch(userId: string): number {
  const next = sessionEpochOf(userId) + 1
  sessionEpochs.set(userId, next)
  return next
}

/** Limite real: 8 tentativas por 15 min por USUÁRIO (`changePasswordRateLimit`). Conta toda chamada, certa ou errada. */
const PASSWORD_ATTEMPTS_MAX = 8
const passwordAttempts = new Map<string, number>()

export function registerPasswordAttempt(userId: string): boolean {
  const n = (passwordAttempts.get(userId) ?? 0) + 1
  passwordAttempts.set(userId, n)
  return n <= PASSWORD_ATTEMPTS_MAX
}

/** Mesma regra do `changePasswordSchema`: mínimo 10 caracteres e máximo 72 BYTES. */
export function isValidNewPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 10 && new TextEncoder().encode(value).length <= 72
}
