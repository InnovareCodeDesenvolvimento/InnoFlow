import { findSessionDetail } from "./reportsAggregate"
import { generatedSessions } from "./reportsData"
import { looksLikePersonalOrCardData, validateProofReference } from "@/lib/reversals"
import type {
  AdminAccountDeletionRow,
  ChargebackDTO,
  ChargebackDossier,
  ChargebacksListResponse,
  ChargebackStatus,
  PaginatedResponse,
  SessionRefundDTO,
  SessionRefundsResponse,
} from "@/types/api"

/** Senha das contas de ADMIN do mock (a mesma de `mocks/data.ts`): as escritas conferem `currentPassword` contra ela (step-up). */
const MOCK_ADMIN_PASSWORD = "senha1234"

/**
 * Espelho (no que as telas precisam provar) das rotas de estorno, chargeback e devolução de conta excluída (L1.8 e L1.4; `docs/RUNBOOK-ESTORNO-CHARGEBACK.md`, `paymentReversals.routes.ts`,
 * `chargebacks.routes.ts`, `adminAccountDeletions.routes.ts`). NÃO é a regra de negócio da Vega: serve para exercitar o contrato no navegador. NADA aqui foi provado contra o backend real.
 * O estado vive em memória da PÁGINA (um `page.goto` zera — o E2E prepara o cenário por `localStorage` antes de navegar).
 *
 * DADOS DE DEMO (determinísticos)
 *  - Sessão `demo_stuck_late_stop` (cartão, capturada): nasce com 4 devoluções — carteira confirmada (R$ 5,00), cartão PENDENTE (R$ 10,00, referência de portal), cartão CANCELADO
 *    (R$ 3,00) e cartão confirmado à mão (R$ 4,00). Qualquer outra sessão encerrada e cobrada nasce sem devolução (carteira ou cartão conforme o pagamento).
 *  - Chargebacks: 7 casos (aberto com prazo em 2 dias, aberto VENCIDO, aberto sem prazo, ganho, perdido absorvido, perdido já desbloqueado, aceito com dívida). `demo_pi_stuck_1` já tem
 *    chargeback (registrar de novo = 409 `CHARGEBACK_ALREADY_REGISTERED`).
 *  - Contas excluídas: 3 pendentes (45 dias = atrasada; 12 dias; 31 dias com chave ILEGÍVEL), 1 devolvida, 1 sem saldo.
 *  - Identificadores da Cielo (filtros Tid/código de autorização/NSU): venda `demo_pi_N` -> Tid `1006993069` + N com 9 dígitos, código `100000+N`, NSU `500000+N`; `demo_pi_stuck_1` ->
 *    Tid `10069930690000999001`, código `654321`, NSU `112233`.
 *
 * GATILHOS
 *  - senha atual `stepup-503` -> 503 `STEPUP_UNAVAILABLE`; `stepup-429` -> 429 `RATE_LIMITED_PAYMENT_GATEWAY`; qualquer outra diferente de `senha1234` -> 403 `INVALID_CURRENT_PASSWORD`;
 *  - `localStorage["mock:estorno"]` (estorno de sessão e devoluções pendentes): `rate-limited` -> 429 `RATE_LIMITED`; `5xx` -> 500; `concurrent` -> outro ADMIN estornou antes: grava um estorno
 *    que deixa só R$ 1,00 de teto e devolve 409 `AMOUNT_EXCEEDS_REFUNDABLE` com `details.refundableCents`; `driver-deleted` -> destino carteira = 409 `DRIVER_ACCOUNT_DELETED`;
 *    `not-confirmable` -> `confirm` = 409 `REFUND_NOT_CONFIRMABLE` (o job chegou antes); `not-cancellable` -> `cancel` = 409 `REFUND_NOT_CANCELLABLE`;
 *  - `localStorage["mock:chargeback"]`: `rate-limited` -> 429; `5xx` -> 500; `dossier-404` -> o dossiê dá 404;
 *  - `localStorage["mock:devolucoes"]`: `empty` -> fila vazia; `5xx` -> o GET dá 500; `already-refunded` -> o `refund` dá 409 `ALREADY_REFUNDED`; `partial` -> 409 `PARTIAL_REFUND_NOT_ALLOWED`;
 *    `key-missing` -> 503 `PAYMENT_SECRETS_KEY_MISSING`; `rate-limited` -> 429 `RATE_LIMITED_ACCOUNT_DELETION`.
 */

type MockResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; code: string; message: string; details?: unknown; headers?: Record<string, string> }

function fail(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>): MockResult<never> {
  return { ok: false, status, code, message, ...(details !== undefined ? { details } : {}), ...(headers ? { headers } : {}) }
}

