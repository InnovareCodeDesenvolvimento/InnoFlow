import { http, HttpResponse } from "msw"
import {
  mockAuthTokens,
  mockChargePoints,
  mockConnectors,
  mockSites,
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
  getCommandStatus,
  getMockActiveSession,
  getMockSessionDetail,
  getMockWallet,
  getPublicChargePointCard,
  listMockSessions,
  startMockSession,
  stopMockSession,
} from "./meData"
import { filterAuditLogs, listAuditLogActors, mockAuditLogDetails } from "./auditLogData"
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

function fakeToken(user: MockUser) {
  return btoa(JSON.stringify({ userId: user.id, role: user.role, operatorId: user.operatorId }))
}

function currentUser(req: Request): { userId: string; role: Role; operatorId: string | null } | null {
  const token = AUTH_HEADER(req)
  if (!token) return null
  try {
    return JSON.parse(atob(token))
  } catch {
    return null
  }
}

function errorBody(error: string, code: string) {
  return { error, code }
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

export const handlers = [
  // ---- Auth -----------------------------------------------------------------
  http.post("/api/auth/login", async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string }
    const user = mockUsers.find((u) => u.email === body.email)
    if (!user || user.password !== body.password) {
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
  // Config controlável por localStorage (os handlers rodam na página, não no
  // service worker): `mock:google-disabled=1` → `googleClientId: null`, pra
  // provar a tela SEM o botão (usado no E2E e na validação visual).
  http.get("/api/public/config", () => {
    const disabled = localStorage.getItem("mock:google-disabled") === "1"
    return HttpResponse.json({ googleClientId: disabled ? null : "mock-client-id.apps.googleusercontent.com" })
  }),

  http.post("/api/auth/google", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { credential?: string }
    const credential = body.credential?.trim() ?? ""
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
    const driver = mockUsers.find((u) => u.role === "DRIVER" && u.id === "user_driver")
    if (!driver) return HttpResponse.json(errorBody("Token do Google inválido.", "INVALID_GOOGLE_TOKEN"), { status: 401 })
    return HttpResponse.json({ token: fakeToken(driver), user: toUserDTO(driver) })
  }),

  // ---- Sites públicos ---------------------------------------------------------
  http.get("/api/sites", ({ request }) => {
    const url = new URL(request.url)
    const publicSites = mockSites
      .filter((s) => s.active)
      .map((s) => ({
        id: s.id,
        name: s.name,
        addressLine: s.addressLine,
        city: s.city,
        state: s.state,
        latitude: s.latitude,
        longitude: s.longitude,
        chargePoints: mockChargePoints
          .filter((cp) => cp.siteId === s.id && cp.active)
          .map((cp) => ({
            id: cp.id,
            vendor: cp.vendor,
            model: cp.model,
            connectors: mockConnectors.filter((c) => c.chargePointId === cp.id),
          })),
      }))
    return HttpResponse.json(paginate(publicSites, url))
  }),

  // ---- Sites admin -------------------------------------------------------------
  http.get("/api/admin/sites", ({ request }) => {
    const scope = requireStaff(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
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
    const body = (await request.json()) as Partial<ChargePoint> & { siteId: string }
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
    const body = (await request.json()) as { ocppIdentity: string; connectorId: number }
    const result = startMockSession(scope.user.userId, body.ocppIdentity, body.connectorId)
    if (!result.ok) return HttpResponse.json(errorBody(result.message, result.code), { status: result.code === "ALREADY_HAS_ACTIVE_SESSION" ? 409 : 422 })
    return HttpResponse.json(
      {
        correlationId: result.correlationId,
        status: "PENDING",
        walletBalanceCents: result.walletBalanceCents,
        estimatedMaxCostCents: result.estimatedMaxCostCents,
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
    const detail = getMockSessionDetail(String(params.id))
    if (!detail) return HttpResponse.json(errorBody("Sessão não encontrada.", "SESSION_NOT_FOUND"), { status: 404 })
    return HttpResponse.json(detail)
  }),

  http.get("/api/me/sessions", ({ request }) => {
    const scope = requireDriver(request)
    if ("error" in scope) return scope.error
    const url = new URL(request.url)
    const { page, pageSize } = parsePagination(url, 15)
    return HttpResponse.json(listMockSessions(page, pageSize))
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
]
