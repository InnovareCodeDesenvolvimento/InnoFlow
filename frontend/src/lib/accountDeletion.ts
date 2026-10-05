import axios from "axios"
import { getApiErrorCode, getApiErrorStatus } from "@/services/api"
import { NETWORK_ERROR_MESSAGE, SERVER_UNSTABLE_MESSAGE } from "@/lib/authErrors"
import { retryAfterSeconds, waitPhrase } from "@/lib/passwordReset"
import type { ApiErrorBody, MeAccountDeletionResponse } from "@/types/api"

/**
 * Privacidade e dados (L1.4, LGPD): exportação e exclusão de conta. Lógica PURA (sem DOM/rede) - a tela só monta o que isto decide. Trata sempre por `status`/`code` (e
 * `details[].path` no 400), nunca pelo texto do backend.
 */

// ---- Textos ---------------------------------------------------------------------------------------------------------------------------------------------

/** Aviso do 1º passo da exclusão - texto DEFINIDO pelo time, não reescrever sem decisão do dono. */
export const DELETION_WARNING_TEXT =
  "Exclusão da conta é definitiva. Seus dados pessoais são apagados (nome, e-mail, telefone, CPF, cartões salvos). Registros financeiros das recargas (valores, datas, extrato) são mantidos, sem identificação, por obrigação legal. Você não consegue excluir com recarga ou pagamento em andamento ou com dívida em aberto. Saldo restante é devolvido por Pix, em até 30 dias, para a chave que você informar."

export const EXPORT_DESCRIPTION = "Baixe uma cópia dos seus dados em JSON (até 3 vezes por dia)."

/** A palavra que a pessoa digita para confirmar. O servidor exige o literal `"EXCLUIR"`. */
export const DELETION_CONFIRM_WORD = "EXCLUIR"

/** Maiúsculas/minúsculas e espaços nas pontas não contam como erro de quem digita; o que vai ao servidor é sempre o literal. */
export function isDeletionWordConfirmed(typed: string): boolean {
  return typed.trim().toLocaleUpperCase("pt-BR") === DELETION_CONFIRM_WORD
}

// ---- Exportação -----------------------------------------------------------------------------------------------------------------------------------------

/** Nome do arquivo: o mesmo que o servidor sugere (`innoflow-meus-dados-AAAAMMDD.json`). O header `Content-Disposition` não é legível entre domínios (CORS), então a tela monta o nome. */
export function exportFileName(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `innoflow-meus-dados-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.json`
}

export const EXPORT_DONE_MESSAGE = "Cópia dos seus dados baixada."
export const EXPORT_FALLBACK_MESSAGE = "Não foi possível gerar a cópia agora. Tente novamente."
export const SESSION_EXPIRED_MESSAGE = "Sua sessão expirou. Entre novamente."

/** Erro do `GET /api/me/data-export`. 429 = limite de 3 por dia (com o tempo exato quando `Retry-After` é legível). */
export function exportErrorMessage(err: unknown): string {
  const status = getApiErrorStatus(err)
  const code = getApiErrorCode(err)
  if (axios.isAxiosError(err)) {
    if (status === undefined) return NETWORK_ERROR_MESSAGE
    if (status >= 500) return SERVER_UNSTABLE_MESSAGE
  }
  if (code === "RATE_LIMITED_EXPORT" || status === 429) {
    const seconds = retryAfterSeconds(err)
    return seconds === null ? "Você já baixou 3 cópias hoje. Tente de novo amanhã." : `Você já baixou 3 cópias hoje. Tente de novo em ${waitPhrase(seconds)}.`
  }
  if (status === 401 || code === "UNAUTHORIZED") return SESSION_EXPIRED_MESSAGE
  if (status === 403 || code === "FORBIDDEN") return "Esta conta não pode baixar os dados por aqui."
  return EXPORT_FALLBACK_MESSAGE
}

// ---- Exclusão: erros --------------------------------------------------------------------------------------------------------------------------------------

/** Os passos do diálogo. `pix` só existe quando há saldo a devolver. */
export type DeletionStepId = "info" | "pix" | "confirm"
export type DeletionField = "pix" | "password" | "google"

export interface DeletionError {
  message: string
  /** Passo para o qual a tela volta (onde o erro se corrige). Sem `step`, o aviso fica no passo atual. */
  step?: DeletionStepId
  /** Campo que recebe o erro e o foco. */
  field?: DeletionField
  /** Caminho de saída para erros que o próprio titular resolve (quitar a dívida, encerrar a sessão). */
  link?: { to: string; label: string }
  /** Erro que NÃO se resolve repetindo o envio (dívida, sessão, pagamento em andamento): o botão de excluir fica desabilitado até a pessoa voltar. */
  blocking?: boolean
  /** Reautenticação com Google: a credencial usada foi recusada/gasta e precisa ser pedida de novo. */
  resetGoogle?: boolean
}

export const DELETION_FALLBACK_MESSAGE = "Não foi possível excluir a conta agora. Nada foi apagado. Tente novamente."

function invalidPaths(err: unknown): string[] {
  if (!axios.isAxiosError<ApiErrorBody>(err)) return []
  return (err.response?.data?.details ?? []).map((d) => (typeof d.path === "string" ? d.path.split(".")[0]! : "")).filter((p) => p !== "")
}

