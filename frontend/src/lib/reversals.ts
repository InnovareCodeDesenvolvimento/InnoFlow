import axios from "axios"
import { parseReaisToCents } from "@/lib/money"
import { SECRETS_KEY_UNAVAILABLE_TEXT } from "@/lib/secretsKey"
import { formatCents } from "@/lib/utils"
import type { ChargebackStatus, PaymentListRow, RefundDestination, RefundStatus } from "@/types/api"

/**
 * Estorno, chargeback e devolução de conta excluída (L1.8 / L1.4, ADMIN). Regras de ENTRADA que o servidor também confere (o servidor manda: aqui só se evita a ida e volta e
 * se explica o erro) + textos por `code`. Sem lógica de negócio: o teto do estorno, o bloqueio do cartão e a dívida são do backend.
 */

// ---------------------------------------------------------------------------
// Limites (espelham `paymentReversals.schema.ts` e `accountDeletion.schema.ts`)
// ---------------------------------------------------------------------------

export const REFUND_REASON_MIN = 10
export const REFUND_REASON_MAX = 500
export const PORTAL_REFERENCE_MAX = 120
export const PROOF_REFERENCE_MIN = 5
export const PROOF_REFERENCE_MAX = 120
export const DELETION_PROOF_MAX = 120
export const CASE_REFERENCE_MAX = 120
export const REASON_CODE_MAX = 40
/** Teto de sanidade por lançamento (R$ 100.000,00), igual ao do servidor. */
export const REVERSAL_AMOUNT_MAX_CENTS = 10_000_000
/** Mesma janela do vigia do backend: chargeback aberto com prazo em até 3 dias = "próximo" (`chargeback_response_deadline_near`). */
export const DEADLINE_NEAR_DAYS = 3
/** Prazo recomendado para devolver o saldo de uma conta excluída (o servidor marca `overdue` por ele). */
export const DELETION_REFUND_DEADLINE_DAYS = 30

/** Quebra de linha/tab/controle: o servidor recusa (`semControle`) — o texto vai para a tela e para o relatório. */
function hasControlChars(value: string): boolean {
  return [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
}

/** Campo de uma linha só: troca quebra de linha/tab por espaço ao digitar/colar (em vez de deixar o servidor recusar depois). */
export function toSingleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ")
}

// ---------------------------------------------------------------------------
// Textos (rótulos e dicas — fonte única; o runbook `docs/RUNBOOK-ESTORNO-CHARGEBACK.md` é a origem)
// ---------------------------------------------------------------------------

export const REFUND_DESTINATION_LABELS: Record<RefundDestination, string> = {
  WALLET: "Carteira do motorista",
  CARD_VIA_PORTAL: "Cartão (portal da Cielo)",
}

export const REFUND_DESTINATION_HINTS: Record<RefundDestination, string> = {
  WALLET: "Crédito imediato no saldo do motorista. Recomendado — não passa pela Cielo.",
  CARD_VIA_PORTAL:
    "Faça o estorno no portal da Cielo e registre aqui. Fica pendente até a Cielo mostrar o estorno; estorno PARCIAL não é confirmado automaticamente.",
}

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  PENDING_CONFIRMATION: "Aguardando confirmação",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
}

/** O alerta falso no Parque só acontece quando o estorno passa pela Cielo (portal) — o da carteira não gera nada (runbook §0 e §1.1). */
export const PARQUE_ALERT_NOTICE = "Este estorno vai gerar um alerta falso no sistema do Parque (pedido IF-…). Avise o operador de lá para ignorar."
/** Idem para o chargeback (a Cielo notifica a URL do Parque também quando há contestação — runbook §0). */
export const PARQUE_ALERT_CHARGEBACK_NOTICE = "Este chargeback vai gerar um alerta falso no sistema do Parque (pedido IF-…). Avise o operador de lá para ignorar."

export const REFUND_REASON_HINT = "Não escreva o nome do motorista: o texto fica gravado no registro e na exportação LGPD do titular."

export const CHARGEBACK_STATUS_LABELS: Record<ChargebackStatus, string> = {
  OPEN: "Em aberto",
  WON: "Ganho",
  LOST: "Perdido",
  ACCEPTED: "Aceito",
}

