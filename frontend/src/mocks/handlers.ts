import { delay, http, HttpResponse } from "msw"
import {
  mockAuthTokens,
  mockChargePoints,
  mockConnectors,
  mockSites,
  mockTariffAssignments,
  mockTariffs,
  mockUsers,
  type MockUser,
} from "./data"
import {
  buildDailyMovement,
  buildDashboardLive,
  buildDashboardSummary,
  buildPaymentsReport,
  buildRevenueReport,
  buildSessionsReport,
  findSessionDetail,
  listOperators,
  type Scope,
} from "./reportsAggregate"
import {
  cardEligibilityFor,
  cardRefusalFor,
  createMockPaymentMethod,
  createMockTokenizationSession,
  createMockTopup,
  gatewayDisabledBody,
  getCommandStatus,
  getMockActiveSession,
  getMockSessionDetail,
  getMockTopup,
  getMockWallet,
  getPublicChargePointCard,
  isGatewayDisabledFor,
  isMockDriverGoogleLinkable,
  isMockDriverGoogleLinked,
  linkGoogleToMockDriver,
  listMockPaymentMethods,
  listMockSessions,
  removeMockPaymentMethod,
  setDefaultMockPaymentMethod,
  startMockSession,
  stopMockSession,
} from "./meData"
import {
  applyProfilePatch,
  bumpSessionEpoch,
  CPF_EM_USO_MOCK,
  getMockProfile,
  isValidNewPassword,
  mockHasPassword,
  registerPasswordAttempt,
  sessionEpochOf,
  validateProfilePatch,
} from "./profileData"
import { filterAuditLogs, listAuditLogActors, mockAuditLogDetails } from "./auditLogData"
import { buildPublicSites } from "./stationsData"
import { adjustDriverWallet, getDriverWallet, listDrivers } from "./driversData"
import { commandStatus, parseScenario, remoteStartPolicyDenied, startRemote } from "./remoteStartData"
import { getGatewayConfig, testGatewayConnection, updateGatewayConfig } from "./paymentGatewayData"
import { getCommunicationSettings, testCommunicationChannel, updateCommunicationSettings } from "./communicationData"
import {
  disconnectGoogle,
  generateBackupKey,
  getBackupConfig,
  getBackupRun,
  getBackupStatus,
  listBackupRuns,
  runBackupNow,
  startGoogle,
  testBackupDestination,
  updateBackupConfig,
  verifyBackup,
} from "./backupData"
import {
  cancelRefund,
  confirmRefund,
  createSessionRefund,
  findMockPayment,
  getChargeback,
  getDossier,
  getSessionRefunds,
  listAccountDeletions,
  listChargebacks,
  matchesAcquirer,
  refundAccountDeletion,
  registerChargeback,
  resolveChargeback,
  unblockCard,
  type MockResult,
} from "./reversalsData"
import { createAdminEventStream, createMeEventStream, SSE_RESPONSE_HEADERS } from "./realtimeStream"
import type {
  AuditLogListItem,
  AuthToken,
  ChargePoint,
  Connector,
  DailyMovementRow,
  PaginatedResponse,
  PaymentListRow,
  RevenueBreakdownDimension,
  RevenueGranularity,
  RevenueSeriesPoint,
  Role,
  SessionListRow,
  Site,
  Tariff,
  TariffAssignment,
  TariffAssignmentScope,
} from "@/types/api"

/**
 * Handlers MSW espelhando o contrato real (`backend/src/api/routes/*.ts`):
 * mesmo envelope de erro `{error, code, details?}`, mesma paginação
 * `{items, meta}`, mesmos códigos de status (201/202/204/401/403/404). Isto
 * NÃO é uma reimplementação da regra de negócio da Vega — é só o suficiente
 * para provar no navegador que o frontend fala o protocolo certo enquanto o
 * backend real (Postgres/Redis) não está acessível deste ambiente.
 */

const AUTH_HEADER = (req: Request) => req.headers.get("authorization")?.split(" ")[1]

/** `v` = época da sessão do usuário quando o token foi emitido (a troca de senha a incrementa e invalida os tokens anteriores - ver `profileData.ts`). */
function fakeToken(user: MockUser) {
  return btoa(JSON.stringify({ userId: user.id, role: user.role, operatorId: user.operatorId, v: sessionEpochOf(user.id) }))
}

function currentUser(req: Request): { userId: string; role: Role; operatorId: string | null } | null {
  const token = AUTH_HEADER(req)
  if (!token) return null
  try {
    const payload = JSON.parse(atob(token)) as { userId: string; role: Role; operatorId: string | null; v?: number }
    // Token de uma época anterior à atual = revogado pela troca de senha (o backend real faz o mesmo com `sessionsValidAfter`).
    if (typeof payload.v === "number" && payload.v < sessionEpochOf(payload.userId)) return null
    return payload
  } catch {
    return null
  }
}

function errorBody(error: string, code: string) {
  return { error, code }
}

/** Traduz o resultado dos mocks de estorno/chargeback/devolução (`reversalsData.ts`) em resposta HTTP: sucesso com o corpo, erro no envelope `{error, code, details?}` (+ `Retry-After`). */
function mockResult<T>(result: MockResult<T>) {
  if (result.ok) return HttpResponse.json(result.body as never, { status: result.status })
  return HttpResponse.json({ error: result.message, code: result.code, ...(result.details !== undefined ? { details: result.details } : {}) }, { status: result.status, headers: result.headers })
}

/** Nunca devolve a senha — mesma regra do `toUserDTO` real (`auth.routes.ts`). */
function toUserDTO(user: MockUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    operatorId: user.operatorId,
    operatorName: user.operatorName,
    hasPassword: mockHasPassword(user),
  }
}

function paginate<T>(items: T[], url: URL): PaginatedResponse<T> {
  const page = Number(url.searchParams.get("page") ?? "1")
  const pageSize = Number(url.searchParams.get("pageSize") ?? "20")
  const start = (page - 1) * pageSize
  const paged = items.slice(start, start + pageSize)
  return { items: paged, meta: { page, pageSize, total: items.length, totalPages: Math.max(1, Math.ceil(items.length / pageSize)) } }
}

/** Só ADMIN/OPERATOR passam; devolve o `where` equivalente (aqui, um filtro em memória) igual ao `operatorScopeWhere` real. */
function requireStaff(req: Request) {
  const user = currentUser(req)
  if (!user) return { error: HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 }) }
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") {
    return { error: HttpResponse.json(errorBody("Acesso restrito a operadores da plataforma.", "FORBIDDEN"), { status: 403 }) }
  }
  return { user }
}

function scopedByOperator<T extends { operatorId: string }>(items: T[], user: { role: Role; operatorId: string | null }): T[] {
  if (user.role === "ADMIN") return items
  return items.filter((i) => i.operatorId === user.operatorId)
}

/** Mesma checagem de `requireStaff`, mas restrita a ADMIN — usada nas poucas rotas ADMIN-only (auth-tokens, operators). */
function requireAdmin(req: Request) {
  const user = currentUser(req)
  if (!user) return { error: HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 }) }
  if (user.role !== "ADMIN") return { error: HttpResponse.json(errorBody("Acesso restrito a administradores.", "FORBIDDEN"), { status: 403 }) }
  return { user }
}

/** Join leve que `GET /tariff-assignments` faz: `tariff: { id, name, model }`. */
function withTariffJoin(a: TariffAssignment): TariffAssignment {
  const t = mockTariffs.find((x) => x.id === a.tariffId)
  return t ? { ...a, tariff: { id: t.id, name: t.name, model: t.model } } : a
}

const ASSIGNMENT_TARGET_FIELD: Record<TariffAssignmentScope, "connectorId" | "chargePointId" | "siteId" | null> = {
  CONNECTOR: "connectorId",
  CHARGE_POINT: "chargePointId",
  SITE: "siteId",
  OPERATOR: null,
}

/** Mesma mensagem do `checkValidityWindow` do schema Zod real. */
function validateWindow(validFrom: string | undefined, validTo: string | undefined) {
  if (validFrom && validTo && new Date(validTo) <= new Date(validFrom)) return [{ path: "validTo", message: "validTo deve ser posterior a validFrom." }]
  return []
}

/** Mesmas mensagens do `checkScopeTarget` + `checkValidityWindow`: exatamente o campo certo por escopo, os outros dois ausentes. */
function validateAssignmentBody(body: Partial<TariffAssignment>) {
  const details: Array<{ path: string; message: string }> = []
  const scope = body.scope
  if (!scope || !(scope in ASSIGNMENT_TARGET_FIELD)) return [{ path: "scope", message: "Invalid enum value." }]
  if (!body.tariffId) details.push({ path: "tariffId", message: "Required" })
  const required = ASSIGNMENT_TARGET_FIELD[scope]
  for (const field of ["connectorId", "chargePointId", "siteId"] as const) {
    const present = body[field] !== undefined && body[field] !== null
    if (field === required && !present) details.push({ path: field, message: `${field} é obrigatório quando scope=${scope}.` })
    if (field !== required && present) details.push({ path: field, message: `${field} não deve ser informado quando scope=${scope}.` })
  }
  return [...details, ...validateWindow(body.validFrom, body.validTo ?? undefined)]
}

/** Rotas `/api/me/*` — DRIVER only (ver PROGRESSO.md §PWA do motorista). */
function requireDriver(req: Request) {
  const user = currentUser(req)
  if (!user) return { error: HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 }) }
  if (user.role !== "DRIVER") return { error: HttpResponse.json(errorBody("Acesso restrito a motoristas.", "FORBIDDEN"), { status: 403 }) }
  return { user }
}

// ---- Retaguarda: dashboard/relatórios --------------------------------------
// Contrato desenhado pela Nova (ver `.claude/agent-memory/nova/
// decisoes-retaguarda-relatorios.md`) e ainda sem rota real do Vega — os
// handlers abaixo consultam `reportsAggregate.ts`, que agrega as sessões
// sintéticas de `reportsData.ts` com as MESMAS regras que a API real vai
// seguir (revenue nunca soma topup Pix, bucket de dia por `startedAt`,
// escopo por operador). Não é reimplementação de regra de negócio nova —
// é só o suficiente para provar o contrato no navegador.

