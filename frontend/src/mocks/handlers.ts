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
import type { AuthToken, ChargePoint, Connector, PaginatedResponse, Role, Site, Tariff } from "@/types/api"

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
  return { id: user.id, name: user.name, email: user.email, role: user.role, operatorId: user.operatorId }
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
      password: body.password,
    }
    mockUsers.push(newUser)
    return HttpResponse.json({ token: fakeToken(newUser), user: toUserDTO(newUser) }, { status: 201 })
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
]