export const CHARGEBACK_OUTCOME_HINTS: Record<"WON" | "LOST" | "ACCEPTED", string> = {
  WON: "Ganhamos a disputa. O modo cartão do motorista volta sozinho. Não gera dívida.",
  LOST: "Perdemos a disputa. A plataforma absorve o prejuízo e o motorista continua sem o modo cartão.",
  ACCEPTED: "Aceitamos o chargeback sem contestar. Igual a Perdido: a plataforma absorve e o cartão do motorista continua bloqueado.",
}

export const CHARGEBACK_CARD_BLOCKED_NOTICE = "O modo cartão deste motorista foi bloqueado. Pix e carteira continuam."
export const CHARGEBACK_DEBT_HINT =
  "Ação sua, caso a caso. A dívida bloqueia a próxima recarga do motorista e é quitada sozinha por um crédito de Pix. Sem marcar, a plataforma absorve o prejuízo."
export const CHARGEBACK_DEADLINE_HINT = "Preencha sempre o prazo que a Cielo informou: sem ele o sistema não avisa quando estiver perto de vencer."

/** Centavos → texto de campo ("1250,50", sem separador de milhar): volta a `parseReaisToCents` sem perda. */
export function centsToInput(cents: number): string {
  const safe = Math.max(0, Math.trunc(cents))
  return `${Math.trunc(safe / 100)},${String(safe % 100).padStart(2, "0")}`
}

// ---------------------------------------------------------------------------
// Validação — estorno de sessão
// ---------------------------------------------------------------------------

/** Tira acento e caixa para comparar nomes ("José" = "jose"). */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

/**
 * O motivo fica gravado (registro e exportação LGPD): ele não pode carregar o NOME nem o E-MAIL do motorista. Conferência simples e conservadora: nome completo, e-mail,
 * ou qualquer parte do nome com 4+ letras como palavra inteira. Falso positivo existe (um nome que é palavra comum) e a mensagem manda reescrever — melhor que gravar PII.
 */
export function reasonMentionsDriver(reason: string, driverName: string | undefined | null, driverEmail?: string | null): boolean {
  const text = normalize(reason)
  if (driverEmail && text.includes(normalize(driverEmail))) return true
  if (!driverName) return false
  const fullName = normalize(driverName).trim()
  // Nome composto inteiro (com espaço); nome de uma palavra só é coberto pela checagem por palavra inteira abaixo (substring de "jo" casaria "joao" sem ser o nome).
  if (fullName.includes(" ") && text.includes(fullName)) return true
  const words = text.split(/[^a-z0-9]+/).filter(Boolean)
  return normalize(driverName)
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 4)
    .some((part) => words.includes(part))
}

export interface RefundDraft {
  amountInput: string
  reason: string
  destination: RefundDestination
  portalReference: string
}

export interface RefundContext {
  /** Quanto ainda dá para estornar (do servidor, no momento em que a tela abriu). */
  refundableCents: number
  /** Para a trava do motivo (nome/e-mail do motorista no texto). Só ADMIN vê o e-mail. */
  driverName?: string | null
  driverEmail?: string | null
}

export interface RefundValidation {
  valid: boolean
  amountCents: number | null
  errors: Partial<Record<"amount" | "reason" | "portalReference", string>>
}

export function validateRefund(draft: RefundDraft, ctx: RefundContext): RefundValidation {
  const errors: RefundValidation["errors"] = {}
  const amountCents = parseReaisToCents(draft.amountInput)

  if (draft.amountInput.trim() === "") errors.amount = "Informe o valor."
  else if (amountCents === null) errors.amount = "Valor inválido. Use o formato 12,50."
  else if (amountCents <= 0) errors.amount = "O valor deve ser maior que zero."
  else if (amountCents > REVERSAL_AMOUNT_MAX_CENTS) errors.amount = `O valor passa do limite de ${formatCents(REVERSAL_AMOUNT_MAX_CENTS)} por lançamento.`
  else if (amountCents > ctx.refundableCents) errors.amount = `O valor passa do que ainda dá para estornar nesta sessão (${formatCents(ctx.refundableCents)}).`

  const reason = draft.reason.trim()
  if (reason.length < REFUND_REASON_MIN) errors.reason = `Explique o motivo (mínimo de ${REFUND_REASON_MIN} caracteres).`
  else if (reason.length > REFUND_REASON_MAX) errors.reason = `O motivo pode ter no máximo ${REFUND_REASON_MAX} caracteres.`
  else if (hasControlChars(reason)) errors.reason = "Não use quebra de linha nem caracteres de controle."
  else if (reasonMentionsDriver(reason, ctx.driverName, ctx.driverEmail)) errors.reason = "O motivo cita o nome ou o e-mail do motorista. Reescreva sem identificar a pessoa."

  const portalReference = draft.portalReference.trim()
  if (draft.destination === "CARD_VIA_PORTAL" && portalReference !== "") {
    if (portalReference.length > PORTAL_REFERENCE_MAX) errors.portalReference = `A referência pode ter no máximo ${PORTAL_REFERENCE_MAX} caracteres.`
    else if (hasControlChars(portalReference)) errors.portalReference = "Não use quebra de linha nem caracteres de controle."
  }

  return { valid: Object.keys(errors).length === 0 && amountCents !== null, amountCents, errors }
}

