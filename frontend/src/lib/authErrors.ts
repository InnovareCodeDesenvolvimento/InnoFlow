import { getApiErrorCode, getApiErrorMessage, getApiErrorStatus } from "@/services/api"

/**
 * Mensagens de erro das telas de acesso (login, cadastro, Google) — lógica
 * PURA sobre `status`/`code`, sem DOM. Trata sempre por `code`/status, nunca
 * pelo texto do backend (que pode mudar e não é a nossa voz).
 *
 * Dois 429 diferentes no acesso, e a diferença importa para quem lê:
 *  - `RATE_LIMITED_ACCOUNT` (só `POST /api/auth/login`): throttle POR CONTA com
 *    backoff, tranca mesmo com a senha certa. O backend responde igual para
 *    e-mail que existe e que não existe — por isso a mensagem fala "esta
 *    conta" sem confirmar que ela existe (não vira oráculo de e-mails).
 *  - `RATE_LIMITED_AUTH`: limite por IP (login, cadastro, Google).
 *
 * Um 429 sem `code` conhecido (proxy/nginx na frente) cai na mensagem por IP.
 */

export const RATE_LIMITED_ACCOUNT_MESSAGE = "Muitas tentativas para esta conta. Aguarde alguns minutos e tente novamente."
export const RATE_LIMITED_AUTH_MESSAGE = "Muitas tentativas em pouco tempo a partir desta conexão. Aguarde alguns minutos e tente novamente."

/** Mensagem do 429 de acesso, ou `null` se o erro não é de limite de tentativas. */
export function authRateLimitMessage(status: number | undefined, code: string | undefined): string | null {
  if (code === "RATE_LIMITED_ACCOUNT") return RATE_LIMITED_ACCOUNT_MESSAGE
  if (code === "RATE_LIMITED_AUTH" || status === 429) return RATE_LIMITED_AUTH_MESSAGE
  return null
}

/** Erro do axios → texto da tela de acesso: limite de tentativas tem texto próprio; o resto usa a mensagem do backend (ou o `fallback`). */
export function authErrorMessage(err: unknown, fallback: string): string {
  return authRateLimitMessage(getApiErrorStatus(err), getApiErrorCode(err)) ?? getApiErrorMessage(err, fallback)
}