function toScope(user: { role: Role; operatorId: string | null }): Scope {
  return { role: user.role, operatorId: user.operatorId }
}

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function daysAgoISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** `from`/`to` têm default de 30 dias — o mesmo default do preset "30d" da UI — para uma chamada sem query params nunca quebrar. */
function parsePeriod(url: URL) {
  return {
    from: url.searchParams.get("from") ?? daysAgoISO(29),
    to: url.searchParams.get("to") ?? todayISO(),
    siteId: url.searchParams.get("siteId") ?? undefined,
    operatorId: url.searchParams.get("operatorId") ?? undefined,
  }
}

function parsePagination(url: URL, defaultPageSize = 20) {
  return {
    page: Number(url.searchParams.get("page") ?? "1"),
    pageSize: Number(url.searchParams.get("pageSize") ?? String(defaultPageSize)),
  }
}

/** CSV simples (RFC4180-ish: aspas duplicadas quando o valor tem vírgula/aspas/quebra de linha). */
function toCsv<T>(rows: T[], columns: Array<{ key: keyof T; label: string }>): string {
  const escape = (value: unknown): string => {
    const s = value === null || value === undefined ? "" : String(value)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = columns.map((c) => escape(c.label)).join(",")
  const lines = rows.map((row) => columns.map((c) => escape(row[c.key])).join(","))
  return [header, ...lines].join("\n")
}

function csvResponse(csv: string, filename: string) {
  return new HttpResponse(csv, {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
  })
}

/**
 * Mesma regra do backend (`createChargePointSchema`, Órion A1): `basicAuthSecret`
 * de 16 a 40 caracteres e no máximo 72 bytes (limite do bcrypt). Obrigatório
 * na criação, opcional na edição. Devolve o 400 `VALIDATION_ERROR` ou `null`.
 */
function invalidBasicAuthSecret(secret: string | undefined, required: boolean) {
  if (secret === undefined) {
    return required ? HttpResponse.json(errorBody("basicAuthSecret: obrigatório.", "VALIDATION_ERROR"), { status: 400 }) : null
  }
  const ok = secret.length >= 16 && secret.length <= 40 && new TextEncoder().encode(secret).length <= 72
  return ok ? null : HttpResponse.json(errorBody("basicAuthSecret: de 16 a 40 caracteres (até 72 bytes).", "VALIDATION_ERROR"), { status: 400 })
}

/** Tokens de redefinição já consumidos (uso único), por vida da página. */
const usedResetTokens = new Set<string>()

export const handlers = [
  // ---- Auth -----------------------------------------------------------------
  // Limites de tentativa (contrato: 429 com `code`, ver `lib/authErrors.ts`).
  // Disparados por e-mail para dar pra provar a tela sem esperar 20 falhas:
  //  - "conta-bloqueada@..." → 429 RATE_LIMITED_ACCOUNT (throttle por conta; tranca mesmo com a senha certa)
  //  - "ip-bloqueado@..."    → 429 RATE_LIMITED_AUTH (limite por IP)
  http.post("/api/auth/login", async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string }
    if (body.email.startsWith("conta-bloqueada@")) {
      return HttpResponse.json(errorBody("Muitas tentativas de login para esta conta. Tente novamente mais tarde.", "RATE_LIMITED_ACCOUNT"), {
        status: 429,
        headers: { "Retry-After": "300" },
      })
    }
    if (body.email.startsWith("ip-bloqueado@")) {
      return HttpResponse.json(errorBody("Muitas requisições. Tente novamente em instantes.", "RATE_LIMITED_AUTH"), { status: 429 })
    }
    const user = mockUsers.find((u) => u.email === body.email)
    if (!user || !mockHasPassword(user) || user.password !== body.password) {
      return HttpResponse.json(errorBody("E-mail ou senha inválidos.", "INVALID_CREDENTIALS"), { status: 401 })
    }
    return HttpResponse.json({ token: fakeToken(user), user: toUserDTO(user) })
  }),

  http.post("/api/auth/register", async ({ request }) => {
    const body = (await request.json()) as { name: string; email: string; password: string; phone?: string }
    if (mockUsers.some((u) => u.email === body.email)) {
      return HttpResponse.json(errorBody("Já existe uma conta com este e-mail.", "EMAIL_TAKEN"), { status: 409 })
    }
    const newUser: MockUser = {
      id: `user_${Date.now()}`,
      name: body.name,
      email: body.email,
      role: "DRIVER",
      operatorId: null,
      operatorName: null,
      password: body.password,
    }
    mockUsers.push(newUser)
    return HttpResponse.json({ token: fakeToken(newUser), user: toUserDTO(newUser) }, { status: 201 })
  }),

  // ---- Login com Google (GIS) ---------------------------------------------------
  // Contrato: `PublicClientConfig`/`GoogleAuthRequest` em `types/api.ts`. O
  // script real do Google não roda em localhost com Client ID fake, então o
  // frontend em modo mock mostra um botão "Google (mock)" (ver
  // `GoogleAuthSection`) que manda as credentials abaixo:
  //  - vazia            → 401 INVALID_GOOGLE_TOKEN
  //  - "bloqueado"      → 403 GOOGLE_LOGIN_NOT_ALLOWED (e-mail de ADMIN/OPERATOR)
  //  - "nao-verificado" → 403 GOOGLE_EMAIL_NOT_VERIFIED
  //  - "novo"           → 201, cria motorista novo
  //  - qualquer outra   → 200, entra no motorista de sempre (mesmo do e-mail/senha)
  // `mock:google-rate-limited=1` (localStorage) → QUALQUER credential responde 429
  // RATE_LIMITED_AUTH (limite por IP; o Google só tem esse, não o por conta).
  // Config controlável por localStorage (os handlers rodam na página, não no
  // service worker): `mock:google-disabled=1` → `googleClientId: null`, pra
  // provar a tela SEM o botão (usado no E2E e na validação visual).
  http.get("/api/public/config", () => {
    const disabled = localStorage.getItem("mock:google-disabled") === "1"
    return HttpResponse.json({ googleClientId: disabled ? null : "mock-client-id.apps.googleusercontent.com" })
  }),

  // I-7 - `POST /api/auth/google/link` (AUTENTICADO, só DRIVER): vincula o Google à conta LOGADA, sem trocar de conta, sem zerar a senha e sem token novo.
  // Espelha `backend/src/api/routes/auth.routes.ts`. Desfechos: 200 `{linked:true}`; 400 sem credential; 401 sem sessão / `INVALID_GOOGLE_TOKEN`; 403
  // `GOOGLE_EMAIL_NOT_VERIFIED` | `GOOGLE_EMAIL_MISMATCH` | `GOOGLE_LOGIN_NOT_ALLOWED`; 409 `GOOGLE_ALREADY_LINKED`; 503 `GOOGLE_NOT_CONFIGURED`; 429 `RATE_LIMITED_AUTH`.
  // Cenários: a conta `so-senha@` vincula de verdade (o GET de cartões passa a dizer elegível); `localStorage["mock:google-link-error"]` = o código a devolver;
  // `["mock:google-other-email"]="1"` (ou credential `outro-email`) = Google de outro e-mail; `["mock:google-rate-limited"]="1"` = 429.
  http.post("/api/auth/google/link", async ({ request }) => {
    const current = currentUser(request)
    if (!current) return HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 })
    const body = (await request.json().catch(() => ({}))) as { credential?: string }
    const credential = body.credential?.trim() ?? ""
    if (!credential) return HttpResponse.json({ error: "Dados inválidos.", code: "VALIDATION_ERROR", details: [{ path: "credential", message: "Required" }] }, { status: 400 })
    if (localStorage.getItem("mock:google-rate-limited") === "1") {
      return HttpResponse.json(errorBody("Muitas requisições. Tente novamente em instantes.", "RATE_LIMITED_AUTH"), { status: 429 })
    }
    if (current.role !== "DRIVER") return HttpResponse.json(errorBody("Esta conta não pode entrar com Google.", "GOOGLE_LOGIN_NOT_ALLOWED"), { status: 403 })
    const forced = localStorage.getItem("mock:google-link-error")
    const FORCED: Record<string, { status: number; message: string }> = {
      INVALID_GOOGLE_TOKEN: { status: 401, message: "Token do Google inválido." },
      GOOGLE_EMAIL_NOT_VERIFIED: { status: 403, message: "O e-mail da conta Google não está verificado." },
      GOOGLE_EMAIL_MISMATCH: { status: 403, message: "O e-mail do Google é diferente do e-mail desta conta." },
      GOOGLE_ALREADY_LINKED: { status: 409, message: "Esta conta ou este Google já está vinculado." },
      GOOGLE_NOT_CONFIGURED: { status: 503, message: "Login com Google não está configurado." },
      GOOGLE_LOGIN_NOT_ALLOWED: { status: 403, message: "Esta conta não pode entrar com Google." },
    }
    if (forced && FORCED[forced]) return HttpResponse.json(errorBody(FORCED[forced].message, forced), { status: FORCED[forced].status })
    if (credential === "nao-verificado") return HttpResponse.json(errorBody(FORCED.GOOGLE_EMAIL_NOT_VERIFIED.message, "GOOGLE_EMAIL_NOT_VERIFIED"), { status: 403 })
    if (credential === "outro-email" || localStorage.getItem("mock:google-other-email") === "1") {
      return HttpResponse.json(errorBody(FORCED.GOOGLE_EMAIL_MISMATCH.message, "GOOGLE_EMAIL_MISMATCH"), { status: 403 })
    }
    if (!isMockDriverGoogleLinkable(current.userId) || isMockDriverGoogleLinked(current.userId)) {
      return HttpResponse.json(errorBody(FORCED.GOOGLE_ALREADY_LINKED.message, "GOOGLE_ALREADY_LINKED"), { status: 409 })
    }
    linkGoogleToMockDriver(current.userId)
    return HttpResponse.json({ linked: true })
  }),

  http.post("/api/auth/google", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { credential?: string }
    const credential = body.credential?.trim() ?? ""
    if (localStorage.getItem("mock:google-rate-limited") === "1") {
      return HttpResponse.json(errorBody("Muitas requisições. Tente novamente em instantes.", "RATE_LIMITED_AUTH"), { status: 429 })
    }
    if (!credential) return HttpResponse.json(errorBody("Token do Google inválido.", "INVALID_GOOGLE_TOKEN"), { status: 401 })
    if (credential === "bloqueado") {
      return HttpResponse.json(errorBody("Esta conta não pode entrar com o Google.", "GOOGLE_LOGIN_NOT_ALLOWED"), { status: 403 })
    }
    if (credential === "nao-verificado") {
      return HttpResponse.json(errorBody("E-mail do Google não verificado.", "GOOGLE_EMAIL_NOT_VERIFIED"), { status: 403 })
    }
    if (credential === "novo") {
      const created: MockUser = {
        id: `user_google_${Date.now()}`,
        name: "Nova Conta Google",
        email: `google.${Date.now()}@example.com`,
        role: "DRIVER",
        operatorId: null,
        operatorName: null,
        password: "",
      }
      mockUsers.push(created)
      return HttpResponse.json({ token: fakeToken(created), user: toUserDTO(created) }, { status: 201 })
    }
    // L1.2: `localStorage["mock:google-as"]` = id do motorista em que o "Google (mock)" entra (ex.: a conta só-Google, sem senha).
    const driver = mockUsers.find((u) => u.role === "DRIVER" && u.id === (localStorage.getItem("mock:google-as") ?? "user_driver"))
    if (!driver) return HttpResponse.json(errorBody("Token do Google inválido.", "INVALID_GOOGLE_TOKEN"), { status: 401 })
    return HttpResponse.json({ token: fakeToken(driver), user: toUserDTO(driver) })
  }),

  // ---- Perfil do motorista e troca de senha (L1.2) --------------------------------------------------------------------------------------------------------
  // Contrato: `MeProfile`/`UpdateMeProfileRequest`/`ChangePasswordRequest` em `types/api.ts`; regras e gatilhos de falha em `mocks/profileData.ts`.
  http.get("/api/me/profile", async ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const forced = localStorage.getItem("mock:profile-get")
    if (forced === "slow") await delay(4000) // deixa o ESQUELETO na tela tempo bastante para medir a forma dele (régua do perfil)
    if (forced === "network") return HttpResponse.error()
    if (forced === "500") return HttpResponse.json(errorBody("Falha simulada.", "INTERNAL_ERROR"), { status: 500 })
    if (forced === "empty") return HttpResponse.json(null)
    const user = mockUsers.find((u) => u.id === scope.user.userId)
    if (!user) return HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 })
    return HttpResponse.json(getMockProfile(user))
  }),

  http.patch("/api/me/profile", async ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const forced = localStorage.getItem("mock:profile-patch")
    if (forced === "network") return HttpResponse.error()
    if (forced === "500") return HttpResponse.json(errorBody("Falha simulada.", "INTERNAL_ERROR"), { status: 500 })
    if (forced === "429") return HttpResponse.json(errorBody("Muitas requisições. Tente novamente em instantes.", "RATE_LIMITED_PROFILE"), { status: 429 })
    const user = mockUsers.find((u) => u.id === scope.user.userId)
    if (!user) return HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 })
    const { issues, patch } = validateProfilePatch(await request.json().catch(() => null))
    if (issues.length > 0) return HttpResponse.json({ error: "Dados inválidos.", code: "VALIDATION_ERROR", details: issues }, { status: 400 })
    if (patch.cpf === CPF_EM_USO_MOCK) return HttpResponse.json(errorBody("Este CPF já está cadastrado em outra conta.", "CPF_IN_USE"), { status: 409 })
    return HttpResponse.json(applyProfilePatch(user, patch))
  }),

  // `POST /api/auth/password` (qualquer papel autenticado). Conta com senha exige a atual (403 `INVALID_CURRENT_PASSWORD` - 403 e NÃO 401, para não deslogar); conta só-Google define a
  // primeira sem ela. Sucesso: token NOVO e todos os anteriores revogados. Limite real: 8 por 15 min por usuário (`RATE_LIMITED_PASSWORD`).
  http.post("/api/auth/password", async ({ request }) => {
    const current = currentUser(request)
    if (!current) return HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 })
    const forced = localStorage.getItem("mock:password-fail")
    if (forced === "network") return HttpResponse.error()
    if (forced === "500") return HttpResponse.json(errorBody("Falha simulada.", "INTERNAL_ERROR"), { status: 500 })
    if (forced === "429" || !registerPasswordAttempt(current.userId)) {
      return HttpResponse.json(errorBody("Muitas tentativas. Tente novamente em instantes.", "RATE_LIMITED_PASSWORD"), { status: 429, headers: { "Retry-After": "300" } })
    }
    const body = (await request.json().catch(() => ({}))) as { currentPassword?: string; newPassword?: unknown }
    if (!isValidNewPassword(body.newPassword)) {
      return HttpResponse.json({ error: "Dados inválidos.", code: "VALIDATION_ERROR", details: [{ path: "newPassword", message: "Senha inválida." }] }, { status: 400 })
    }
    const user = mockUsers.find((u) => u.id === current.userId)
    if (!user) return HttpResponse.json(errorBody("Token inválido ou expirado.", "UNAUTHORIZED"), { status: 401 })
    if (mockHasPassword(user)) {
      if (!body.currentPassword) return HttpResponse.json(errorBody("Informe a senha atual.", "CURRENT_PASSWORD_REQUIRED"), { status: 400 })
      if (body.currentPassword !== user.password) return HttpResponse.json(errorBody("Senha atual incorreta.", "INVALID_CURRENT_PASSWORD"), { status: 403 })
      if (body.currentPassword === body.newPassword) return HttpResponse.json(errorBody("A nova senha precisa ser diferente da atual.", "PASSWORD_UNCHANGED"), { status: 400 })
    }
    user.password = body.newPassword
    user.hasPassword = true
    bumpSessionEpoch(user.id)
    return HttpResponse.json({ token: fakeToken(user), user: toUserDTO(user) })
  }),

  // ---- Esqueci / redefinir senha (L1.3) -----------------------------------------------------------------------------------------------------------------
  // `POST /api/auth/password/forgot` (pública): SEMPRE 202 `{ ok: true }` para e-mail bem formado - existindo a conta ou não, ADMIN ou não (o backend real não envia nada para ADMIN, e
  // a resposta é a mesma). Gatilhos por e-mail para provar a tela sem esperar o limite de verdade:
  //  - "ip-bloqueado@..."   -> 429 RATE_LIMITED_AUTH com Retry-After: 300 (o mesmo gatilho do login)
  //  - "erro-servidor@..."  -> 500
  //  - "sem-rede@..."       -> falha de rede (sem resposta)
  //  - e-mail malformado    -> 400 VALIDATION_ERROR com details[].path = "email"
  http.post("/api/auth/password/forgot", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown }
    const email = typeof body.email === "string" ? body.email.trim() : ""
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) {
      return HttpResponse.json({ error: "Dados inválidos.", code: "VALIDATION_ERROR", details: [{ path: "email", message: "Invalid email" }] }, { status: 400 })
    }
    if (email.startsWith("sem-rede@")) return HttpResponse.error()
    if (email.startsWith("erro-servidor@")) return HttpResponse.json(errorBody("Erro interno.", "INTERNAL_ERROR"), { status: 500 })
    if (email.startsWith("ip-bloqueado@")) {
      return HttpResponse.json(errorBody("Muitas requisições. Tente novamente em instantes.", "RATE_LIMITED_AUTH"), { status: 429, headers: { "Retry-After": "300" } })
    }
    return HttpResponse.json({ ok: true }, { status: 202 })
  }),

  // `POST /api/auth/password/reset` (pública): 204 sem corpo e SEM sessão. Ordem do backend: corpo (VALIDATION_ERROR - o token NÃO é gasto) -> estado do token. O token é de 43 caracteres base64url; os
  // gatilhos são pelo COMEÇO dele (o E2E completa com "A" até 43):
  //  - "invalido..."     -> 400 RESET_TOKEN_INVALID (expirado/usado/inexistente: um código só)
  //  - "limite..."      -> 429 RATE_LIMITED_AUTH com Retry-After: 300
  //  - "indisponivel..." -> 503 SERVICE_UNAVAILABLE
  //  - "quebrado..."    -> 500
  //  - "semrede..."     -> falha de rede
  //  - "motorista..."   -> OK e troca DE VERDADE a senha de motorista@ (para o E2E entrar com a nova no login) e derruba as sessões (`bumpSessionEpoch`)
  //  - qualquer outro   -> OK sem tocar em conta nenhuma
  // `localStorage["mock:reset-weak"]="1"` -> 400 VALIDATION_ERROR (newPassword) mesmo para senha que o cliente aceita.
  // Uso único: o mesmo token duas vezes -> 400 RESET_TOKEN_INVALID na segunda (estado vive na página, como o resto dos mocks).
  http.post("/api/auth/password/reset", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { token?: unknown; newPassword?: unknown }
    // `mock:reset-weak=1` (localStorage): o servidor recusa a senha por um critério que o cliente não conhece (política mais dura que 10-72 bytes) - prova que a tela mantém o formulário.
    if (!isValidNewPassword(body.newPassword) || localStorage.getItem("mock:reset-weak") === "1") {
      return HttpResponse.json({ error: "Dados inválidos.", code: "VALIDATION_ERROR", details: [{ path: "newPassword", message: "Senha inválida." }] }, { status: 400 })
    }
    const token = typeof body.token === "string" ? body.token : ""
    if (token.startsWith("semrede")) return HttpResponse.error()
    if (token.startsWith("quebrado")) return HttpResponse.json(errorBody("Erro interno.", "INTERNAL_ERROR"), { status: 500 })
    if (token.startsWith("indisponivel")) return HttpResponse.json(errorBody("Serviço temporariamente indisponível. Tente novamente em instantes.", "SERVICE_UNAVAILABLE"), { status: 503 })
    if (token.startsWith("limite")) {
      return HttpResponse.json(errorBody("Muitas tentativas com link inválido. Tente novamente mais tarde.", "RATE_LIMITED_AUTH"), { status: 429, headers: { "Retry-After": "300" } })
    }
    if (token.startsWith("invalido") || usedResetTokens.has(token)) {
      return HttpResponse.json(errorBody("Este link de redefinição é inválido ou expirou. Peça um novo.", "RESET_TOKEN_INVALID"), { status: 400 })
    }
    usedResetTokens.add(token)
    if (token.startsWith("motorista")) {
      const driver = mockUsers.find((u) => u.email === "motorista@innoelektron.com")
      if (driver) {
        driver.password = body.newPassword
        bumpSessionEpoch(driver.id)
      }
    }
    return new HttpResponse(null, { status: 204 })
  }),

  // ---- Sites públicos ---------------------------------------------------------
  // `GET /api/sites` no contrato ESTENDIDO (`mocks/stationsData.ts`): `isFree`,
  // `online`, `ocppIdentity`, `connectorSummary` + bounding box (todos os 4
  // limites juntos, ou nenhum — igual ao backend). Default de 50 por página.
  http.get("/api/sites", ({ request }) => {
    const url = new URL(request.url)
    // Só para o E2E do error boundary (`RouteError`): resposta com FORMATO quebrado (sem `connectorSummary`), que faz o card lançar na renderização.
    if (localStorage.getItem("mock:sites-malformed") === "1") {
      return HttpResponse.json({ items: [{ id: "quebrado", name: "Quebrado" }], meta: { page: 1, pageSize: 12, total: 1, totalPages: 1 } })
    }
    const num = (key: string) => (url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined)
    const [minLat, maxLat, minLng, maxLng] = [num("minLat"), num("maxLat"), num("minLng"), num("maxLng")]
    const box = [minLat, maxLat, minLng, maxLng]
    if (box.some((v) => v !== undefined) && !box.every((v) => v !== undefined)) {
      return HttpResponse.json(errorBody("Informe minLat, maxLat, minLng e maxLng juntos, ou nenhum deles.", "VALIDATION_ERROR"), { status: 400 })
    }
    let sites = buildPublicSites()
    if (minLat !== undefined && maxLat !== undefined && minLng !== undefined && maxLng !== undefined) {
      sites = sites.filter((s) => s.latitude >= minLat && s.latitude <= maxLat && s.longitude >= minLng && s.longitude <= maxLng)
    }
    if (!url.searchParams.has("pageSize")) url.searchParams.set("pageSize", "50")
    return HttpResponse.json(paginate(sites, url))
  }),

  // ---- Sites admin -------------------------------------------------------------
  http.get("/api/admin/sites", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    // Só para os E2E/critérios do Admin (F-D): `mock:admin-sites=error` -> 500 (ErrorState de marca); `=empty` -> lista vazia (vazio de primeiro uso com mascote).
    const forced = localStorage.getItem("mock:admin-sites")
    if (forced === "error") return HttpResponse.json(errorBody("Falha simulada.", "INTERNAL_ERROR"), { status: 500 })
    if (forced === "empty") return HttpResponse.json(paginate([], url))
    return HttpResponse.json(paginate(scopedByOperator(mockSites, scope.user), url))
  }),

  http.post("/api/admin/sites", async ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const body = (await request.json()) as Partial<Site>
    const operatorId = scope.user.role === "ADMIN" ? body.operatorId : scope.user.operatorId
    if (!operatorId) return HttpResponse.json(errorBody("operatorId é obrigatório neste corpo quando quem cria é ADMIN.", "VALIDATION_ERROR"), { status: 400 })
    const site: Site = {
      id: `site_${Date.now()}`,
      operatorId,
      name: body.name ?? "",
      addressLine: body.addressLine ?? "",
      city: body.city ?? "",
      state: body.state ?? "",
      postalCode: body.postalCode ?? "",
      country: body.country ?? "BR",
      latitude: body.latitude ?? 0,
      longitude: body.longitude ?? 0,
      timezone: body.timezone ?? "America/Sao_Paulo",
      openingHours: null,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    mockSites.push(site)
    return HttpResponse.json(site, { status: 201 })
  }),

  http.patch("/api/admin/sites/:id", async ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const site = scopedByOperator(mockSites, scope.user).find((s) => s.id === params.id)
    if (!site) return HttpResponse.json(errorBody("Site não encontrado.", "NOT_FOUND"), { status: 404 })
    Object.assign(site, await request.json(), { updatedAt: new Date().toISOString() })
    return HttpResponse.json(site)
  }),

  http.delete("/api/admin/sites/:id", ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const site = scopedByOperator(mockSites, scope.user).find((s) => s.id === params.id)
    if (!site) return HttpResponse.json(errorBody("Site não encontrado.", "NOT_FOUND"), { status: 404 })
    site.active = false
    return new HttpResponse(null, { status: 204 })
  }),

  // ---- Charge points admin ------------------------------------------------------
  http.get("/api/admin/charge-points", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const items = scopedByOperator(mockChargePoints, scope.user).map((cp) => ({
      ...cp,
      connectors: mockConnectors.filter((c) => c.chargePointId === cp.id),
      site: mockSites.find((s) => s.id === cp.siteId),
    }))
    return HttpResponse.json(paginate(items, url))
  }),

  http.post("/api/admin/charge-points", async ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const body = (await request.json()) as Partial<ChargePoint> & { siteId: string; basicAuthSecret?: string }
    const secretError = invalidBasicAuthSecret(body.basicAuthSecret, true)
    if (secretError) return secretError
    const site = scopedByOperator(mockSites, scope.user).find((s) => s.id === body.siteId)
    if (!site) return HttpResponse.json(errorBody("Site não encontrado.", "NOT_FOUND"), { status: 404 })
    const cp: ChargePoint = {
      id: `cp_${Date.now()}`,
      operatorId: site.operatorId,
      siteId: site.id,
      ocppIdentity: body.ocppIdentity ?? "",
      vendor: body.vendor ?? null,
      model: body.model ?? null,
      serialNumber: body.serialNumber ?? null,
      firmwareVersion: body.firmwareVersion ?? null,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    mockChargePoints.push(cp)
    return HttpResponse.json(cp, { status: 201 })
  }),

  http.patch("/api/admin/charge-points/:id", async ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const cp = scopedByOperator(mockChargePoints, scope.user).find((c) => c.id === params.id)
    if (!cp) return HttpResponse.json(errorBody("Charge point não encontrado.", "NOT_FOUND"), { status: 404 })
    const body = (await request.json()) as Record<string, unknown>
    const secretError = invalidBasicAuthSecret(body.basicAuthSecret as string | undefined, false)
    if (secretError) return secretError
    delete body.basicAuthSecret // nunca persistido em claro — mesma regra do backend real (vira hash lá; aqui nem guardamos)
    Object.assign(cp, body, { updatedAt: new Date().toISOString() })
    return HttpResponse.json(cp)
  }),

  http.delete("/api/admin/charge-points/:id", ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const cp = scopedByOperator(mockChargePoints, scope.user).find((c) => c.id === params.id)
    if (!cp) return HttpResponse.json(errorBody("Charge point não encontrado.", "NOT_FOUND"), { status: 404 })
    cp.active = false
    return new HttpResponse(null, { status: 204 })
  }),

  // L1.5 - recarga remota pelo ADMIN (espelho de `chargePoints.routes.ts`; cenários e ordem das checagens em `remoteStartData.ts`). ANTES da rota genérica abaixo: o MSW usa a primeira que casa.
  http.post("/api/admin/charge-points/:id/commands/remote-start", async ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    if (remoteStartPolicyDenied(scope.user.role)) {
      return HttpResponse.json(errorBody("Apenas administradores da plataforma podem iniciar recarga remota.", "FORBIDDEN"), { status: 403 })
    }
    const scenario = parseScenario(localStorage.getItem("mock:remote-start"))
    if (scenario === "5xx") return HttpResponse.json(errorBody("Erro interno.", "INTERNAL_ERROR"), { status: 500 })
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const result = startRemote({ chargePointId: String(params.id), body, scenario, scope: scope.user })
    if (!result.ok) return HttpResponse.json({ ...errorBody(result.message, result.code), ...(result.details ? { details: result.details } : {}) }, { status: result.status })
    return HttpResponse.json(result.body, { status: result.status })
  }),

  // L1.5 - resultado do comando (só ADMIN, DL4). 404 `COMMAND_NOT_FOUND` para inexistente/expirado/fora de escopo.
  http.get("/api/admin/commands/:correlationId", ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    if (remoteStartPolicyDenied(scope.user.role)) {
      return HttpResponse.json(errorBody("Apenas administradores da plataforma podem iniciar recarga remota.", "FORBIDDEN"), { status: 403 })
    }
    const result = commandStatus(String(params.correlationId), scope.user)
    if (!result.ok) return HttpResponse.json(errorBody(result.message, result.code), { status: result.status })
    return HttpResponse.json(result.body)
  }),

  http.post("/api/admin/charge-points/:id/commands/:command", ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const cp = scopedByOperator(mockChargePoints, scope.user).find((c) => c.id === params.id)
    if (!cp) return HttpResponse.json(errorBody("Charge point não encontrado.", "NOT_FOUND"), { status: 404 })
    return HttpResponse.json({ correlationId: `corr_${Date.now()}`, status: "PENDING" }, { status: 202 })
  }),

  // ---- Connectors admin -----------------------------------------------------
  http.get("/api/admin/connectors", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    return HttpResponse.json(paginate(scopedByOperator(mockConnectors, scope.user), url))
  }),

  http.post("/api/admin/connectors", async ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const body = (await request.json()) as Partial<Connector> & { chargePointId: string }
    const cp = scopedByOperator(mockChargePoints, scope.user).find((c) => c.id === body.chargePointId)
    if (!cp) return HttpResponse.json(errorBody("Charge point não encontrado.", "NOT_FOUND"), { status: 404 })
    const connector: Connector = {
      id: `conn_${Date.now()}`,
      operatorId: cp.operatorId,
      chargePointId: cp.id,
      connectorId: body.connectorId ?? 1,
      type: body.type ?? "AC_TYPE2",
      status: "AVAILABLE",
      maxPowerKw: body.maxPowerKw ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    mockConnectors.push(connector)
    return HttpResponse.json(connector, { status: 201 })
  }),

  http.patch("/api/admin/connectors/:id", async ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const connector = scopedByOperator(mockConnectors, scope.user).find((c) => c.id === params.id)
    if (!connector) return HttpResponse.json(errorBody("Conector não encontrado.", "NOT_FOUND"), { status: 404 })
    Object.assign(connector, await request.json(), { updatedAt: new Date().toISOString() })
    return HttpResponse.json(connector)
  }),

  http.delete("/api/admin/connectors/:id", ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const connector = scopedByOperator(mockConnectors, scope.user).find((c) => c.id === params.id)
    if (!connector) return HttpResponse.json(errorBody("Conector não encontrado.", "NOT_FOUND"), { status: 404 })
    connector.status = "UNAVAILABLE"
    return new HttpResponse(null, { status: 204 })
  }),

  // ---- Tariffs admin ----------------------------------------------------------
  http.get("/api/admin/tariffs", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    return HttpResponse.json(paginate(scopedByOperator(mockTariffs, scope.user), url))
  }),

  http.post("/api/admin/tariffs", async ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const body = (await request.json()) as Partial<Tariff> & { operatorId?: string }
    const operatorId = scope.user.role === "ADMIN" ? body.operatorId : scope.user.operatorId
    if (!operatorId) return HttpResponse.json(errorBody("operatorId é obrigatório neste corpo quando quem cria é ADMIN.", "VALIDATION_ERROR"), { status: 400 })
    const tariff: Tariff = {
      id: `tariff_${Date.now()}`,
      operatorId,
      name: body.name ?? "",
      model: body.model ?? "PER_KWH",
      pricePerKwh: body.pricePerKwh ?? null,
      pricePerMinute: body.pricePerMinute ?? null,
      sessionFeeCents: body.sessionFeeCents ?? null,
      minChargeCents: body.minChargeCents ?? null,
      idleFeePerMinute: body.idleFeePerMinute ?? 0,
      idleGracePeriodSeconds: body.idleGracePeriodSeconds ?? 0,
      currency: body.currency ?? "BRL",
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    mockTariffs.push(tariff)
    return HttpResponse.json(tariff, { status: 201 })
  }),

  http.patch("/api/admin/tariffs/:id", async ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const tariff = scopedByOperator(mockTariffs, scope.user).find((t) => t.id === params.id)
    if (!tariff) return HttpResponse.json(errorBody("Tarifa não encontrada.", "NOT_FOUND"), { status: 404 })
    Object.assign(tariff, await request.json(), { updatedAt: new Date().toISOString() })
    return HttpResponse.json(tariff)
  }),

  http.delete("/api/admin/tariffs/:id", ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const tariff = scopedByOperator(mockTariffs, scope.user).find((t) => t.id === params.id)
    if (!tariff) return HttpResponse.json(errorBody("Tarifa não encontrada.", "NOT_FOUND"), { status: 404 })
    tariff.active = false
    return new HttpResponse(null, { status: 204 })
  }),

  // ---- Vínculos de tarifa (tariff-assignments) -----------------------------------
  // Espelha `backend/src/api/routes/tariffAssignments.routes.ts` + `schemas/tariffAssignment.schema.ts`:
  // lista com filtros (ordem priority desc, createdAt desc, join `tariff`); POST valida o campo certo por escopo (400 com `details`);
  // alvo/tarifa de outro operador = 404 (nunca 403); PATCH só reaponta tarifa/prioridade/validade; DELETE = soft (`validTo = agora`, 204).
  http.get("/api/admin/tariff-assignments", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const q = (key: string) => url.searchParams.get(key) || undefined
    const items = scopedByOperator(mockTariffAssignments, scope.user)
      .filter(
        (a) =>
          (!q("tariffId") || a.tariffId === q("tariffId")) &&
          (!q("siteId") || a.siteId === q("siteId")) &&
          (!q("chargePointId") || a.chargePointId === q("chargePointId")) &&
          (!q("connectorId") || a.connectorId === q("connectorId")) &&
          (!q("scope") || a.scope === q("scope")),
      )
      .sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt))
      .map(withTariffJoin)
    return HttpResponse.json(paginate(items, url))
  }),

  http.post("/api/admin/tariff-assignments", async ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const body = (await request.json()) as Partial<TariffAssignment> & { operatorId?: string }

    const details = validateAssignmentBody(body)
    if (details.length > 0) return HttpResponse.json({ error: "Dados inválidos.", code: "VALIDATION_ERROR", details }, { status: 400 })

    const operatorId = scope.user.role === "ADMIN" ? body.operatorId : scope.user.operatorId
    if (!operatorId) return HttpResponse.json(errorBody("operatorId é obrigatório neste corpo quando quem cria é ADMIN.", "VALIDATION_ERROR"), { status: 400 })

    if (!mockTariffs.some((t) => t.id === body.tariffId && t.operatorId === operatorId)) return HttpResponse.json(errorBody("Tarifa não encontrada.", "NOT_FOUND"), { status: 404 })
    if (body.scope === "SITE" && !mockSites.some((s) => s.id === body.siteId && s.operatorId === operatorId)) return HttpResponse.json(errorBody("Site não encontrado.", "NOT_FOUND"), { status: 404 })
    if (body.scope === "CHARGE_POINT" && !mockChargePoints.some((c) => c.id === body.chargePointId && c.operatorId === operatorId)) return HttpResponse.json(errorBody("Charge point não encontrado.", "NOT_FOUND"), { status: 404 })
    if (body.scope === "CONNECTOR" && !mockConnectors.some((c) => c.id === body.connectorId && c.operatorId === operatorId)) return HttpResponse.json(errorBody("Conector não encontrado.", "NOT_FOUND"), { status: 404 })

    const now = new Date().toISOString()
    const created: TariffAssignment = {
      id: `ta_${Date.now()}`,
      operatorId,
      tariffId: body.tariffId!,
      scope: body.scope!,
      siteId: body.scope === "SITE" ? (body.siteId ?? null) : null,
      chargePointId: body.scope === "CHARGE_POINT" ? (body.chargePointId ?? null) : null,
      connectorId: body.scope === "CONNECTOR" ? (body.connectorId ?? null) : null,
      priority: body.priority ?? 0,
      validFrom: body.validFrom ?? now,
      validTo: body.validTo ?? null,
      createdAt: now,
      updatedAt: now,
    }
    mockTariffAssignments.push(created)
    // O POST real devolve a linha SEM o join `tariff` (só GET lista/detalhe incluem).
    return HttpResponse.json(created, { status: 201 })
  }),

  http.patch("/api/admin/tariff-assignments/:id", async ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const existing = scopedByOperator(mockTariffAssignments, scope.user).find((a) => a.id === params.id)
    if (!existing) return HttpResponse.json(errorBody("Vínculo de tarifa não encontrado.", "NOT_FOUND"), { status: 404 })
    const body = (await request.json()) as { tariffId?: string; priority?: number; validFrom?: string; validTo?: string | null }
    const details = validateWindow(body.validFrom ?? undefined, body.validTo ?? undefined)
    if (details.length > 0) return HttpResponse.json({ error: "Dados inválidos.", code: "VALIDATION_ERROR", details }, { status: 400 })
    if (body.tariffId && !mockTariffs.some((t) => t.id === body.tariffId && t.operatorId === existing.operatorId)) return HttpResponse.json(errorBody("Tarifa não encontrada.", "NOT_FOUND"), { status: 404 })
    Object.assign(existing, body, { updatedAt: new Date().toISOString() })
    return HttpResponse.json(existing)
  }),

  http.delete("/api/admin/tariff-assignments/:id", ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const existing = scopedByOperator(mockTariffAssignments, scope.user).find((a) => a.id === params.id)
    if (!existing) return HttpResponse.json(errorBody("Vínculo de tarifa não encontrado.", "NOT_FOUND"), { status: 404 })
    existing.validTo = new Date().toISOString() // soft: expira a janela, não apaga a linha
    existing.updatedAt = existing.validTo
    return new HttpResponse(null, { status: 204 })
  }),

  // ---- Auth tokens admin (ADMIN only) ------------------------------------------
  http.get("/api/admin/auth-tokens", ({ request }) => {
    const user = currentUser(request)
    if (!user) return HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 })
    if (user.role !== "ADMIN") return HttpResponse.json(errorBody("Acesso negado.", "FORBIDDEN"), { status: 403 })
    const url = new URL(request.url)
    return HttpResponse.json(paginate(mockAuthTokens, url))
  }),

  http.post("/api/admin/auth-tokens", async ({ request }) => {
    const user = currentUser(request)
    if (!user) return HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 })
    if (user.role !== "ADMIN") return HttpResponse.json(errorBody("Acesso negado.", "FORBIDDEN"), { status: 403 })
    const body = (await request.json()) as Partial<AuthToken>
    const token: AuthToken = {
      id: `tok_${Date.now()}`,
      idTag: body.idTag ?? "",
      type: body.type ?? "RFID",
      status: "ACCEPTED",
      userId: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    mockAuthTokens.push(token)
    return HttpResponse.json(token, { status: 201 })
  }),

  http.patch("/api/admin/auth-tokens/:id", async ({ request, params }) => {
    const user = currentUser(request)
    if (!user) return HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 })
    if (user.role !== "ADMIN") return HttpResponse.json(errorBody("Acesso negado.", "FORBIDDEN"), { status: 403 })
    const token = mockAuthTokens.find((t) => t.id === params.id)
    if (!token) return HttpResponse.json(errorBody("Token não encontrado.", "NOT_FOUND"), { status: 404 })
    Object.assign(token, await request.json(), { updatedAt: new Date().toISOString() })
    return HttpResponse.json(token)
  }),

  http.delete("/api/admin/auth-tokens/:id", ({ request, params }) => {
    const user = currentUser(request)
    if (!user) return HttpResponse.json(errorBody("Não autenticado.", "UNAUTHORIZED"), { status: 401 })
    if (user.role !== "ADMIN") return HttpResponse.json(errorBody("Acesso negado.", "FORBIDDEN"), { status: 403 })
    const token = mockAuthTokens.find((t) => t.id === params.id)
    if (!token) return HttpResponse.json(errorBody("Token não encontrado.", "NOT_FOUND"), { status: 404 })
    token.status = "BLOCKED"
    return new HttpResponse(null, { status: 204 })
  }),

  // ---- Operadores (ADMIN only) -------------------------------------------------
  http.get("/api/admin/operators", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const items = listOperators()
    return HttpResponse.json({ items, meta: { page: 1, pageSize: items.length, total: items.length, totalPages: 1 } })
  }),

  // ---- Dashboard ----------------------------------------------------------------
  http.get("/api/admin/dashboard/summary", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const period = parsePeriod(url)
    return HttpResponse.json(buildDashboardSummary(toScope(scope.user), period))
  }),

  // Polling de 15s (ver `useDashboardLive`) — sem SSE nesta fase.
  http.get("/api/admin/dashboard/live", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    return HttpResponse.json(buildDashboardLive(toScope(scope.user), url.searchParams.get("operatorId") ?? undefined))
  }),

  // ---- Relatórios -----------------------------------------------------------------
  http.get("/api/admin/reports/daily-movement", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const period = parsePeriod(url)
    const pagination = parsePagination(url, 30)
    const format = url.searchParams.get("format")

    if (format === "csv") {
      const full = buildDailyMovement(toScope(scope.user), { ...period, page: 1, pageSize: 100000 })
      const csv = toCsv<DailyMovementRow>(full.items, [
        { key: "date", label: "Data" },
        { key: "siteName", label: "Eletroposto" },
        { key: "sessions", label: "Sessões" },
        { key: "energyWh", label: "Energia (Wh)" },
        { key: "revenueCents", label: "Faturamento (centavos)" },
        { key: "avgTicketCents", label: "Ticket médio (centavos)" },
      ])
      return csvResponse(csv, `movimento-diario_${period.from}_${period.to}.csv`)
    }

    return HttpResponse.json(buildDailyMovement(toScope(scope.user), { ...period, ...pagination }))
  }),

  http.get("/api/admin/reports/revenue", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const period = parsePeriod(url)
    const granularity = (url.searchParams.get("granularity") as RevenueGranularity | null) ?? "day"
    const breakdown = (url.searchParams.get("breakdown") as RevenueBreakdownDimension | null) ?? "site"
    const format = url.searchParams.get("format")

    const report = buildRevenueReport(toScope(scope.user), { ...period, granularity, breakdown })

    if (format === "csv") {
      const csv = toCsv<RevenueSeriesPoint>(report.series, [
        { key: "bucket", label: "Período" },
        { key: "revenueCents", label: "Faturamento (centavos)" },
        { key: "energyWh", label: "Energia (Wh)" },
        { key: "sessions", label: "Sessões" },
      ])
      return csvResponse(csv, `faturamento_${period.from}_${period.to}.csv`)
    }

    return HttpResponse.json(report)
  }),

  http.get("/api/admin/reports/sessions", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const period = parsePeriod(url)
    const pagination = parsePagination(url, 20)
    const format = url.searchParams.get("format")
    const filters = {
      status: url.searchParams.get("status") ?? undefined,
      paymentMethod: url.searchParams.get("paymentMethod") ?? undefined,
      minAmountCents: url.searchParams.get("minAmountCents") ? Number(url.searchParams.get("minAmountCents")) : undefined,
    }

    if (format === "csv") {
      const full = buildSessionsReport(toScope(scope.user), { ...period, ...filters, page: 1, pageSize: 100000 })
      const csv = toCsv<SessionListRow>(full.items, [
        { key: "ocppTransactionId", label: "Transação" },
        { key: "startedAt", label: "Início" },
        { key: "stoppedAt", label: "Fim" },
        { key: "siteName", label: "Eletroposto" },
        { key: "ocppIdentity", label: "Carregador" },
        { key: "connectorId", label: "Conector" },
        { key: "driverName", label: "Motorista" },
        { key: "status", label: "Status" },
        { key: "energyDeliveredWh", label: "Energia (Wh)" },
        { key: "totalCostCents", label: "Valor (centavos)" },
        { key: "paymentMethod", label: "Método" },
        { key: "paymentStatus", label: "Status do pagamento" },
      ])
      return csvResponse(csv, `sessoes_${period.from}_${period.to}.csv`)
    }

    return HttpResponse.json(buildSessionsReport(toScope(scope.user), { ...period, ...filters, ...pagination }))
  }),

  http.get("/api/admin/reports/sessions/:id", ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const detail = findSessionDetail(toScope(scope.user), String(params.id))
    if (!detail) return HttpResponse.json(errorBody("Sessão não encontrada.", "NOT_FOUND"), { status: 404 })
    return HttpResponse.json(detail)
  }),

  http.get("/api/admin/reports/payments", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const period = parsePeriod(url)
    const pagination = parsePagination(url, 20)
    const format = url.searchParams.get("format")
    const filters = {
      provider: url.searchParams.get("provider") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
    }
    // L1.8: achar a venda de um chargeback pelos identificadores da Cielo (igualdade exata). Só vendas de cartão têm esses dados.
    const acquirer = {
      tid: url.searchParams.get("tid") ?? undefined,
      authorizationCode: url.searchParams.get("authorizationCode") ?? undefined,
      proofOfSale: url.searchParams.get("proofOfSale") ?? undefined,
    }

    if (acquirer.tid || acquirer.authorizationCode || acquirer.proofOfSale) {
      const full = buildPaymentsReport(toScope(scope.user), { ...period, ...filters, page: 1, pageSize: 100000 })
      const matched = full.items.filter((row) => row.provider === "CIELO_CARD" && matchesAcquirer(row.id, acquirer))
      const start = (pagination.page - 1) * pagination.pageSize
      return HttpResponse.json({
        ...full,
        items: matched.slice(start, start + pagination.pageSize),
        meta: { page: pagination.page, pageSize: pagination.pageSize, total: matched.length, totalPages: Math.max(1, Math.ceil(matched.length / pagination.pageSize)) },
      })
    }

    if (format === "csv") {
      const full = buildPaymentsReport(toScope(scope.user), { ...period, ...filters, page: 1, pageSize: 100000 })
      const csv = toCsv<PaymentListRow>(full.items, [
        { key: "createdAt", label: "Data" },
        { key: "purpose", label: "Finalidade" },
        { key: "provider", label: "Provedor" },
        { key: "status", label: "Status" },
        { key: "amountRequestedCents", label: "Valor solicitado (centavos)" },
        { key: "amountCapturedCents", label: "Valor capturado (centavos)" },
        { key: "userName", label: "Usuário" },
        { key: "siteName", label: "Eletroposto" },
      ])
      return csvResponse(csv, `pagamentos_${period.from}_${period.to}.csv`)
    }

    return HttpResponse.json(buildPaymentsReport(toScope(scope.user), { ...period, ...filters, ...pagination }))
  }),

  // ---- Carteiras dos motoristas (Admin → Carteiras) -------------------------------
  // Espelho de `drivers.routes.ts`: OPERATOR precisa de `search` >= 3 chars (400
  // VALIDATION_ERROR) e NÃO recebe `email` (chave omitida, LGPD); o extrato é
  // OPERATOR+ADMIN; o POST de ajuste é ADMIN-only (403 FORBIDDEN), com teto de
  // R$ 5.000, descrição >= 5 chars e 409 INSUFFICIENT_BALANCE. Resposta da
  // listagem/extrato usa `{items,total,page,pageSize}` (não `meta`).
  http.get("/api/admin/drivers", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const isAdmin = scope.user.role === "ADMIN"
    const search = url.searchParams.get("search")?.trim() || undefined
    if (!isAdmin && (!search || search.length < 3)) {
      return HttpResponse.json(errorBody('Operadores precisam informar "search" com pelo menos 3 caracteres.', "VALIDATION_ERROR"), { status: 400 })
    }
    const { page, pageSize } = parsePagination(url, 20)
    return HttpResponse.json(listDrivers({ search, page, pageSize, isAdmin }))
  }),

  http.get("/api/admin/drivers/:id/wallet", ({ request, params }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const { page, pageSize } = parsePagination(new URL(request.url), 20)
    const wallet = getDriverWallet(String(params.id), page, pageSize)
    if (!wallet) return HttpResponse.json(errorBody("Motorista não encontrado.", "NOT_FOUND"), { status: 404 })
    return HttpResponse.json(wallet)
  }),

  http.post("/api/admin/drivers/:id/wallet/entries", async ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const body = (await request.json().catch(() => ({}))) as { amountCents?: unknown; description?: unknown }
    const amountCents = body.amountCents
    const description = typeof body.description === "string" ? body.description.trim() : ""
    if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents === 0 || Math.abs(amountCents) > 500_000) {
      return HttpResponse.json(errorBody("amountCents inválido: inteiro, diferente de zero, no máximo 500000 em módulo.", "VALIDATION_ERROR"), { status: 400 })
    }
    if (description.length < 5 || description.length > 500) {
      return HttpResponse.json(errorBody("description precisa ter entre 5 e 500 caracteres.", "VALIDATION_ERROR"), { status: 400 })
    }
    const result = adjustDriverWallet(String(params.id), amountCents, description)
    if (!result.ok) {
      return result.code === "NOT_FOUND"
        ? HttpResponse.json(errorBody("Motorista não encontrado.", "NOT_FOUND"), { status: 404 })
        : HttpResponse.json(errorBody("Saldo insuficiente para este débito.", "INSUFFICIENT_BALANCE"), { status: 409 })
    }
    return HttpResponse.json(result.entry, { status: 201 })
  }),

  // ---- Gateway de pagamento / Cielo (ADMIN only, F5.5) -------------------------------
  // Espelho do bloco "F5.5" de `types/api.ts` (regras e cenários em `paymentGatewayData.ts`).
  // Segredos NUNCA são devolvidos; o corpo do PUT não é logado em lugar nenhum.
  http.get("/api/admin/payment-gateway", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const result = getGatewayConfig(scope.user.userId)
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code }, { status: result.status })
    return HttpResponse.json(result.dto)
  }),

  http.put("/api/admin/payment-gateway", async ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const body = await request.json().catch(() => null)
    const result = updateGatewayConfig(scope.user.userId, body)
    if (!result.ok) {
      return HttpResponse.json({ error: result.message, code: result.code, ...(result.details ? { details: result.details } : {}) }, { status: result.status })
    }
    return HttpResponse.json(result.dto)
  }),

  // C2.1 - sem corpo, ADMIN-only, SEM step-up (só lê). `localStorage["mock:gateway-test"]` escolhe o cenário (ver `testGatewayConnection`).
  http.post("/api/admin/payment-gateway/test-connection", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const outcome = testGatewayConnection(scope.user.userId, localStorage.getItem("mock:gateway-test"))
    return HttpResponse.json(outcome.body, { status: outcome.status })
  }),

  // ---- Comunicação / avisos ao dono: e-mail SMTP + WhatsApp Evolution (ADMIN only, N-7) ----------------
  // Espelho de `docs/CONTRATO-COMUNICACAO-ADMIN.md` (regras, personas e gatilhos em `communicationData.ts`). Segredos NUNCA são devolvidos nem guardados.
  http.get("/api/admin/communication-settings", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const result = getCommunicationSettings(scope.user.userId)
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code }, { status: result.status })
    return HttpResponse.json(result.dto)
  }),

  http.put("/api/admin/communication-settings", async ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const body = await request.json().catch(() => null)
    const result = updateCommunicationSettings(scope.user.userId, body)
    if (!result.ok) {
      return HttpResponse.json({ error: result.message, code: result.code, ...(result.details ? { details: result.details } : {}) }, { status: result.status, headers: result.headers })
    }
    return HttpResponse.json(result.dto)
  }),

  // Testes: SEM step-up (só enviam uma mensagem); `localStorage["mock:comunicacao-teste"]` escolhe o resultado (ver `testCommunicationChannel`).
  http.post("/api/admin/communication-settings/test-email", async ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const body = await request.json().catch(() => ({}))
    const outcome = testCommunicationChannel(scope.user.userId, "email", body, localStorage.getItem("mock:comunicacao-teste"))
    return HttpResponse.json(outcome.body, { status: outcome.status, ...("headers" in outcome && outcome.headers ? { headers: outcome.headers } : {}) })
  }),

  http.post("/api/admin/communication-settings/test-whatsapp", async ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const body = await request.json().catch(() => ({}))
    const outcome = testCommunicationChannel(scope.user.userId, "whatsapp", body, localStorage.getItem("mock:comunicacao-teste"))
    return HttpResponse.json(outcome.body, { status: outcome.status, ...("headers" in outcome && outcome.headers ? { headers: outcome.headers } : {}) })
  }),

  // ---- Estorno, chargeback e devolução de conta excluída (ADMIN only, L1.8 / L1.4) -----------------
  // Espelho de `paymentReversals.routes.ts`, `chargebacks.routes.ts` e `adminAccountDeletions.routes.ts` (regras, dados de demo e gatilhos em `reversalsData.ts`).
  // Escritas com step-up de senha; mensagens do cliente sempre por `code`. O corpo (senha, motivo) nunca é logado.
  http.get("/api/admin/sessions/:id/refunds", ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(getSessionRefunds(String(params.id)))
  }),

  http.post("/api/admin/sessions/:id/refunds", async ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(createSessionRefund(String(params.id), await request.json().catch(() => null)))
  }),

  http.post("/api/admin/refunds/:id/cancel", async ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(cancelRefund(String(params.id), await request.json().catch(() => null)))
  }),

  http.post("/api/admin/refunds/:id/confirm", async ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(confirmRefund(String(params.id), await request.json().catch(() => null)))
  }),

  http.post("/api/admin/payments/:intentId/chargebacks", async ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const intentId = String(params.intentId)
    return mockResult(registerChargeback(intentId, await request.json().catch(() => null), findMockPayment(intentId)))
  }),

  http.get("/api/admin/chargebacks", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(listChargebacks(new URL(request.url)))
  }),

  // O dossiê vem ANTES de `/:id`: o MSW usa a primeira rota que casa.
  http.get("/api/admin/chargebacks/:id/dossier", ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(getDossier(String(params.id)))
  }),

  http.get("/api/admin/chargebacks/:id", ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(getChargeback(String(params.id)))
  }),

  http.patch("/api/admin/chargebacks/:id", async ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(resolveChargeback(String(params.id), await request.json().catch(() => null)))
  }),

  http.post("/api/admin/chargebacks/:id/unblock-card", async ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(unblockCard(String(params.id), await request.json().catch(() => null)))
  }),

  http.get("/api/admin/account-deletions", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const result = listAccountDeletions(new URL(request.url))
    const response = mockResult(result)
    // A resposta traz chave Pix de titular: nunca em cache (igual ao servidor real).
    response.headers.set("Cache-Control", "no-store")
    return response
  }),

  http.post("/api/admin/account-deletions/:id/refund", async ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    return mockResult(refundAccountDeletion(String(params.id), await request.json().catch(() => null), scope.user.userId))
  }),

  // ---- Backup automático do banco (ADMIN only) ------------------------------------------------------
  // Espelho de `docs/CONTRATO-BACKUP-ADMIN.md` (regras, personas e gatilhos em `backupData.ts`). Segredos e a chave do backup NUNCA são guardados nem devolvidos (a chave só em `POST /key`).
  http.get("/api/admin/backup/config", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const result = getBackupConfig(scope.user)
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code }, { status: result.status })
    return HttpResponse.json(result.dto)
  }),

  http.put("/api/admin/backup/config", async ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const body = await request.json().catch(() => null)
    const result = updateBackupConfig(scope.user, body)
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code, ...(result.details ? { details: result.details } : {}) }, { status: result.status, headers: result.headers })
    return HttpResponse.json(result.dto)
  }),

  http.get("/api/admin/backup/status", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const result = getBackupStatus(scope.user, localStorage.getItem("mock:backup-estado"))
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code }, { status: result.status })
    return HttpResponse.json(result.dto)
  }),

  http.post("/api/admin/backup/key", async ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const body = await request.json().catch(() => null)
    const result = generateBackupKey(scope.user, body)
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code, ...(result.details ? { details: result.details } : {}) }, { status: result.status, headers: result.headers })
    return HttpResponse.json(result.dto, { status: 201, headers: { "Cache-Control": "no-store" } })
  }),

  // `localStorage["mock:backup-execucao"]` escolhe como o backup/conferência TERMINA (código de falha ou `ok`); `mock:backup-fila` = `off` derruba a fila (ver `backupData.ts`).
  http.post("/api/admin/backup/run", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const result = runBackupNow(scope.user, { executionTrigger: localStorage.getItem("mock:backup-execucao"), queueTrigger: localStorage.getItem("mock:backup-fila") })
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code }, { status: result.status, headers: result.headers })
    return HttpResponse.json(result.dto, { status: 202 })
  }),

  http.post("/api/admin/backup/verify", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const result = verifyBackup(scope.user, { executionTrigger: localStorage.getItem("mock:backup-execucao"), queueTrigger: localStorage.getItem("mock:backup-fila") })
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code }, { status: result.status, headers: result.headers })
    return HttpResponse.json(result.dto, { status: 202 })
  }),

  http.post("/api/admin/backup/test-destination", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const result = testBackupDestination(scope.user, localStorage.getItem("mock:backup-teste"))
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code }, { status: result.status, headers: result.headers })
    return HttpResponse.json(result.dto)
  }),

  http.get("/api/admin/backup/runs", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const result = listBackupRuns(scope.user, {
      page: Number(url.searchParams.get("page") ?? 1),
      pageSize: Number(url.searchParams.get("pageSize") ?? 20),
      trigger: url.searchParams.get("trigger") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
    })
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code }, { status: result.status })
    return HttpResponse.json(result.dto)
  }),

  http.get("/api/admin/backup/runs/:id", ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const result = getBackupRun(scope.user, String(params.id))
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code }, { status: result.status })
    return HttpResponse.json(result.dto)
  }),

  http.post("/api/admin/backup/google/start", async ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const body = await request.json().catch(() => null)
    const result = startGoogle(scope.user, body)
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code, ...(result.details ? { details: result.details } : {}) }, { status: result.status, headers: result.headers })
    return HttpResponse.json(result.dto)
  }),

  http.post("/api/admin/backup/google/disconnect", async ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const body = await request.json().catch(() => null)
    const result = disconnectGoogle(scope.user, body)
    if (!result.ok) return HttpResponse.json({ error: result.message, code: result.code, ...(result.details ? { details: result.details } : {}) }, { status: result.status, headers: result.headers })
    return HttpResponse.json(result.dto)
  }),

  // ---- Auditoria (ADMIN only) ---------------------------------------------------
  // Contrato/decisões: `.claude/agent-memory/nova/decisoes-audit-log.md`.
  // "Ver o log não gera log" — nenhum handler abaixo grava nada em
  // `mockAuditLogItems`, só lê (exceto `format=csv`, que É auditado de
  // verdade no backend real — aqui não simulamos essa auto-referência).
  http.get("/api/admin/audit-logs", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const period = parsePeriod(url)
    const format = url.searchParams.get("format")
    const filters = {
      from: period.from,
      to: period.to,
      actorUserId: url.searchParams.get("actorUserId") ?? undefined,
      actorRole: (url.searchParams.get("actorRole") as Role | null) ?? undefined,
      action: (url.searchParams.get("action") as AuditLogListItem["action"] | null) ?? undefined,
      outcome: (url.searchParams.get("outcome") as AuditLogListItem["outcome"] | null) ?? undefined,
      entityType: url.searchParams.get("entityType") ?? undefined,
      entityId: url.searchParams.get("entityId") ?? undefined,
      operatorId: url.searchParams.get("operatorId") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    }
    const items = filterAuditLogs(filters)

    if (format === "csv") {
      const csv = toCsv<AuditLogListItem>(items, [
        { key: "occurredAt", label: "Quando" },
        { key: "action", label: "Ação" },
        { key: "outcome", label: "Resultado" },
        { key: "entityType", label: "Entidade" },
        { key: "entityId", label: "ID da entidade" },
        { key: "method", label: "Método" },
        { key: "path", label: "Rota" },
        { key: "httpStatus", label: "HTTP" },
        { key: "ipAddress", label: "IP" },
      ])
      return csvResponse(csv, `auditoria_${period.from}_${period.to}.csv`)
    }

    return HttpResponse.json(paginate(items, url))
  }),

  http.get("/api/admin/audit-logs/actors", ({ request }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const period = parsePeriod(url)
    return HttpResponse.json({ items: listAuditLogActors(period.from, period.to) })
  }),

  http.get("/api/admin/audit-logs/:id", ({ request, params }) => {
    const scope = requireAdmin(request)
    if ("error" in scope) return scope.error
    const detail = mockAuditLogDetails.get(String(params.id))
    if (!detail) return HttpResponse.json(errorBody("Registro de auditoria não encontrado.", "NOT_FOUND"), { status: 404 })
    return HttpResponse.json(detail)
  }),

  // ---- Tempo real (SSE) -------------------------------------------------------
  // Ver `decisoes-tempo-real-sse.md` (Nova) — cliente real fala `fetch` +
  // `ReadableStream` com `Authorization: Bearer`, nunca JWT na querystring.
  // O stream sintético (`mocks/realtimeStream.ts`) prova a integração inteira
  // (parsing + reconexão + invalidação de query) sem o backend do Vega.
  http.get("/api/admin/events", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    return new HttpResponse(createAdminEventStream(), { headers: SSE_RESPONSE_HEADERS })
  }),

  http.get("/api/me/events", ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    return new HttpResponse(createMeEventStream(scope.user.userId), { headers: SSE_RESPONSE_HEADERS })
  }),

  // ---- PWA do motorista: charge point público + rotas /api/me/* ---------------
  // Ver `mocks/meData.ts` — simulação com atraso realista (não resolve tudo
  // no mesmo tick), pra provar a máquina de estados "conectando → carregando
  // → parando → recibo" de verdade no navegador.

  http.get("/api/public/charge-points/:ocppIdentity", ({ params }) => {
    const card = getPublicChargePointCard(String(params.ocppIdentity))
    if (!card) return HttpResponse.json(errorBody("Carregador não encontrado.", "CHARGE_POINT_NOT_FOUND"), { status: 404 })
    return HttpResponse.json(card)
  }),

  http.post("/api/me/sessions/start", async ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const body = (await request.json()) as {
      ocppIdentity: string
      connectorId: number
      payment?: { mode: "WALLET" } | { mode: "CARD"; paymentMethodId: string }
    }
    // I-7: só o pagamento com CARTÃO é recusado; carteira segue normal para a mesma conta.
    if (body.payment?.mode === "CARD") {
      const refusal = cardRefusalFor(scope.user.userId, localStorage.getItem("mock:card-refusal"))
      if (refusal) return HttpResponse.json(refusal.body, { status: refusal.status, headers: refusal.headers })
    }
    if (body.payment?.mode === "CARD" && isGatewayDisabledFor(scope.user.userId)) {
      return HttpResponse.json(gatewayDisabledBody(scope.user.userId, "CARD"), { status: 409 })
    }
    const result = startMockSession(scope.user.userId, body.ocppIdentity, body.connectorId, body.payment)
    if (!result.ok) {
      const status = result.code === "ALREADY_HAS_ACTIVE_SESSION" ? 409 : result.code === "PAYMENT_METHOD_NOT_FOUND" ? 404 : 422
      return HttpResponse.json(errorBody(result.message, result.code), { status })
    }
    return HttpResponse.json(
      {
        correlationId: result.correlationId,
        status: "PENDING",
        paymentMode: result.paymentMode,
        walletBalanceCents: result.walletBalanceCents,
        estimatedMaxCostCents: result.estimatedMaxCostCents,
        authorizedCents: result.authorizedCents,
        minChargeCents: result.minChargeCents,
      },
      { status: 202 },
    )
  }),

  http.get("/api/me/sessions/active", ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const session = getMockActiveSession(scope.user.userId)
    const wallet = getMockWallet(scope.user.userId, 1, 0)
    return HttpResponse.json({ session, walletBalanceCents: wallet.balanceCents, generatedAt: new Date().toISOString() })
  }),

  http.get("/api/me/sessions/:id", ({ request, params }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const detail = getMockSessionDetail(scope.user.userId, String(params.id))
    if (!detail) return HttpResponse.json(errorBody("Sessão não encontrada.", "SESSION_NOT_FOUND"), { status: 404 })
    return HttpResponse.json(detail)
  }),

  http.get("/api/me/sessions", ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    // Só para o E2E do estado de erro de tela inteira do PWA (`ErrorState tone="page"`).
    if (localStorage.getItem("mock:me-sessions-error") === "1") return HttpResponse.json(errorBody("Falha simulada.", "INTERNAL_ERROR"), { status: 500 })
    const url = new URL(request.url)
    const { page, pageSize } = parsePagination(url, 15)
    return HttpResponse.json(listMockSessions(scope.user.userId, page, pageSize))
  }),

  http.post("/api/me/sessions/:id/stop", ({ request, params }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const result = stopMockSession(scope.user.userId, String(params.id))
    if (!result.ok) return HttpResponse.json(errorBody(result.message, result.code), { status: 404 })
    return HttpResponse.json({ correlationId: result.correlationId, status: "PENDING" }, { status: 202 })
  }),

  http.get("/api/me/commands/:correlationId", ({ request, params }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    return HttpResponse.json({ status: getCommandStatus(String(params.correlationId)) })
  }),

  http.get("/api/me/wallet", ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const { page, pageSize } = parsePagination(url, 20)
    return HttpResponse.json(getMockWallet(scope.user.userId, page, pageSize))
  }),

  // ---- Recarga de saldo via Pix (F5.1) -----------------------------------------
  // A rota real ainda NÃO existe no backend (ver `.claude/agent-memory/nova/
  // decisoes-f5-pagamento-cielo.md`) — `mocks/meData.ts` simula com atraso
  // realista (8s) pra provar o estado "PENDING" (QR/copia-e-cola) antes de
  // `PAID`, mesmo espírito dos comandos OCPP fire-and-forget acima.
  http.post("/api/me/wallet/topups", async ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const body = (await request.json().catch(() => ({}))) as { amountCents?: unknown; cpf?: unknown }
    if (isGatewayDisabledFor(scope.user.userId)) return HttpResponse.json(gatewayDisabledBody(scope.user.userId, "PIX"), { status: 409 })
    const result = await createMockTopup(scope.user.userId, body.amountCents)
    if (!result.ok) {
      const status = result.code === "TOO_MANY_PENDING_TOPUPS" ? 409 : 400
      return HttpResponse.json(errorBody(result.message, result.code), { status })
    }
    return HttpResponse.json(result.topup, { status: 201 })
  }),

  http.get("/api/me/wallet/topups/:id", ({ request, params }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const topup = getMockTopup(String(params.id))
    if (!topup) return HttpResponse.json(errorBody("Recarga não encontrada.", "TOPUP_NOT_FOUND"), { status: 404 })
    return HttpResponse.json(topup)
  }),

  // ---- Cartão salvo (F5.3) — contrato espelhado de `backend/src/api/routes/mePaymentMethods.routes.ts` (Vega) ----

  http.get("/api/me/payment-methods", ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    return HttpResponse.json({ items: listMockPaymentMethods(scope.user.userId), cardEligibility: cardEligibilityFor(scope.user.userId) })
  }),

  http.post("/api/me/payment-methods/tokenization-session", ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const refusal = cardRefusalFor(scope.user.userId, localStorage.getItem("mock:card-refusal"))
    if (refusal) return HttpResponse.json(refusal.body, { status: refusal.status, headers: refusal.headers })
    if (isGatewayDisabledFor(scope.user.userId)) return HttpResponse.json(gatewayDisabledBody(scope.user.userId, "CARD"), { status: 409 })
    return HttpResponse.json(createMockTokenizationSession(scope.user.userId))
  }),

  http.post("/api/me/payment-methods", async ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const body = (await request.json().catch(() => ({}))) as {
      cardToken?: unknown
      brand?: unknown
      makeDefault?: unknown
      last4?: unknown
      expiryMonth?: unknown
      expiryYear?: unknown
    }
    const refusal = cardRefusalFor(scope.user.userId, localStorage.getItem("mock:card-refusal"))
    if (refusal) return HttpResponse.json(refusal.body, { status: refusal.status, headers: refusal.headers })
    if (isGatewayDisabledFor(scope.user.userId)) return HttpResponse.json(gatewayDisabledBody(scope.user.userId, "CARD"), { status: 409 })
    const result = createMockPaymentMethod(scope.user.userId, body.cardToken, body.brand, body.makeDefault === true, body)
    if (!result.ok) {
      const status = result.code === "TOO_MANY_PAYMENT_METHODS" ? 409 : 400
      return HttpResponse.json(errorBody(result.message, result.code), { status })
    }
    return HttpResponse.json(result.method, { status: 201 })
  }),

  // Contrato literal (Vega, `meUpdatePaymentMethodSchema`): só aceita `{ isDefault: true }`.
  http.patch("/api/me/payment-methods/:id", ({ request, params }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const result = setDefaultMockPaymentMethod(scope.user.userId, String(params.id))
    if (!result.ok) return HttpResponse.json(errorBody("Cartão não encontrado.", "PAYMENT_METHOD_NOT_FOUND"), { status: 404 })
    return HttpResponse.json(result.method)
  }),

  http.delete("/api/me/payment-methods/:id", ({ request, params }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const removed = removeMockPaymentMethod(scope.user.userId, String(params.id))
    if (!removed) return HttpResponse.json(errorBody("Cartão não encontrado.", "PAYMENT_METHOD_NOT_FOUND"), { status: 404 })
    return new HttpResponse(null, { status: 204 })
  }),
]