// ---------------------------------------------------------------------------
// Validação — referência do comprovante (confirmar à mão) — espelha `confirmRefundSchema`
// ---------------------------------------------------------------------------

const PROOF_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/
const CPF_WITH_MASK = /\d{3}\.\d{3}\.\d{3}-\d{2}/
const LONG_NUMBER = /^\d{13,19}$/

function passesLuhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** CPF com máscara ou número de cartão (13–19 dígitos que passa no Luhn): o servidor recusa — a tela explica antes. */
export function looksLikePersonalOrCardData(value: string): boolean {
  return CPF_WITH_MASK.test(value) || (LONG_NUMBER.test(value) && passesLuhn(value))
}

/** `null` = válida. */
export function validateProofReference(input: string): string | null {
  const value = input.trim()
  if (value.length < PROOF_REFERENCE_MIN) return `A referência do comprovante precisa ter ao menos ${PROOF_REFERENCE_MIN} caracteres.`
  if (value.length > PROOF_REFERENCE_MAX) return `A referência do comprovante pode ter no máximo ${PROOF_REFERENCE_MAX} caracteres.`
  if (!PROOF_REFERENCE_PATTERN.test(value)) return "Use só o código do comprovante (letras, números e . _ - / # :), sem espaços nem e-mail."
  if (looksLikePersonalOrCardData(value)) return "Isto parece um CPF ou número de cartão: informe só a referência do comprovante."
  return null
}

/** Comprovante do Pix de uma devolução de conta excluída (texto livre, 1 a 120). */
export function validateDeletionProof(input: string): string | null {
  const value = input.trim()
  if (value.length < 1) return "Informe o comprovante ou o identificador do Pix que você fez."
  if (value.length > DELETION_PROOF_MAX) return `O comprovante pode ter no máximo ${DELETION_PROOF_MAX} caracteres.`
  if (hasControlChars(value)) return "Não use quebra de linha nem caracteres de controle."
  if (looksLikePersonalOrCardData(value)) return "Isto parece um CPF ou número de cartão: informe só a referência do comprovante."
  return null
}

/** Motivo do desbloqueio do cartão (10 a 500, sem controle). `null` = válido. */
export function validateUnblockReason(input: string): string | null {
  const value = input.trim()
  if (value.length < REFUND_REASON_MIN) return `Explique por que o cartão volta a ser liberado (mínimo de ${REFUND_REASON_MIN} caracteres).`
  if (value.length > REFUND_REASON_MAX) return `O motivo pode ter no máximo ${REFUND_REASON_MAX} caracteres.`
  if (hasControlChars(value)) return "Não use quebra de linha nem caracteres de controle."
  return null
}

// ---------------------------------------------------------------------------
// Validação — registrar chargeback
// ---------------------------------------------------------------------------

export interface ChargebackDraft {
  amountInput: string
  /** `AAAA-MM-DD` (campo de data). */
  notifiedDate: string
  caseReference: string
  reasonCode: string
  /** `AAAA-MM-DD` ou vazio. */
  deadlineDate: string
}

export interface ChargebackValidation {
  valid: boolean
  amountCents: number | null
  errors: Partial<Record<"amount" | "notifiedDate" | "caseReference" | "reasonCode" | "deadlineDate", string>>
}

