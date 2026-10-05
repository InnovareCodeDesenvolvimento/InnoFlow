import axios from "axios"
import { getApiErrorCode, getApiErrorStatus } from "@/services/api"
import { NETWORK_ERROR_MESSAGE, RATE_LIMITED_ACCOUNT_MESSAGE, SERVER_UNSTABLE_MESSAGE } from "@/lib/authErrors"
import type { ApiErrorBody } from "@/types/api"

/**
 * Erro do axios -> texto das telas de perfil (dados e senha). Lógica PURA sobre `status`/`code`: nunca o texto do backend (não é a nossa voz e pode mudar).
 * Ordem: sem resposta (rede/timeout/CORS) -> 5xx -> 429 -> `code`. Os textos de rede, 5xx e limite são os de `authErrors.ts` (mesma voz do login); o limite do perfil
 * e o da senha são POR USUÁRIO, então "esta conta" cabe (`RATE_LIMITED_ACCOUNT_MESSAGE`).
 *
 * 401 não deveria chegar aqui com sessão válida: o interceptor de `services/api.ts` já limpou a sessão e mandou para o login. 403 `INVALID_CURRENT_PASSWORD` NÃO
 * desloga (é 403 de propósito).
 */

export const SESSION_EXPIRED_MESSAGE = "Sua sessão expirou. Entre novamente."

function sharedMessage(err: unknown): { message: string } | null {
  const status = getApiErrorStatus(err)
  const code = getApiErrorCode(err)
  if (axios.isAxiosError(err)) {
    if (status === undefined) return { message: NETWORK_ERROR_MESSAGE }
    if (status >= 500) return { message: SERVER_UNSTABLE_MESSAGE }
  }
  if (status === 429 || code === "RATE_LIMITED_PASSWORD" || code === "RATE_LIMITED_PROFILE") return { message: RATE_LIMITED_ACCOUNT_MESSAGE }
  if (status === 401 || code === "UNAUTHORIZED") return { message: SESSION_EXPIRED_MESSAGE }
  return null
}

export const PROFILE_LOAD_FALLBACK_MESSAGE = "Não foi possível carregar seu perfil. Tente novamente."

/** Erro ao CARREGAR o perfil (`GET`): mesmo critério - rede, 5xx e limite têm texto próprio; o resto cai num texto fixo nosso. */
export function profileLoadError(err: unknown): string {
  return sharedMessage(err)?.message ?? PROFILE_LOAD_FALLBACK_MESSAGE
}

// ---- Troca de senha ---------------------------------------------------------------------------------------------------------------------------------

export type PasswordField = "currentPassword" | "newPassword"
export interface PasswordChangeError {
  message: string
  /** Quando o erro é de UM campo, a tela o mostra nele e leva o foco para lá; sem `field` é aviso do formulário. */
  field?: PasswordField
}

export const PASSWORD_CHANGE_FALLBACK_MESSAGE = "Não foi possível alterar a senha. Tente novamente."

export function passwordChangeError(err: unknown): PasswordChangeError {
  const shared = sharedMessage(err)
  if (shared) return shared
  switch (getApiErrorCode(err)) {
    case "INVALID_CURRENT_PASSWORD":
      return { field: "currentPassword", message: "Senha atual incorreta." }
    case "CURRENT_PASSWORD_REQUIRED":
      return { field: "currentPassword", message: "Informe a senha atual." }
    case "PASSWORD_UNCHANGED":
      return { field: "newPassword", message: "A nova senha precisa ser diferente da atual." }
    case "VALIDATION_ERROR":
      return { field: "newPassword", message: "A nova senha precisa ter de 10 caracteres a 72 bytes." }
    default:
      return { message: PASSWORD_CHANGE_FALLBACK_MESSAGE }
  }
}

// ---- Dados do perfil --------------------------------------------------------------------------------------------------------------------------------

export type ProfileField = "name" | "phone" | "cpf"
export interface ProfileSaveError {
  message: string
  fields?: Partial<Record<ProfileField, string>>
}

export const PROFILE_SAVE_FALLBACK_MESSAGE = "Não foi possível salvar os dados. Tente novamente."
export const CPF_IN_USE_MESSAGE = "Este CPF já está cadastrado em outra conta."

const FIELD_MESSAGES: Record<ProfileField, string> = {
  name: "Confira o nome (de 1 a 120 caracteres).",
  phone: "Confira o telefone (de 8 a 15 dígitos).",
  cpf: "CPF inválido.",
}

/** `details[].path` do 400 `VALIDATION_ERROR`: o caminho decide o campo; o texto do servidor é ignorado. */
function invalidFields(err: unknown): Partial<Record<ProfileField, string>> {
  if (!axios.isAxiosError<ApiErrorBody>(err)) return {}
  const out: Partial<Record<ProfileField, string>> = {}
  for (const d of err.response?.data?.details ?? []) {
    const field = typeof d.path === "string" ? d.path.split(".")[0] : undefined
    if (field === "name" || field === "phone" || field === "cpf") out[field] = FIELD_MESSAGES[field]
  }
  return out
}

export function profileSaveError(err: unknown): ProfileSaveError {
  const shared = sharedMessage(err)
  if (shared) return shared
  switch (getApiErrorCode(err)) {
    case "CPF_IN_USE":
      return { message: CPF_IN_USE_MESSAGE, fields: { cpf: CPF_IN_USE_MESSAGE } }
    case "VALIDATION_ERROR": {
      const fields = invalidFields(err)
      return Object.keys(fields).length > 0 ? { message: "Confira os campos destacados.", fields } : { message: "Confira os dados informados." }
    }
    default:
      return { message: PROFILE_SAVE_FALLBACK_MESSAGE }
  }
}