function scenario(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Step-up de senha: o mesmo contrato do gateway (403 senha errada — NUNCA 401; 429/503 por gatilho). */
function stepUp(currentPassword: unknown): MockResult<never> | null {
  if (typeof currentPassword !== "string" || currentPassword.length < 1 || currentPassword.length > 200) return fail(400, "VALIDATION_ERROR", "currentPassword: obrigatório.")
  if (currentPassword === "stepup-503") return fail(503, "STEPUP_UNAVAILABLE", "Não foi possível confirmar sua senha agora.")
  if (currentPassword === "stepup-429") return fail(429, "RATE_LIMITED_PAYMENT_GATEWAY", "Muitas tentativas.", undefined, { "Retry-After": "120" })
  if (currentPassword !== MOCK_ADMIN_PASSWORD) return fail(403, "INVALID_CURRENT_PASSWORD", "Senha atual incorreta.")
  return null
}

const hasControl = (v: string) => [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
const isoInDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

// ---------------------------------------------------------------------------
// Identificadores da Cielo (filtros do relatório de pagamentos)
// ---------------------------------------------------------------------------

export interface MockAcquirerIds {
  tid: string
  authorizationCode: string
  proofOfSale: string
}

export function acquirerIdsOf(intentId: string): MockAcquirerIds | null {
  if (intentId === "demo_pi_stuck_1") return { tid: "10069930690000999001", authorizationCode: "654321", proofOfSale: "112233" }
  const match = /^demo_pi_(\d+)$/.exec(intentId)
  if (!match) return null
  const n = Number(match[1])
  return { tid: `1006993069${String(n).padStart(9, "0")}`, authorizationCode: String(100000 + n), proofOfSale: String(500000 + n) }
}

/** Mantém só as vendas que casam (igualdade EXATA) com TODOS os identificadores informados. Sem filtro, devolve tudo. */
export function matchesAcquirer(intentId: string, filters: { tid?: string; authorizationCode?: string; proofOfSale?: string }): boolean {
  if (!filters.tid && !filters.authorizationCode && !filters.proofOfSale) return true
  const ids = acquirerIdsOf(intentId)
  if (!ids) return false
  return (!filters.tid || ids.tid === filters.tid) && (!filters.authorizationCode || ids.authorizationCode === filters.authorizationCode) && (!filters.proofOfSale || ids.proofOfSale === filters.proofOfSale)
}

// ---------------------------------------------------------------------------
// Estorno de sessão
// ---------------------------------------------------------------------------

const ADMIN_SCOPE = { role: "ADMIN" as const, operatorId: null }
const refundsBySession = new Map<string, SessionRefundDTO[]>()
let refundCounter = 0

function newRefund(sessionId: string, patch: Partial<SessionRefundDTO> & Pick<SessionRefundDTO, "destination" | "status" | "amountCents" | "reason">): SessionRefundDTO {
  refundCounter += 1
  const intent = sessionIntent(sessionId)
  return {
    id: `refund_${refundCounter}`,
    sessionId,
    paymentIntentId: patch.destination === "CARD_VIA_PORTAL" ? (intent?.id ?? null) : null,
    portalReference: null,
    confirmedManually: false,
    walletEntryId: patch.destination === "WALLET" && patch.status === "CONFIRMED" ? `we_${refundCounter}` : null,
    createdAt: new Date().toISOString(),
    resolvedAt: patch.status === "PENDING_CONFIRMATION" ? null : new Date().toISOString(),
    ...patch,
  }
}

function sessionIntent(sessionId: string) {
  const detail = findSessionDetail(ADMIN_SCOPE, sessionId)
  return detail?.paymentIntents.find((pi) => pi.provider === "CIELO_CARD" && pi.status === "CAPTURED") ?? null
}

function ensureSeeded(sessionId: string): SessionRefundDTO[] {
  const existing = refundsBySession.get(sessionId)
  if (existing) return existing
  const list: SessionRefundDTO[] = []
  if (sessionId === "demo_stuck_late_stop") {
    list.push(
      newRefund(sessionId, { destination: "CARD_VIA_PORTAL", status: "CONFIRMED", amountCents: 400, reason: "Cobrança duplicada conferida no extrato", portalReference: "COMP-2026-0099", confirmedManually: true, createdAt: isoDaysAgo(6), resolvedAt: isoDaysAgo(5) }),
      newRefund(sessionId, { destination: "CARD_VIA_PORTAL", status: "CANCELLED", amountCents: 300, reason: "Valor digitado errado no portal", portalReference: "PORTAL-2026-0040", createdAt: isoDaysAgo(4), resolvedAt: isoDaysAgo(4) }),
      newRefund(sessionId, { destination: "CARD_VIA_PORTAL", status: "PENDING_CONFIRMATION", amountCents: 1000, reason: "Desconto acordado por demora no atendimento", portalReference: "PORTAL-2026-0042", createdAt: isoDaysAgo(2), resolvedAt: null }),
      newRefund(sessionId, { destination: "WALLET", status: "CONFIRMED", amountCents: 500, reason: "Cortesia por falha de comunicação do carregador", createdAt: isoDaysAgo(1), resolvedAt: isoDaysAgo(1) }),
    )
  }
  refundsBySession.set(sessionId, list)
  return list
}

/** Quanto a sessão cobrou: o custo total quando encerrada E com pagamento capturado (cartão ou carteira); senão 0 (aberta, sem custo ou virou dívida). */
function billedCentsOf(sessionId: string): number | null {
  const detail = findSessionDetail(ADMIN_SCOPE, sessionId)
  if (!detail) return null
  if (detail.status !== "STOPPED") return 0
  const captured = detail.paymentIntents.some((pi) => pi.status === "CAPTURED")
  return captured ? (detail.costs.totalCostCents ?? 0) : 0
}

function totalsOf(sessionId: string): { billed: number; refunded: number; refundable: number } | null {
  const billed = billedCentsOf(sessionId)
  if (billed === null) return null
  const refunded = ensureSeeded(sessionId)
    .filter((r) => r.status !== "CANCELLED")
    .reduce((acc, r) => acc + r.amountCents, 0)
  return { billed, refunded, refundable: Math.max(0, billed - refunded) }
}

export function getSessionRefunds(sessionId: string): MockResult<SessionRefundsResponse> {
  const totals = totalsOf(sessionId)
  if (!totals) return fail(404, "SESSION_NOT_FOUND", "Sessão não encontrada.")
  return {
    ok: true,
    status: 200,
    body: { sessionId, billedCents: totals.billed, refundedCents: totals.refunded, refundableCents: totals.refundable, items: [...ensureSeeded(sessionId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) },
  }
}

function scenarioFailure(key: string): MockResult<never> | null {
  const value = scenario(key)
  if (value === "rate-limited") return fail(429, key === "mock:devolucoes" ? "RATE_LIMITED_ACCOUNT_DELETION" : "RATE_LIMITED", "Muitas tentativas.")
  if (value === "5xx") return fail(500, "INTERNAL_ERROR", "Erro interno.")
  return null
}

export function createSessionRefund(sessionId: string, body: unknown): MockResult<{ refundId: string; status: SessionRefundDTO["status"] }> {
  const b = (body ?? {}) as Record<string, unknown>
  const allowed = new Set(["amountCents", "reason", "destination", "portalReference", "currentPassword"])
  const reason = typeof b.reason === "string" ? b.reason.trim() : ""
  const problems: Array<{ path: string; message: string }> = []
  if (Object.keys(b).some((k) => !allowed.has(k))) problems.push({ path: "", message: "Campo desconhecido." })
  if (typeof b.amountCents !== "number" || !Number.isInteger(b.amountCents) || b.amountCents <= 0 || b.amountCents > 10_000_000) problems.push({ path: "amountCents", message: "Valor inválido." })
  if (reason.length < 10 || reason.length > 500 || hasControl(reason)) problems.push({ path: "reason", message: "Explique o motivo (10 a 500 caracteres, sem quebra de linha)." })
  if (b.destination !== "WALLET" && b.destination !== "CARD_VIA_PORTAL") problems.push({ path: "destination", message: "Destino inválido." })
  if (b.portalReference !== undefined && (typeof b.portalReference !== "string" || b.portalReference.trim().length < 1 || b.portalReference.length > 120 || hasControl(b.portalReference))) {
    problems.push({ path: "portalReference", message: "Referência inválida." })
  } else if (b.portalReference !== undefined && b.destination !== "CARD_VIA_PORTAL") problems.push({ path: "portalReference", message: "A referência do portal só vale para devolução no cartão." })
  if (problems.length > 0) return fail(400, "VALIDATION_ERROR", "Dados inválidos.", problems)

  const denied = stepUp(b.currentPassword)
  if (denied) return denied
  const limited = scenarioFailure("mock:estorno")
  if (limited) return limited

  const totals = totalsOf(sessionId)
  if (!totals) return fail(404, "SESSION_NOT_FOUND", "Sessão não encontrada.")
  if (totals.billed === 0) return fail(409, "SESSION_NOT_BILLED", "Esta sessão não foi cobrada.")
  const amountCents = b.amountCents as number
  const destination = b.destination as SessionRefundDTO["destination"]

  if (scenario("mock:estorno") === "concurrent") {
    // Outro ADMIN estorna antes: o teto cai para R$ 1,00 e o pedido deste ADMIN é recusado com o teto atual.
    const rest = totals.refundable - 100
    if (rest > 0) ensureSeeded(sessionId).push(newRefund(sessionId, { destination: "WALLET", status: "CONFIRMED", amountCents: rest, reason: "Estorno registrado por outro administrador" }))
    return fail(409, "AMOUNT_EXCEEDS_REFUNDABLE", "O valor passa do que ainda dá para estornar.", { refundableCents: Math.min(100, totals.refundable) })
  }
  if (amountCents > totals.refundable) return fail(409, "AMOUNT_EXCEEDS_REFUNDABLE", "O valor passa do que ainda dá para estornar.", { refundableCents: totals.refundable })
  if (destination === "CARD_VIA_PORTAL" && !sessionIntent(sessionId)) return fail(409, "NO_CARD_PAYMENT", "Esta sessão não foi paga com cartão.")
  if (destination === "WALLET" && scenario("mock:estorno") === "driver-deleted") return fail(409, "DRIVER_ACCOUNT_DELETED", "A conta do motorista foi excluída.")

  const refund = newRefund(sessionId, {
    destination,
    status: destination === "WALLET" ? "CONFIRMED" : "PENDING_CONFIRMATION",
    amountCents,
    reason,
    portalReference: typeof b.portalReference === "string" ? b.portalReference.trim() : null,
  })
  ensureSeeded(sessionId).push(refund)
  return { ok: true, status: 201, body: { refundId: refund.id, status: refund.status } }
}

function findRefund(refundId: string): SessionRefundDTO | null {
  for (const list of refundsBySession.values()) {
    const found = list.find((r) => r.id === refundId)
    if (found) return found
  }
  // Sessão semeada ainda não tocada: carrega a semente e procura de novo.
  ensureSeeded("demo_stuck_late_stop")
  return refundsBySession.get("demo_stuck_late_stop")?.find((r) => r.id === refundId) ?? null
}

export function cancelRefund(refundId: string, body: unknown): MockResult<{ refundId: string; status: "CANCELLED" }> {
  const denied = stepUp((body as { currentPassword?: unknown } | null)?.currentPassword)
  if (denied) return denied
  const limited = scenarioFailure("mock:estorno")
  if (limited) return limited
  const refund = findRefund(refundId)
  if (!refund) return fail(404, "NOT_FOUND", "Devolução não encontrada.")
  if (refund.destination !== "CARD_VIA_PORTAL" || refund.status !== "PENDING_CONFIRMATION" || scenario("mock:estorno") === "not-cancellable") {
    return fail(409, "REFUND_NOT_CANCELLABLE", "Só dá para cancelar uma devolução no cartão pendente.")
  }
  refund.status = "CANCELLED"
  refund.resolvedAt = new Date().toISOString()
  return { ok: true, status: 200, body: { refundId, status: "CANCELLED" } }
}

export function confirmRefund(refundId: string, body: unknown): MockResult<{ refundId: string; status: "CONFIRMED"; confirmedManually: true; proofReference: string }> {
  const b = (body ?? {}) as Record<string, unknown>
  const proof = typeof b.proofReference === "string" ? b.proofReference.trim() : ""
  if (validateProofReference(proof) !== null) return fail(400, "VALIDATION_ERROR", "Dados inválidos.", [{ path: "proofReference", message: "Referência do comprovante inválida." }])
  const denied = stepUp(b.currentPassword)
  if (denied) return denied
  const limited = scenarioFailure("mock:estorno")
  if (limited) return limited
  const refund = findRefund(refundId)
  if (!refund) return fail(404, "NOT_FOUND", "Devolução não encontrada.")
  if (refund.destination !== "CARD_VIA_PORTAL" || refund.status !== "PENDING_CONFIRMATION" || scenario("mock:estorno") === "not-confirmable") {
    return fail(409, "REFUND_NOT_CONFIRMABLE", "Esta devolução não pode ser confirmada à mão.")
  }
  refund.status = "CONFIRMED"
  refund.confirmedManually = true
  refund.portalReference = proof
  refund.resolvedAt = new Date().toISOString()
  return { ok: true, status: 200, body: { refundId, status: "CONFIRMED", confirmedManually: true, proofReference: proof } }
}

// ---------------------------------------------------------------------------
// Chargebacks
// ---------------------------------------------------------------------------

let chargebackCounter = 0
const chargebacks: ChargebackDTO[] = []

function seedChargeback(patch: Partial<ChargebackDTO> & Pick<ChargebackDTO, "caseReference" | "amountCents" | "status">): ChargebackDTO {
  chargebackCounter += 1
  const base: ChargebackDTO = {
    id: `cb_${chargebackCounter}`,
    paymentIntentId: `demo_pi_${chargebackCounter + 100}`,
    amountCents: patch.amountCents,
    caseReference: patch.caseReference,
    outcome: patch.status === "OPEN" ? null : patch.status,
    notifiedAt: isoDaysAgo(10),
    responseDeadline: null,
    dossierId: `cb_${chargebackCounter}`,
    chargingSessionId: null,
    reasonCode: null,
    status: patch.status,
    debtId: null,
    createdAt: isoDaysAgo(10),
    resolvedAt: patch.status === "OPEN" ? null : isoDaysAgo(2),
    cardBlocked: patch.status === "OPEN" || patch.status === "LOST" || patch.status === "ACCEPTED",
    cardUnblockedAt: null,
    cardUnblockReason: null,
  }
  const merged = { ...base, ...patch }
  merged.cardBlocked = patch.cardBlocked ?? (merged.status === "OPEN" || ((merged.status === "LOST" || merged.status === "ACCEPTED") && merged.cardUnblockedAt === null))
  return merged
}

function seedChargebacks() {
  if (chargebacks.length > 0) return
  chargebacks.push(
    seedChargeback({ caseReference: "CASO-2026-0187", amountCents: 3782, status: "OPEN", paymentIntentId: "demo_pi_stuck_1", chargingSessionId: "demo_stuck_late_stop", reasonCode: "4837", responseDeadline: isoInDays(2), notifiedAt: isoDaysAgo(5), createdAt: isoDaysAgo(5) }),
    seedChargeback({ caseReference: "CASO-2026-0166", amountCents: 5100, status: "OPEN", reasonCode: "4853", responseDeadline: isoDaysAgo(3), notifiedAt: isoDaysAgo(18), createdAt: isoDaysAgo(18) }),
    seedChargeback({ caseReference: "CASO-2026-0201", amountCents: 2490, status: "OPEN", notifiedAt: isoDaysAgo(1), createdAt: isoDaysAgo(1) }),
    seedChargeback({ caseReference: "CASO-2026-0102", amountCents: 4300, status: "WON", notifiedAt: isoDaysAgo(40), createdAt: isoDaysAgo(40), resolvedAt: isoDaysAgo(20) }),
    seedChargeback({ caseReference: "CASO-2026-0098", amountCents: 6120, status: "LOST", reasonCode: "4837", notifiedAt: isoDaysAgo(50), createdAt: isoDaysAgo(50), resolvedAt: isoDaysAgo(30) }),
    seedChargeback({
      caseReference: "CASO-2026-0091",
      amountCents: 1980,
      status: "LOST",
      notifiedAt: isoDaysAgo(60),
      createdAt: isoDaysAgo(60),
      resolvedAt: isoDaysAgo(40),
      cardUnblockedAt: isoDaysAgo(35),
      cardUnblockReason: "Motorista comprovou a titularidade do cartão com o banco",
    }),
    seedChargeback({ caseReference: "CASO-2026-0077", amountCents: 8800, status: "ACCEPTED", debtId: "debt_demo_1", notifiedAt: isoDaysAgo(70), createdAt: isoDaysAgo(70), resolvedAt: isoDaysAgo(55) }),
  )
}

function dossierOf(cb: ChargebackDTO): ChargebackDossier {
  return {
    geradoEm: cb.createdAt,
    chargeback: { caseReference: cb.caseReference, reasonCode: cb.reasonCode, notifiedAt: cb.notifiedAt, responseDeadline: cb.responseDeadline, amountCents: cb.amountCents },
    venda: { paymentIntentId: cb.paymentIntentId, ...(acquirerIdsOf(cb.paymentIntentId) ?? {}) },
    cartao: { brand: "Visa", last4: "4242" },
    sessao: { id: cb.chargingSessionId, tarifa: "Padrão DC", energiaWh: 18000 },
    curvaDeMedicao: { pontos: 3, amostra: [{ t: 0, wh: 0 }, { t: 900, wh: 9000 }, { t: 1800, wh: 18000 }] },
    trilhaOcpp: [{ evento: "StartTransaction" }, { evento: "StopTransaction" }],
    pagador: { contaCriadaHaDias: 120, identidadeVerificada: true, aceitesDeTermos: 1 },
    nota: "Sem nome, e-mail, CPF, telefone, idTag nem titular do cartão (LGPD).",
  }
}

export function listChargebacks(url: URL): MockResult<ChargebacksListResponse> {
  seedChargebacks()
  const outcome = url.searchParams.get("outcome") as ChargebackStatus | null
  const paymentIntentId = url.searchParams.get("paymentIntentId")
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"))
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? "20")))
  if (outcome && !["OPEN", "WON", "LOST", "ACCEPTED"].includes(outcome)) return fail(400, "VALIDATION_ERROR", "outcome inválido.")
  const filtered = chargebacks
    .filter((c) => (!outcome || c.status === outcome) && (!paymentIntentId || c.paymentIntentId === paymentIntentId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { ok: true, status: 200, body: { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize } }
}

export function getChargeback(id: string): MockResult<ChargebackDTO> {
  seedChargebacks()
  const cb = chargebacks.find((c) => c.id === id)
  return cb ? { ok: true, status: 200, body: cb } : fail(404, "NOT_FOUND", "Chargeback não encontrado.")
}

export function getDossier(id: string): MockResult<ChargebackDossier> {
  seedChargebacks()
  const cb = chargebacks.find((c) => c.id === id)
  if (!cb || scenario("mock:chargeback") === "dossier-404") return fail(404, "NOT_FOUND", "Dossiê não encontrado.")
  return { ok: true, status: 200, body: dossierOf(cb) }
}

export function registerChargeback(intentId: string, body: unknown, payment: { provider: string; amountCapturedCents: number | null; chargingSessionId: string | null } | null): MockResult<{ chargebackId: string; dossierId: string }> {
  seedChargebacks()
  const b = (body ?? {}) as Record<string, unknown>
  const allowed = new Set(["amountCents", "notifiedAt", "caseReference", "reasonCode", "responseDeadline"])
  const problems: Array<{ path: string; message: string }> = []
  const caseReference = typeof b.caseReference === "string" ? b.caseReference.trim() : ""
  if (Object.keys(b).some((k) => !allowed.has(k))) problems.push({ path: "", message: "Campo desconhecido." })
  if (typeof b.amountCents !== "number" || !Number.isInteger(b.amountCents) || b.amountCents <= 0) problems.push({ path: "amountCents", message: "Valor inválido." })
  const notified = typeof b.notifiedAt === "string" ? new Date(b.notifiedAt) : null
  if (!notified || Number.isNaN(notified.getTime())) problems.push({ path: "notifiedAt", message: "Use uma data ISO 8601." })
  else if (notified.getTime() > Date.now() + 5 * 60_000) problems.push({ path: "notifiedAt", message: "A data do aviso não pode estar no futuro." })
  if (caseReference.length < 1 || caseReference.length > 120 || hasControl(caseReference)) problems.push({ path: "caseReference", message: "Informe a referência do caso na Cielo." })
  if (b.reasonCode !== undefined && (typeof b.reasonCode !== "string" || b.reasonCode.trim().length < 1 || b.reasonCode.length > 40)) problems.push({ path: "reasonCode", message: "Código inválido." })
  if (b.responseDeadline !== undefined) {
    const deadline = typeof b.responseDeadline === "string" ? new Date(b.responseDeadline) : null
    if (!deadline || Number.isNaN(deadline.getTime())) problems.push({ path: "responseDeadline", message: "Use uma data ISO 8601." })
    else if (notified && deadline.getTime() < notified.getTime()) problems.push({ path: "responseDeadline", message: "O prazo de resposta não pode ser anterior ao aviso." })
  }
  if (problems.length > 0) return fail(400, "VALIDATION_ERROR", "Dados inválidos.", problems)
  const limited = scenarioFailure("mock:chargeback")
  if (limited) return limited

  const already = chargebacks.find((c) => c.paymentIntentId === intentId)
  if (already) return fail(409, "CHARGEBACK_ALREADY_REGISTERED", "Já existe um chargeback registrado para esta venda.", { chargebackId: already.id })
  if (!payment || payment.provider !== "CIELO_CARD") return fail(404, "PAYMENT_NOT_FOUND", "Venda de cartão não encontrada.")
  if (!payment.amountCapturedCents) return fail(409, "PAYMENT_NOT_CAPTURED", "Esta venda não tem valor capturado.")
  if ((b.amountCents as number) > payment.amountCapturedCents) return fail(400, "VALIDATION_ERROR", "Dados inválidos.", [{ path: "amountCents", message: "O valor do chargeback passa do que foi capturado nesta venda." }])

  const cb = seedChargeback({
    caseReference,
    amountCents: b.amountCents as number,
    status: "OPEN",
    paymentIntentId: intentId,
    chargingSessionId: payment.chargingSessionId,
    reasonCode: typeof b.reasonCode === "string" ? b.reasonCode.trim() : null,
    responseDeadline: typeof b.responseDeadline === "string" ? b.responseDeadline : null,
    notifiedAt: (b.notifiedAt as string) ?? new Date().toISOString(),
    createdAt: new Date().toISOString(),
  })
  chargebacks.push(cb)
  return { ok: true, status: 201, body: { chargebackId: cb.id, dossierId: cb.id } }
}

export function resolveChargeback(id: string, body: unknown): MockResult<ChargebackDTO> {
  seedChargebacks()
  const b = (body ?? {}) as Record<string, unknown>
  const allowed = new Set(["outcome", "debtPolicy", "currentPassword"])
  const problems: Array<{ path: string; message: string }> = []
  if (Object.keys(b).some((k) => !allowed.has(k))) problems.push({ path: "", message: "Campo desconhecido." })
  if (b.outcome !== "WON" && b.outcome !== "LOST" && b.outcome !== "ACCEPTED") problems.push({ path: "outcome", message: "Desfecho inválido." })
  if (b.debtPolicy !== undefined && b.debtPolicy !== "CREATE_DEBT" && b.debtPolicy !== "ABSORB") problems.push({ path: "debtPolicy", message: "Política inválida." })
  if (b.debtPolicy === "CREATE_DEBT" && b.outcome === "WON") problems.push({ path: "debtPolicy", message: "Chargeback ganho não gera dívida: use apenas em LOST ou ACCEPTED." })
  if (problems.length > 0) return fail(400, "VALIDATION_ERROR", "Dados inválidos.", problems)
  const denied = stepUp(b.currentPassword)
  if (denied) return denied
  const limited = scenarioFailure("mock:chargeback")
  if (limited) return limited
  const cb = chargebacks.find((c) => c.id === id)
  if (!cb) return fail(404, "NOT_FOUND", "Chargeback não encontrado.")
  if (cb.status !== "OPEN") return fail(409, "CHARGEBACK_ALREADY_RESOLVED", "Este chargeback já teve o desfecho registrado.")

  const outcome = b.outcome as "WON" | "LOST" | "ACCEPTED"
  cb.status = outcome
  cb.outcome = outcome
  cb.resolvedAt = new Date().toISOString()
  cb.cardBlocked = outcome !== "WON"
  if (b.debtPolicy === "CREATE_DEBT") cb.debtId = `debt_${cb.id}`
  return { ok: true, status: 200, body: { ...cb } }
}

export function unblockCard(id: string, body: unknown): MockResult<ChargebackDTO> {
  seedChargebacks()
  const b = (body ?? {}) as Record<string, unknown>
  const reason = typeof b.reason === "string" ? b.reason.trim() : ""
  if (Object.keys(b).some((k) => k !== "reason" && k !== "currentPassword") || reason.length < 10 || reason.length > 500 || hasControl(reason)) {
    return fail(400, "VALIDATION_ERROR", "Dados inválidos.", [{ path: "reason", message: "Explique por que o cartão volta a ser liberado (mínimo 10 caracteres)." }])
  }
  const denied = stepUp(b.currentPassword)
  if (denied) return denied
  const limited = scenarioFailure("mock:chargeback")
  if (limited) return limited
  const cb = chargebacks.find((c) => c.id === id)
  if (!cb) return fail(404, "NOT_FOUND", "Chargeback não encontrado.")
  if (cb.status !== "LOST" && cb.status !== "ACCEPTED") return fail(409, "CHARGEBACK_NOT_LOST", "Só dá para desbloquear o cartão de um chargeback perdido ou aceito.")
  if (cb.cardUnblockedAt) return fail(409, "CARD_ALREADY_UNBLOCKED", "O cartão deste chargeback já foi desbloqueado.")
  cb.cardUnblockedAt = new Date().toISOString()
  cb.cardUnblockReason = reason
  cb.cardBlocked = false
  return { ok: true, status: 200, body: { ...cb } }
}

/** Dados da venda para registrar o chargeback: sai das sessões do mock (`generatedSessions`). */
export function findMockPayment(intentId: string): { provider: string; amountCapturedCents: number | null; chargingSessionId: string | null } | null {
  for (const session of generatedSessions) {
    const intent = session.paymentIntents.find((pi) => pi.id === intentId)
    if (intent) return { provider: intent.provider, amountCapturedCents: intent.amountCapturedCents, chargingSessionId: session.id }
  }
  return null
}

// ---------------------------------------------------------------------------
// Devolução de contas excluídas (L1.4)
// ---------------------------------------------------------------------------

interface DeletionState {
  row: Omit<AdminAccountDeletionRow, "ageDays" | "overdue" | "refundPixKey"> & { pixKey: string | null }
}

let deletions: DeletionState[] | null = null

function seedDeletions(): DeletionState[] {
  if (deletions) return deletions
  const mk = (id: string, daysAgo: number, balanceCents: number, refundStatus: AdminAccountDeletionRow["refundStatus"], pixKey: string | null, extra: Partial<AdminAccountDeletionRow> = {}): DeletionState => ({
    row: {
      id,
      userId: `anon_user_${id.slice(-4)}${id.slice(-4)}`,
      requestedAt: isoDaysAgo(daysAgo),
      balanceCentsAtRequest: balanceCents,
      refundStatus,
      pixKey,
      refundedAt: null,
      refundedByUserId: null,
      ...extra,
    },
  })
  deletions = [
    mk("del_req_0001", 45, 8750, "PENDING_REFUND", "2f6a1c3e-9b7d-4e51-a8c2-5d0e1f3b7a90"),
    mk("del_req_0002", 12, 2350, "PENDING_REFUND", "titular.exemplo@email.com"),
    mk("del_req_0003", 31, 15000, "PENDING_REFUND", null, { refundPixKeyUnreadable: true }),
    mk("del_req_0004", 20, 4000, "REFUNDED", null, { refundedAt: isoDaysAgo(8), refundedByUserId: "user_admin" }),
    mk("del_req_0005", 5, 0, "NOT_REQUIRED", null),
  ]
  return deletions
}

function toRow(state: DeletionState, now = Date.now()): AdminAccountDeletionRow {
  const { pixKey, ...rest } = state.row
  const ageDays = Math.floor((now - new Date(rest.requestedAt).getTime()) / 86_400_000)
  return {
    ...rest,
    refundPixKey: rest.refundStatus === "PENDING_REFUND" ? pixKey : null,
    ageDays,
    overdue: rest.refundStatus === "PENDING_REFUND" && ageDays > 30,
  }
}

export function listAccountDeletions(url: URL): MockResult<PaginatedResponse<AdminAccountDeletionRow>> {
  const mode = scenario("mock:devolucoes")
  if (mode === "5xx") return fail(500, "INTERNAL_ERROR", "Erro interno.")
  const status = url.searchParams.get("status")
  if (status && !["NOT_REQUIRED", "PENDING_REFUND", "REFUNDED"].includes(status)) return fail(400, "VALIDATION_ERROR", "status inválido.")
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"))
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? "20")))
  const all = mode === "empty" ? [] : seedDeletions()
  const filtered = all
    .filter((d) => !status || d.row.refundStatus === status)
    .sort((a, b) => (status === "PENDING_REFUND" ? a.row.requestedAt.localeCompare(b.row.requestedAt) : b.row.requestedAt.localeCompare(a.row.requestedAt)))
  const items = filtered.slice((page - 1) * pageSize, page * pageSize).map((d) => toRow(d))
  return { ok: true, status: 200, body: { items, meta: { page, pageSize, total: filtered.length, totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)) } } }
}