/** Hoje no relógio do navegador, `AAAA-MM-DD` (limite do campo de data — o servidor recusa aviso no futuro). */
export function todayInputValue(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/

export function validateChargeback(draft: ChargebackDraft, capturedCents: number, now: Date = new Date()): ChargebackValidation {
  const errors: ChargebackValidation["errors"] = {}
  const amountCents = parseReaisToCents(draft.amountInput)

  if (draft.amountInput.trim() === "") errors.amount = "Informe o valor contestado."
  else if (amountCents === null || amountCents <= 0) errors.amount = "Valor inválido. Use o formato 12,50."
  else if (amountCents > capturedCents) errors.amount = `O valor passa do que foi capturado nesta venda (${formatCents(capturedCents)}).`
  else if (amountCents > REVERSAL_AMOUNT_MAX_CENTS) errors.amount = `O valor passa do limite de ${formatCents(REVERSAL_AMOUNT_MAX_CENTS)}.`

  if (!DATE_INPUT.test(draft.notifiedDate)) errors.notifiedDate = "Informe a data em que a Cielo avisou."
  else if (draft.notifiedDate > todayInputValue(now)) errors.notifiedDate = "A data do aviso não pode estar no futuro."

  const caseReference = draft.caseReference.trim()
  if (caseReference === "") errors.caseReference = "Informe a referência do caso na Cielo."
  else if (caseReference.length > CASE_REFERENCE_MAX) errors.caseReference = `A referência pode ter no máximo ${CASE_REFERENCE_MAX} caracteres.`
  else if (hasControlChars(caseReference)) errors.caseReference = "Não use quebra de linha nem caracteres de controle."

  const reasonCode = draft.reasonCode.trim()
  if (reasonCode.length > REASON_CODE_MAX) errors.reasonCode = `O código pode ter no máximo ${REASON_CODE_MAX} caracteres.`
  else if (hasControlChars(reasonCode)) errors.reasonCode = "Não use quebra de linha nem caracteres de controle."

  if (draft.deadlineDate !== "") {
    if (!DATE_INPUT.test(draft.deadlineDate)) errors.deadlineDate = "Data inválida."
    else if (DATE_INPUT.test(draft.notifiedDate) && draft.deadlineDate < draft.notifiedDate) errors.deadlineDate = "O prazo de resposta não pode ser anterior ao aviso."
  }

  return { valid: Object.keys(errors).length === 0 && amountCents !== null, amountCents, errors }
}

/**
 * Data do campo → instante ISO enviado ao servidor. Aviso: o meio-dia local de um dia passado (o servidor recusa o futuro; hoje vale "agora"). Prazo: o fim do dia local
 * ("até dia 10" inclui o dia 10).
 */
export function noticeDateToIso(date: string, now: Date = new Date()): string {
  if (date === todayInputValue(now)) return now.toISOString()
  const [y, m, d] = date.split("-").map(Number)
  return new Date(y, m - 1, d, 12, 0, 0).toISOString()
}
export function deadlineDateToIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(y, m - 1, d, 23, 59, 0).toISOString()
}

// ---------------------------------------------------------------------------
// Prazo de resposta do chargeback e idade do pedido de devolução
// ---------------------------------------------------------------------------

export type DeadlineKind = "none" | "ok" | "near" | "overdue"
export interface DeadlineState {
  kind: DeadlineKind
  /** Dias inteiros até o prazo (`near`/`ok`) ou de atraso (`overdue`, positivo). */
  days: number
  label: string
}

const DAY_MS = 86_400_000

/** Dias de CALENDÁRIO (no fuso do navegador) entre duas datas: "vence em 2 dias" = depois de amanhã, qualquer que seja a hora. */
function calendarDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((b - a) / DAY_MS)
}

/**
 * Só chargeback EM ABERTO tem prazo vivo (o desfecho encerra o aviso no backend). `near` = até 3 dias (a mesma janela do vigia do backend), `overdue` = já passou.
 * Dias contados em DIAS DE CALENDÁRIO: o prazo é "até o dia X" — "Vence hoje" vale o dia todo, e "Vencido há 1 dia" só a partir do dia seguinte.
 */
export function responseDeadlineState(responseDeadline: string | null, status: ChargebackStatus, now: Date = new Date()): DeadlineState {
  if (status !== "OPEN" || responseDeadline === null) return { kind: "none", days: 0, label: responseDeadline === null ? "Sem prazo cadastrado" : "Encerrado" }
  const deadline = new Date(responseDeadline)
  const days = calendarDaysBetween(now, deadline)
  if (deadline.getTime() < now.getTime()) {
    const late = Math.max(0, -days)
    return { kind: "overdue", days: late, label: late === 0 ? "Venceu hoje" : late === 1 ? "Vencido há 1 dia" : `Vencido há ${late} dias` }
  }
  if (days <= DEADLINE_NEAR_DAYS) return { kind: "near", days, label: days === 0 ? "Vence hoje" : days === 1 ? "Vence em 1 dia" : `Vence em ${days} dias` }
  return { kind: "ok", days, label: `Vence em ${days} dias` }
}

