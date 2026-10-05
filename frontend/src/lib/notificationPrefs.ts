import axios from "axios"
import { getApiErrorCode, getApiErrorStatus } from "@/services/api"
import { NETWORK_ERROR_MESSAGE, SERVER_UNSTABLE_MESSAGE } from "@/lib/authErrors"
import { parseReaisToCents } from "@/lib/money"
import { formatCents } from "@/lib/utils"
import {
  LOW_BALANCE_THRESHOLD_MAX_CENTS,
  LOW_BALANCE_THRESHOLD_MIN_CENTS,
  type MeNotificationPreferences,
  type UpdateMeNotificationPreferencesRequest,
} from "@/types/api"

/**
 * Preferências de notificação do motorista (L1.6) - lógica PURA. Só há DOIS interruptores (recibo por e-mail e aviso de saldo baixo) e o limiar em reais; os avisos de segurança
 * e de cobrança são SEMPRE enviados e não têm chave (DL5; `ALWAYS_ON_NOTIFICATION_TYPES` em `types/api.ts`) - a tela os lista como informação, sem interruptor.
 * Erros por `status`/`code`, nunca pelo texto do backend.
 */

export const THRESHOLD_RANGE_HINT = `De ${formatCents(LOW_BALANCE_THRESHOLD_MIN_CENTS)} a ${formatCents(LOW_BALANCE_THRESHOLD_MAX_CENTS)}.`
export const THRESHOLD_INVALID_MESSAGE = `Informe um valor entre ${formatCents(LOW_BALANCE_THRESHOLD_MIN_CENTS)} e ${formatCents(LOW_BALANCE_THRESHOLD_MAX_CENTS)}, por exemplo 20,00.`

/** Centavos -> texto do campo, sem "R$" ("2000" -> "20,00"). */
export function centsToFieldText(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",")
}

/** Texto do campo -> centavos inteiros dentro do intervalo do servidor, ou `null`. */
export function parseThresholdCents(text: string): number | null {
  const cents = parseReaisToCents(text)
  if (cents === null || cents < LOW_BALANCE_THRESHOLD_MIN_CENTS || cents > LOW_BALANCE_THRESHOLD_MAX_CENTS) return null
  return cents
}

export interface NotificationFormState {
  sessionReceiptEmail: boolean
  lowBalanceEnabled: boolean
  thresholdText: string
}

export function formStateFrom(prefs: MeNotificationPreferences): NotificationFormState {
  return { sessionReceiptEmail: prefs.sessionReceiptEmail, lowBalanceEnabled: prefs.lowBalanceEnabled, thresholdText: centsToFieldText(prefs.lowBalanceThresholdCents) }
}

export type PatchResult = { ok: true; patch: UpdateMeNotificationPreferencesRequest | null } | { ok: false; thresholdError: string }

/**
 * O que mudou em relação ao salvo, só as chaves alteradas (`null` = nada mudou). O limiar só é validado/enviado com o aviso LIGADO (desligado, o campo fica inativo e o valor
 * salvo é mantido): a pessoa pode desligar o aviso sem ter de consertar um valor digitado errado.
 */
export function buildNotificationPatch(form: NotificationFormState, saved: MeNotificationPreferences): PatchResult {
  const patch: UpdateMeNotificationPreferencesRequest = {}
  if (form.sessionReceiptEmail !== saved.sessionReceiptEmail) patch.sessionReceiptEmail = form.sessionReceiptEmail
  if (form.lowBalanceEnabled !== saved.lowBalanceEnabled) patch.lowBalanceEnabled = form.lowBalanceEnabled
  if (form.lowBalanceEnabled) {
    const cents = parseThresholdCents(form.thresholdText)
    if (cents === null) return { ok: false, thresholdError: THRESHOLD_INVALID_MESSAGE }
    if (cents !== saved.lowBalanceThresholdCents) patch.lowBalanceThresholdCents = cents
  }
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : null }
}

export const NOTIFICATIONS_LOAD_FALLBACK = "Não foi possível carregar as suas preferências. Tente novamente."
export const NOTIFICATIONS_SAVE_FALLBACK = "Não foi possível salvar as preferências. Tente novamente."
export const NOTIFICATIONS_SAVED_MESSAGE = "Preferências salvas."
const SESSION_EXPIRED = "Sua sessão expirou. Entre novamente."

function transport(err: unknown): string | null {
  if (!axios.isAxiosError(err)) return null
  const status = getApiErrorStatus(err)
  if (status === undefined) return NETWORK_ERROR_MESSAGE
  if (status >= 500) return SERVER_UNSTABLE_MESSAGE
  return null
}

export function notificationLoadError(err: unknown): string {
  const t = transport(err)
  if (t) return t
  if (getApiErrorStatus(err) === 403) return "Esta conta não tem preferências de notificação."
  return NOTIFICATIONS_LOAD_FALLBACK
}

export interface NotificationSaveError {
  message: string
  /** `true` = o erro é do campo do limiar (vai nele, com o foco). */
  threshold?: boolean
}

export function notificationSaveError(err: unknown): NotificationSaveError {
  const t = transport(err)
  if (t) return { message: t }
  const status = getApiErrorStatus(err)
  const code = getApiErrorCode(err)
  if (status === 429 || code === "RATE_LIMITED") return { message: "Muitas alterações em pouco tempo. Aguarde alguns minutos e tente de novo." }
  if (code === "VALIDATION_ERROR") return { message: THRESHOLD_INVALID_MESSAGE, threshold: true }
  if (status === 401 || code === "UNAUTHORIZED") return { message: SESSION_EXPIRED }
  if (status === 403 || code === "FORBIDDEN") return { message: "Esta conta não tem preferências de notificação." }
  return { message: NOTIFICATIONS_SAVE_FALLBACK }
}

/** Avisos que NÃO têm interruptor, para a tela mostrar como informação (texto do time/DL5). */
export const ALWAYS_ON_NOTICES: ReadonlyArray<{ title: string; text: string }> = [
  { title: "Segurança", text: "Troca de senha e exclusão de conta." },
  { title: "Cobrança pendente", text: "Quando a cobrança de uma recarga falha e fica valor em aberto." },
]
export const ALWAYS_ON_EXTRA = "Também são sempre enviados o aviso de Pix creditado e o de recarga iniciada pelo suporte."
