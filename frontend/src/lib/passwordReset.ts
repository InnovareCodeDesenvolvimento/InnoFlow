import axios from "axios"
import { getApiErrorCode, getApiErrorStatus } from "@/services/api"
import { NETWORK_ERROR_MESSAGE, SERVER_UNSTABLE_MESSAGE } from "@/lib/authErrors"
import { NEW_PASSWORD_SERVER_REJECTED } from "@/schemas/passwordReset.schema"
import type { ApiErrorBody } from "@/types/api"

/**
 * Esqueci / redefinir senha (L1.3) - lógica PURA, sem DOM nem React (as telas só montam o que isto decide). Trata sempre por `status`/`code`, nunca pelo texto do backend.
 *
 * O link do e-mail é `<origem>/redefinir-senha#t=<token>`: o token vem no FRAGMENTO (que nunca vai ao servidor nem ao `Referer`), a tela o lê, o manda no CORPO e APAGA o
 * fragmento da URL na hora - depois disso ele só existe na memória do componente.
 */

/** Token de 32 bytes em base64url sem padding (contrato do backend). Mais curto/longo/com outro alfabeto nem é enviado: não gasta o limite de "link inválido" do servidor. */
export const RESET_TOKEN_LENGTH = 43
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Lê o token de `location.hash` (`#t=<token>`). `null` = sem fragmento, sem `t` ou token fora do formato. Não mexe na URL (isso é `stripFragment`). */
export function readResetToken(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  if (raw === "" || raw.startsWith("?")) return null // `URLSearchParams` tira um "?" inicial: um `?t=` de querystring não pode passar por fragmento
  const token = new URLSearchParams(raw).get("t")
  return token !== null && RESET_TOKEN_PATTERN.test(token) ? token : null
}

/** A mesma URL, sem o fragmento (`/redefinir-senha#t=...` -> `/redefinir-senha`). Mantém caminho e querystring. */
export function urlWithoutFragment(loc: { pathname: string; search: string }): string {
  return `${loc.pathname}${loc.search}`
}

/**
 * Apaga o fragmento da barra de endereço e do histórico (`replaceState` troca a entrada atual, não empilha). Preserva `history.state` (é onde o React Router guarda a chave
 * da localização). Idempotente: sem fragmento, não faz nada.
 */
export function scrubFragment(win: Pick<Window, "location" | "history"> = window): void {
  if (win.location.hash === "") return
  win.history.replaceState(win.history.state, "", urlWithoutFragment(win.location))
}

// ---- Aviso de "senha alterada" no Login -----------------------------------------------------------------------------------------------------------------

/**
 * O 204 do reset não traz sessão: a tela navega para `/login` com `state: { flash: "password-reset" }` (estado da ROTA, não storage). O Login lê na chegada, guarda em estado
 * local e limpa o estado da rota (`history.state` sobrevive a um F5 - sem a limpeza o aviso voltaria a cada recarga).
 */
export const PASSWORD_RESET_FLASH = "password-reset"
export const PASSWORD_RESET_NOTICE = "Senha alterada. Entre com a nova senha."

export function isPasswordResetFlash(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as { flash?: unknown }).flash === PASSWORD_RESET_FLASH
}

// ---- Retry-After ----------------------------------------------------------------------------------------------------------------------------------

/**
 * Segundos de espera do 429, do header `Retry-After` (inteiro de segundos; a forma de data HTTP também é aceita). `null` quando o header não é legível (ausente, ou
 * descartado por um proxy). O CORS do backend o expõe entre domínios desde o lote 1 (`Access-Control-Expose-Headers: Retry-After`, 3e0dbb3); só nesse `null` a mensagem fala "alguns minutos".
 */
export function retryAfterSeconds(err: unknown, now: number = Date.now()): number | null {
  if (!axios.isAxiosError(err)) return null
  const raw = (err.response?.headers as Record<string, unknown> | undefined)?.["retry-after"]
  if (typeof raw !== "string" && typeof raw !== "number") return null
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return Math.min(Number(text), 24 * 3600)
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : Math.min(Math.max(Math.ceil((at - now) / 1000), 0), 24 * 3600)
}

/** "alguns minutos" quando não há tempo exato; senão "cerca de N minuto(s)" / "menos de 1 minuto" - nunca segundos soltos num texto de bloqueio de minutos. */
export function waitPhrase(seconds: number | null): string {
  if (seconds === null) return "alguns minutos"
  if (seconds < 60) return "menos de 1 minuto"
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return minutes === 1 ? "1 minuto" : `${minutes} minutos`
  const hours = Math.ceil(minutes / 60)
  return hours === 1 ? "1 hora" : `${hours} horas`
}