// ---------------------------------------------------------------------------
// Erros por `code` — nunca o texto do servidor (pode ecoar dado)
// ---------------------------------------------------------------------------

export const REVERSAL_SESSION_EXPIRED_MESSAGE = "Sua sessão expirou. Entre de novo para continuar — nada foi alterado."
export const REVERSAL_WRONG_PASSWORD_MESSAGE = "Senha incorreta."

/** Textos que valem para qualquer rota de dinheiro do Admin. */
const COMMON_MESSAGES: Record<string, string> = {
  INVALID_CURRENT_PASSWORD: REVERSAL_WRONG_PASSWORD_MESSAGE,
  STEPUP_UNAVAILABLE: "Não foi possível confirmar sua senha agora. Nada foi registrado. Tente de novo em instantes.",
  RATE_LIMITED: "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.",
  RATE_LIMITED_PAYMENT_GATEWAY: "Muitas tentativas de senha em pouco tempo. Aguarde alguns minutos e tente de novo.",
  RATE_LIMITED_ACCOUNT_DELETION: "Muitas tentativas de senha em pouco tempo. Aguarde alguns minutos e tente de novo.",
  UNAUTHORIZED: REVERSAL_SESSION_EXPIRED_MESSAGE,
  FORBIDDEN: "Somente administradores podem fazer isto.",
  INTERNAL_ERROR: "Não foi possível concluir e nada foi registrado. Tente de novo.",
  VALIDATION_ERROR: "O servidor não aceitou algum valor. Revise os campos e tente de novo.",
}

const REFUND_MESSAGES: Record<string, string> = {
  SESSION_NOT_FOUND: "Esta sessão não foi encontrada.",
  SESSION_NOT_BILLED: "Esta sessão não foi cobrada (aberta, sem custo ou virou dívida): não há o que estornar.",
  AMOUNT_EXCEEDS_REFUNDABLE: "O valor passa do que ainda dá para estornar (outra devolução pode ter sido registrada). Confira o valor atualizado.",
  NO_CARD_PAYMENT: "Esta sessão não foi paga com cartão: não há venda na Cielo para devolver. Use a carteira.",
  DRIVER_ACCOUNT_DELETED: "A conta deste motorista foi excluída: não há carteira para receber o estorno.",
  NOT_FOUND: "Este registro de devolução não foi encontrado.",
  REFUND_NOT_CANCELLABLE: "Só dá para cancelar uma devolução no cartão que ainda está aguardando confirmação. Atualize a lista.",
  REFUND_NOT_CONFIRMABLE: "Esta devolução não pode mais ser confirmada à mão (outro administrador ou o sistema chegou antes, ou ela foi cancelada). Atualize a lista.",
}

const CHARGEBACK_MESSAGES: Record<string, string> = {
  PAYMENT_NOT_FOUND: "Venda de cartão não encontrada.",
  PAYMENT_NOT_CAPTURED: "Esta venda não tem valor capturado: não há o que contestar.",
  CHARGEBACK_ALREADY_REGISTERED: "Já existe um chargeback registrado para esta venda.",
  CHARGEBACK_ALREADY_RESOLVED: "Este chargeback já teve o desfecho registrado. Atualize a lista.",
  CHARGEBACK_NOT_LOST: "Só dá para desbloquear o cartão de um chargeback perdido ou aceito.",
  CARD_ALREADY_UNBLOCKED: "O cartão deste chargeback já foi desbloqueado.",
  NOT_FOUND: "Chargeback não encontrado.",
}

const DELETION_MESSAGES: Record<string, string> = {
  NOT_FOUND: "Este pedido de devolução não foi encontrado.",
  ALREADY_REFUNDED: "Este pedido já foi devolvido. Atualize a lista.",
  REFUND_NOT_REQUIRED: "Este pedido não tem saldo a devolver.",
  AMOUNT_EXCEEDS_BALANCE: "O valor passa do saldo registrado no pedido. A devolução é do saldo integral.",
  PARTIAL_REFUND_NOT_ALLOWED: "A devolução precisa ser do saldo integral: o resto ficaria na carteira de uma conta sem dono.",
  PAYMENT_SECRETS_KEY_MISSING: `${SECRETS_KEY_UNAVAILABLE_TEXT} Nada foi registrado.`,
}

export type ReversalDomain = "refund" | "chargeback" | "deletion"