/** Erro do `POST /api/me/account/deletion` -> o que mostrar e para onde levar a pessoa. Em TODOS os casos de erro a conta NÃO foi excluída (a exclusão é uma transação só). */
export function accountDeletionError(err: unknown): DeletionError {
  const status = getApiErrorStatus(err)
  const code = getApiErrorCode(err)

  // Sem resposta (rede/timeout/CORS) e 5xx genérico: a exclusão é transacional, então "nada foi apagado" é verdade.
  if (axios.isAxiosError(err) && status === undefined) return { message: `${NETWORK_ERROR_MESSAGE} Sua conta não foi excluída.` }

  switch (code) {
    case "OPEN_DEBT":
      return { message: "Você tem uma dívida em aberto. Quite o valor na carteira e tente excluir a conta de novo.", step: "info", blocking: true, link: { to: "/app/carteira", label: "Ir para a carteira" } }
    case "ACTIVE_SESSION":
      return { message: "Há uma recarga em andamento (ou sendo encerrada). Encerre a sessão, espere o recibo e tente de novo.", step: "info", blocking: true, link: { to: "/app/sessao", label: "Ver a sessão" } }
    case "PAYMENT_IN_PROGRESS":
      return { message: "Há uma recarga ou um pagamento (Pix ou cartão) em andamento. Espere a conclusão ou o vencimento e tente de novo.", step: "info", blocking: true, link: { to: "/app/carteira", label: "Ir para a carteira" } }
    case "REFUND_PIX_KEY_REQUIRED":
      return { message: "Informe a chave Pix para receber a devolução do saldo.", step: "pix", field: "pix" }
    case "CURRENT_PASSWORD_REQUIRED":
      return { message: "Informe a sua senha atual para confirmar.", step: "confirm", field: "password" }
    case "INVALID_CURRENT_PASSWORD":
      return { message: "Senha incorreta.", step: "confirm", field: "password" }
    case "INVALID_GOOGLE_TOKEN":
      return { message: "Não foi possível validar a sua conta Google. Confirme de novo.", step: "confirm", field: "google", resetGoogle: true }
    case "GOOGLE_NOT_CONFIGURED":
      return { message: "O login com o Google está indisponível no momento. Tente de novo mais tarde. Sua conta não foi excluída.", step: "confirm", field: "google", resetGoogle: true }
    case "RATE_LIMITED_ACCOUNT_DELETION": {
      const seconds = retryAfterSeconds(err)
      return { message: `Muitas tentativas de exclusão. Tente de novo em ${waitPhrase(seconds)}. Sua conta não foi excluída.` }
    }
    case "PAYMENT_SECRETS_KEY_MISSING":
      return { message: "Não foi possível processar a devolução do saldo agora. Tente novamente mais tarde. Sua conta não foi excluída." }
    case "STEPUP_UNAVAILABLE":
      return { message: "Não foi possível confirmar a sua identidade agora. Tente novamente em instantes. Sua conta não foi excluída.", resetGoogle: true }
    case "FORBIDDEN":
      return { message: "Não foi possível confirmar a sua identidade para esta conta. Fale com o suporte.", blocking: true }
    case "VALIDATION_ERROR": {
      const paths = invalidPaths(err)
      if (paths.includes("refundPixKey")) return { message: "A chave Pix informada não é válida. Confira e tente de novo.", step: "pix", field: "pix" }
      if (paths.includes("googleCredential")) return { message: "Confirme a sua identidade com o Google para excluir a conta.", step: "confirm", field: "google", resetGoogle: true }
      return { message: "Confira os dados informados e tente de novo." }
    }
  }

  if (status === 429) {
    const seconds = retryAfterSeconds(err)
    return { message: `Muitas tentativas. Tente de novo em ${waitPhrase(seconds)}. Sua conta não foi excluída.` }
  }
  if (status !== undefined && status >= 500) return { message: `${SERVER_UNSTABLE_MESSAGE} Sua conta não foi excluída.` }
  if (status === 401 || code === "UNAUTHORIZED") return { message: SESSION_EXPIRED_MESSAGE }
  return { message: DELETION_FALLBACK_MESSAGE }
}

// ---- Exclusão: sucesso (aviso no login) ---------------------------------------------------------------------------------------------------------------

/**
 * Depois do 200 o token deixa de valer: a tela vai para `/login` com `state: { flash: "account-deleted", status }` (estado da ROTA, não storage - o Login lê na chegada, guarda em
 * estado local e apaga o estado da rota, porque `history.state` sobrevive ao F5).
 */
export const ACCOUNT_DELETED_FLASH = "account-deleted"

export function accountDeletedState(status: MeAccountDeletionResponse["status"]): { flash: typeof ACCOUNT_DELETED_FLASH; status: MeAccountDeletionResponse["status"] } {
  return { flash: ACCOUNT_DELETED_FLASH, status }
}

/** `null` = o estado da rota não é o aviso de conta excluída. */
export function readAccountDeletedFlash(state: unknown): MeAccountDeletionResponse["status"] | null {
  if (typeof state !== "object" || state === null) return null
  const s = state as { flash?: unknown; status?: unknown }
  if (s.flash !== ACCOUNT_DELETED_FLASH) return null
  return s.status === "DELETED_PENDING_REFUND" ? "DELETED_PENDING_REFUND" : "DELETED"
}

export function accountDeletedNotice(status: MeAccountDeletionResponse["status"]): string {
  return status === "DELETED_PENDING_REFUND"
    ? "Sua conta foi excluída. O saldo restante será devolvido por Pix, em até 30 dias, para a chave que você informou."
    : "Sua conta foi excluída. Seus dados pessoais foram apagados."
}