export function refundAccountDeletion(requestId: string, body: unknown, adminUserId: string): MockResult<AdminAccountDeletionRow> {
  const b = (body ?? {}) as Record<string, unknown>
  const allowed = new Set(["amountCents", "proofReference", "currentPassword"])
  const proof = typeof b.proofReference === "string" ? b.proofReference.trim() : ""
  const problems: Array<{ path: string; message: string }> = []
  if (Object.keys(b).some((k) => !allowed.has(k))) problems.push({ path: "", message: "Campo desconhecido." })
  if (typeof b.amountCents !== "number" || !Number.isInteger(b.amountCents) || b.amountCents < 1 || b.amountCents > 10_000_000) problems.push({ path: "amountCents", message: "Valor inválido." })
  if (proof.length < 1 || proof.length > 120 || hasControl(proof) || looksLikePersonalOrCardData(proof)) problems.push({ path: "proofReference", message: "Comprovante inválido." })
  if (problems.length > 0) return fail(400, "VALIDATION_ERROR", "Dados inválidos.", problems)

  const mode = scenario("mock:devolucoes")
  if (mode === "rate-limited") return fail(429, "RATE_LIMITED_ACCOUNT_DELETION", "Muitas tentativas.", undefined, { "Retry-After": "120" })
  const denied = stepUp(b.currentPassword)
  if (denied) return denied.status === 429 ? fail(429, "RATE_LIMITED_ACCOUNT_DELETION", "Muitas tentativas.", undefined, { "Retry-After": "120" }) : denied
  if (mode === "5xx") return fail(500, "INTERNAL_ERROR", "Erro interno.")
  if (mode === "key-missing") return fail(503, "PAYMENT_SECRETS_KEY_MISSING", "Chave de segredos do servidor indisponível.")

  const state = seedDeletions().find((d) => d.row.id === requestId)
  if (!state) return fail(404, "NOT_FOUND", "Pedido não encontrado.")
  if (mode === "already-refunded" || state.row.refundStatus === "REFUNDED") return fail(409, "ALREADY_REFUNDED", "Este pedido já foi devolvido.")
  if (state.row.refundStatus === "NOT_REQUIRED") return fail(409, "REFUND_NOT_REQUIRED", "Este pedido não tem saldo a devolver.")
  if (mode === "partial" || (b.amountCents as number) < state.row.balanceCentsAtRequest) return fail(409, "PARTIAL_REFUND_NOT_ALLOWED", "A devolução precisa ser do saldo integral.")
  if ((b.amountCents as number) > state.row.balanceCentsAtRequest) return fail(409, "AMOUNT_EXCEEDS_BALANCE", "O valor passa do saldo do pedido.")

  state.row.refundStatus = "REFUNDED"
  state.row.pixKey = null
  state.row.refundedAt = new Date().toISOString()
  state.row.refundedByUserId = adminUserId
  delete state.row.refundPixKeyUnreadable
  return { ok: true, status: 200, body: toRow(state) }
}

export type { MockResult }
