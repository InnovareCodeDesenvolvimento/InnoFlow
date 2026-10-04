import axios from "axios"
import type { ApiErrorBody, CardEligibility, CardEligibilityReason } from "@/types/api"

/**
 * I-7 (decisão do dono, 04/10/2026): pagar com CARTÃO exige identidade verificada (login com Google, ou conta de equipe) e some por um tempo depois de
 * recusas em excesso. Pix e carteira NÃO são afetados. O servidor também recusa (403 `CARD_REQUIRES_VERIFIED_IDENTITY` / 429 `CARD_TEMPORARILY_BLOCKED`);
 * a tela existe para explicar ANTES de o motorista tentar. Funções puras (sem DOM/rede).
 */

/** O que impede o cartão agora. `blockedUntil` só existe em `TEMPORARILY_BLOCKED`. */
export interface CardEligibilityIssue {
  reason: CardEligibilityReason
  blockedUntil: string | null
}

/** `cardEligibility` do `GET /api/me/payment-methods` -> problema, ou `null` se pode usar cartão. Resposta sem o campo (servidor antigo) = elegível. */
export function issueFromEligibility(eligibility: CardEligibility | undefined | null): CardEligibilityIssue | null {
  if (!eligibility || eligibility.eligible !== false) return null
  // `eligible:false` sem motivo conhecido: trate como bloqueio de identidade (a ação — entrar com Google — é a única que o motorista tem).
  const reason: CardEligibilityReason = eligibility.reason === "TEMPORARILY_BLOCKED" ? "TEMPORARILY_BLOCKED" : "GOOGLE_LOGIN_REQUIRED"
  return { reason, blockedUntil: reason === "TEMPORARILY_BLOCKED" ? (eligibility.blockedUntil ?? null) : null }
}

function readBlockedUntil(details: unknown): string | null {
  // Contrato: `details: { blockedUntil }` (objeto). Tolera também array de um item, como outros erros da API.
  const candidate = Array.isArray(details) ? details[0] : details
  if (!candidate || typeof candidate !== "object") return null
  const value = (candidate as { blockedUntil?: unknown }).blockedUntil
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null
}

/** Erro HTTP das rotas de cartão (cadastro, sessão de tokenização, iniciar sessão com CARD) -> problema, ou `null` se for outro erro. */
export function issueFromError(err: unknown): CardEligibilityIssue | null {
  if (!axios.isAxiosError<ApiErrorBody>(err)) return null
  const body = err.response?.data
  if (body?.code === "CARD_REQUIRES_VERIFIED_IDENTITY") return { reason: "GOOGLE_LOGIN_REQUIRED", blockedUntil: null }
  if (body?.code === "CARD_TEMPORARILY_BLOCKED") return { reason: "TEMPORARILY_BLOCKED", blockedUntil: readBlockedUntil(body.details) }
  return null
}

/**
 * "14:35" quando é hoje; "05/10 às 14:35" quando passa da meia-noite. No fuso do aparelho do motorista (o servidor manda ISO/UTC).
 * Data inválida ou ausente -> `null` (o chamador usa o texto sem horário, nunca mostra "Invalid Date").
 */
export function formatBlockedUntil(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date)
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return time
  return `${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(date)} às ${time}`
}

/** Frase curta do bloqueio temporário — na linha do botão e nas mensagens de erro. */
export function blockedMessage(issue: CardEligibilityIssue): string {
  const until = formatBlockedUntil(issue.blockedUntil)
  return until ? `Pagamento com cartão indisponível até ${until}.` : "Pagamento com cartão indisponível por um tempo."
}

export const GOOGLE_REQUIRED_TITLE = "Para pagar com cartão, entre com sua conta Google"
export const GOOGLE_REQUIRED_TEXT = "É uma proteção contra fraude. Pix e carteira continuam disponíveis."
export const BLOCKED_TEXT = "Por segurança, o cartão fica indisponível por um tempo depois de várias recusas seguidas. Pix e carteira continuam disponíveis."

/** Mensagem de uma linha para erro ao tentar iniciar a recarga/cadastrar quando o servidor recusa (a tela detalhada é o card). */
export function issueErrorMessage(issue: CardEligibilityIssue): string {
  return issue.reason === "TEMPORARILY_BLOCKED"
    ? `${blockedMessage(issue)} Use a carteira.`
    : "Para pagar com cartão, entre com sua conta Google. Use a carteira por enquanto."
}

/** Motivo curto, na linha de um cartão já cadastrado que ficou desabilitado. */
export function disabledCardReason(issue: CardEligibilityIssue): string {
  if (issue.reason === "GOOGLE_LOGIN_REQUIRED") return "Entre com o Google para usar este cartão."
  const until = formatBlockedUntil(issue.blockedUntil)
  if (!until) return "Volta a ficar disponível em instantes."
  return until.includes("às") ? `Volta a ficar disponível em ${until}.` : `Volta a ficar disponível às ${until}.`
}