const DOMAIN_MESSAGES: Record<ReversalDomain, Record<string, string>> = {
  refund: REFUND_MESSAGES,
  chargeback: CHARGEBACK_MESSAGES,
  deletion: DELETION_MESSAGES,
}

export interface ReversalError {
  code: string | undefined
  message: string
  /** Só em `AMOUNT_EXCEEDS_REFUNDABLE`: o teto atual que o servidor informou (`details.refundableCents`), se vier. */
  refundableCents: number | null
  /** `true` = a sessão expirou: a tela não tenta de novo, o interceptor leva ao login. */
  sessionExpired: boolean
}

function readRefundableCents(details: unknown): number | null {
  const source: unknown = Array.isArray(details) ? details[0] : details
  if (!source || typeof source !== "object") return null
  const value = (source as { refundableCents?: unknown }).refundableCents
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * Traduz o erro de uma rota de dinheiro em texto por `code` (e por status quando o proxy come o corpo: 429/401). NUNCA ecoa `error`/`message` do servidor nem o corpo do pedido (que
 * carrega a senha e o motivo). Erro sem resposta = rede.
 */
export function parseReversalError(err: unknown, domain: ReversalDomain): ReversalError {
  if (!axios.isAxiosError(err) || !err.response) {
    return { code: undefined, message: "Não foi possível falar com o servidor. Confira a conexão e tente de novo — nada foi registrado.", refundableCents: null, sessionExpired: false }
  }
  const status = err.response.status
  const body = err.response.data as { code?: unknown; details?: unknown } | undefined
  const code = typeof body?.code === "string" ? body.code : undefined

  const lookupCode = code ?? (status === 401 ? "UNAUTHORIZED" : status === 429 ? "RATE_LIMITED" : undefined)
  const message =
    (lookupCode && (DOMAIN_MESSAGES[domain][lookupCode] ?? COMMON_MESSAGES[lookupCode])) || (status >= 500 ? COMMON_MESSAGES.INTERNAL_ERROR : "Não foi possível concluir. Nada foi registrado. Tente de novo.")
  return {
    code: lookupCode,
    message,
    refundableCents: code === "AMOUNT_EXCEEDS_REFUNDABLE" ? readRefundableCents(body?.details) : null,
    sessionExpired: lookupCode === "UNAUTHORIZED",
  }
}

/** Mensagem do erro ao CARREGAR (GET) uma lista/painel ADMIN, ou `null` para cair no texto genérico da tela. */
export function parseReversalLoadError(err: unknown, domain: ReversalDomain): string | null {
  if (!axios.isAxiosError(err) || !err.response) return null
  const parsed = parseReversalError(err, domain)
  return parsed.code ? (DOMAIN_MESSAGES[domain][parsed.code] ?? COMMON_MESSAGES[parsed.code] ?? null) : null
}

// ---------------------------------------------------------------------------
// Idade de um pedido de devolução de conta excluída
// ---------------------------------------------------------------------------

export function ageLabel(ageDays: number): string {
  if (ageDays <= 0) return "hoje"
  return ageDays === 1 ? "há 1 dia" : `há ${ageDays} dias`
}

// ---------------------------------------------------------------------------
// Pagamentos: achar a venda e registrar chargeback
// ---------------------------------------------------------------------------

/** Cor do estado do chargeback (a cor nunca vai sozinha: o rótulo está sempre ao lado). Perdido/aceito = `danger`: o prejuízo é da plataforma. */
export const CHARGEBACK_STATUS_VARIANT: Record<ChargebackStatus, "warning" | "success" | "danger" | "neutral"> = {
  OPEN: "warning",
  WON: "success",
  LOST: "danger",
  ACCEPTED: "danger",
}

/** Identificadores do AVISO da Cielo (igualdade exata no servidor). `proofOfSale` = NSU. */
export interface AcquirerFilterValues {
  tid: string
  authorizationCode: string
  proofOfSale: string
}
export const EMPTY_ACQUIRER_FILTERS: AcquirerFilterValues = { tid: "", authorizationCode: "", proofOfSale: "" }

/** Venda de cartão com valor capturado: a única que pode ter chargeback (o servidor confere: 404 `PAYMENT_NOT_FOUND`, 409 `PAYMENT_NOT_CAPTURED`). */
export function canRegisterChargeback(row: Pick<PaymentListRow, "provider" | "status" | "amountCapturedCents">): boolean {
  return row.provider === "CIELO_CARD" && row.status === "CAPTURED" && (row.amountCapturedCents ?? 0) > 0
}