// ---- Mensagens ------------------------------------------------------------------------------------------------------------------------------------

export const RESET_LINK_INVALID_MESSAGE = "Este link é inválido ou expirou. Peça um novo."
export const FORGOT_FALLBACK_MESSAGE = "Não foi possível enviar o pedido agora. Tente novamente."
export const RESET_FALLBACK_MESSAGE = "Não foi possível redefinir a senha. Tente novamente."
export const FORGOT_EMAIL_INVALID_MESSAGE = "E-mail inválido."

/** Texto do 429 das duas telas. Com o tempo exato quando o header é legível. */
export function rateLimitMessage(seconds: number | null): string {
  return seconds === null ? "Muitas tentativas. Tente de novo em alguns minutos." : `Muitas tentativas. Tente de novo em ${waitPhrase(seconds)}.`
}

/** Erro de rede/timeout/CORS (sem resposta) e 5xx: compartilhados pelas duas telas, com os mesmos textos de `authErrors`. */
function transportMessage(err: unknown): string | null {
  if (!axios.isAxiosError(err)) return null
  const status = getApiErrorStatus(err)
  if (status === undefined) return NETWORK_ERROR_MESSAGE
  if (status >= 500) return SERVER_UNSTABLE_MESSAGE
  return null
}

function isRateLimited(err: unknown): boolean {
  return getApiErrorCode(err) === "RATE_LIMITED_AUTH" || getApiErrorStatus(err) === 429
}

/** Caminhos (`details[].path`) do 400 `VALIDATION_ERROR`, só o primeiro segmento. */
function invalidPaths(err: unknown): string[] {
  if (!axios.isAxiosError<ApiErrorBody>(err)) return []
  return (err.response?.data?.details ?? []).map((d) => (typeof d.path === "string" ? d.path.split(".")[0] : "")).filter((p) => p !== "")
}

export type ForgotError = { kind: "field"; message: string } | { kind: "form"; message: string }

/** Erro do `POST /forgot`. O 202 nunca chega aqui; 400 só por e-mail malformado (vai no campo). */
export function forgotPasswordError(err: unknown): ForgotError {
  const transport = transportMessage(err)
  if (transport) return { kind: "form", message: transport }
  if (isRateLimited(err)) return { kind: "form", message: rateLimitMessage(retryAfterSeconds(err)) }
  if (getApiErrorCode(err) === "VALIDATION_ERROR") return { kind: "field", message: FORGOT_EMAIL_INVALID_MESSAGE }
  return { kind: "form", message: FORGOT_FALLBACK_MESSAGE }
}

export type ResetError =
  /** O link não vale mais (ou nunca valeu): a tela troca o formulário por "link inválido" e a única saída é pedir outro. */
  | { kind: "invalid-link"; message: string }
  /** Erro da nova senha, no campo, com o formulário mantido (o token NÃO foi gasto). */
  | { kind: "field"; message: string }
  /** Aviso do formulário (limite, serviço fora, rede, 5xx): o formulário e o token continuam como estão. */
  | { kind: "form"; message: string }

/** Erro do `POST /reset`. Ordem: sem resposta/5xx (inclui o 503 `SERVICE_UNAVAILABLE`) -> 429 -> `RESET_TOKEN_INVALID` -> `VALIDATION_ERROR` -> resto. */
export function resetPasswordError(err: unknown): ResetError {
  const transport = transportMessage(err)
  if (transport) return { kind: "form", message: transport }
  if (isRateLimited(err)) return { kind: "form", message: rateLimitMessage(retryAfterSeconds(err)) }
  const code = getApiErrorCode(err)
  if (code === "RESET_TOKEN_INVALID") return { kind: "invalid-link", message: RESET_LINK_INVALID_MESSAGE }
  if (code === "VALIDATION_ERROR") {
    // `token` com `VALIDATION_ERROR` = corpo gigante (> 200): o nosso formato de 43 já barra isso, mas se o servidor reclamar do token o link não serve.
    if (invalidPaths(err).includes("token")) return { kind: "invalid-link", message: RESET_LINK_INVALID_MESSAGE }
    return { kind: "field", message: NEW_PASSWORD_SERVER_REJECTED }
  }
  if (code === "SERVICE_UNAVAILABLE") return { kind: "form", message: SERVER_UNSTABLE_MESSAGE }
  return { kind: "form", message: RESET_FALLBACK_MESSAGE }
}
