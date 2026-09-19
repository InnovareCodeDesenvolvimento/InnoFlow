/**
 * Tipos do contrato da API, espelhando os schemas Zod do backend
 * (`backend/src/api/schemas/*.ts`) e o envelope de resposta padrão.
 *
 * Não inventamos formato: cada tipo aqui tem uma rota real por trás (ver
 * `backend/src/api/routes/*.ts`). Onde o backend não define um contrato
 * (ex.: sessão de recarga, pagamento), não existe tipo aqui — a tela
 * correspondente também não existe ainda (F4/F5).
 */

export type Role = "ADMIN" | "OPERATOR" | "DRIVER"

export interface User {
  id: string
  name: string
  email: string
  role: Role
  operatorId: string | null
  /** Nome do operador (empresa) dono do usuário — `null` para `ADMIN`/`DRIVER`, que não pertencem a um único operador. Join feito pelo backend em `/api/auth/login`. */
  operatorName: string | null
}

export interface AuthResponse {
  token: string
  user: User
}

/**
 * `GET /api/public/config` (sem auth) — configuração pública que o cliente
 * precisa para montar a tela de login. `googleClientId` é PÚBLICO por
 * desenho (Google exige que ele apareça no front); `null` = login com Google
 * não configurado neste ambiente → o botão simplesmente NÃO é renderizado.
 */
export interface PublicClientConfig {
  googleClientId: string | null
}

/**
 * `POST /api/auth/google` (sem auth) — `credential` é o ID token (JWT) que o
 * Google Identity Services entrega no callback do botão. Resposta: `AuthResponse`
 * (mesmo formato de login/registro) — 201 se criou conta nova de motorista,
 * 200 se entrou numa conta existente (ou vinculou o Google a uma conta de
 * motorista já cadastrada com o mesmo e-mail verificado). Só `DRIVER`: e-mail
 * que pertence a ADMIN/OPERATOR responde 403 `GOOGLE_LOGIN_NOT_ALLOWED`.
 * Códigos de erro: `GOOGLE_NOT_CONFIGURED` (503), `INVALID_GOOGLE_TOKEN` (401),
 * `GOOGLE_EMAIL_NOT_VERIFIED` (403), `GOOGLE_LOGIN_NOT_ALLOWED` (403).
 */
export interface GoogleAuthRequest {
  credential: string
}

/** Envelope de erro da API: `{ error, code, details? }` — sempre trate por `code`. */
export interface ApiErrorBody {
  error: string
  code: string
  details?: Array<{ path?: string; message?: string } & Record<string, unknown>>
}

export interface PaginationMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface PaginatedResponse<T> {
  items: T[]
  meta: PaginationMeta
}

export interface PaginationParams {
  page?: number
  pageSize?: number
}

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

export interface Site {
  id: string
  operatorId: string
  name: string
  addressLine: string
  city: string
  state: string
  postalCode: string
  country: string
  latitude: number
  longitude: number
  timezone: string
  openingHours: Record<string, string> | null
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateSiteInput {
  operatorId?: string
  name: string
  addressLine: string
  city: string
  state: string
  postalCode: string
  country?: string
  latitude: number
  longitude: number
  timezone?: string
}

export type UpdateSiteInput = Partial<Omit<CreateSiteInput, "operatorId">> & { active?: boolean }

// ---------------------------------------------------------------------------
// ChargePoint
// ---------------------------------------------------------------------------

export interface ChargePoint {
  id: string
  operatorId: string
  siteId: string
  ocppIdentity: string
  vendor: string | null
  model: string | null
  serialNumber: string | null
  firmwareVersion: string | null
  active: boolean
  createdAt: string
  updatedAt: string
  connectors?: Connector[]
  site?: { id: string; name: string }
}

export interface CreateChargePointInput {
  siteId: string
  ocppIdentity: string
  vendor?: string
  model?: string
  serialNumber?: string
  firmwareVersion?: string
  basicAuthSecret: string
}

export type UpdateChargePointInput = Partial<
  Omit<CreateChargePointInput, "siteId" | "ocppIdentity" | "basicAuthSecret">
> & { active?: boolean; basicAuthSecret?: string }

export type ChargePointCommandType = "reset" | "unlock" | "change-availability" | "trigger-message"

export interface CommandDispatchResult {
  correlationId: string
  status: "PENDING"
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const CONNECTOR_TYPES = ["AC_TYPE2", "DC_CCS2", "DC_CHADEMO"] as const
export type ConnectorType = (typeof CONNECTOR_TYPES)[number]

export const CONNECTOR_STATUSES = [
  "AVAILABLE",
  "PREPARING",
  "CHARGING",
  "SUSPENDED_EVSE",
  "SUSPENDED_EV",
  "FINISHING",
  "RESERVED",
  "UNAVAILABLE",
  "FAULTED",
] as const
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number]

export interface Connector {
  id: string
  operatorId: string
  chargePointId: string
  connectorId: number
  type: ConnectorType
  status: ConnectorStatus
  maxPowerKw: string | number | null
  createdAt: string
  updatedAt: string
}

export interface CreateConnectorInput {
  chargePointId: string
  connectorId: number
  type: ConnectorType
  maxPowerKw?: number
}

export interface UpdateConnectorInput {
  type?: ConnectorType
  maxPowerKw?: number
  status?: ConnectorStatus
}

// ---------------------------------------------------------------------------
// Tariff
// ---------------------------------------------------------------------------

export const TARIFF_MODELS = ["PER_KWH", "PER_MINUTE", "PER_SESSION", "HYBRID"] as const
export type TariffModel = (typeof TARIFF_MODELS)[number]

export interface Tariff {
  id: string
  operatorId: string
  name: string
  model: TariffModel
  /** Reais por kWh — Decimal serializado como string. */
  pricePerKwh: string | number | null
  /** Reais por minuto — Decimal serializado como string. */
  pricePerMinute: string | number | null
  sessionFeeCents: number | null
  minChargeCents: number | null
  /** Centavos por minuto de ociosidade. */
  idleFeePerMinute: number
  idleGracePeriodSeconds: number
  currency: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateTariffInput {
  operatorId?: string
  name: string
  model: TariffModel
  pricePerKwh?: number
  pricePerMinute?: number
  sessionFeeCents?: number
  minChargeCents?: number
  idleFeePerMinute?: number
  idleGracePeriodSeconds?: number
  currency?: string
}

export type UpdateTariffInput = Partial<Omit<CreateTariffInput, "operatorId">> & { active?: boolean }

// ---------------------------------------------------------------------------
// TariffAssignment — vincula uma Tariff a um site/charge point/conector (ou
// ao operador inteiro). `resolveActiveTariff` (backend, ocpp/tariffResolution.ts)
// desempata por priority > especificidade do scope (CONNECTOR > CHARGE_POINT
// > SITE > OPERATOR) > createdAt mais recente.
// ---------------------------------------------------------------------------

export const TARIFF_ASSIGNMENT_SCOPES = ["CONNECTOR", "CHARGE_POINT", "SITE", "OPERATOR"] as const
export type TariffAssignmentScope = (typeof TARIFF_ASSIGNMENT_SCOPES)[number]

export interface TariffAssignment {
  id: string
  operatorId: string
  tariffId: string
  scope: TariffAssignmentScope
  connectorId: string | null
  chargePointId: string | null
  siteId: string | null
  priority: number
  validFrom: string
  validTo: string | null
  createdAt: string
  updatedAt: string
  /** Presente na listagem/detalhe — join leve, só o essencial para exibir. */
  tariff?: Pick<Tariff, "id" | "name" | "model">
}

/**
 * `scope` dita qual dos três campos abaixo é obrigatório — os outros dois
 * têm que ficar ausentes (validado pelo backend via Zod `superRefine`):
 * CONNECTOR -> `connectorId`, CHARGE_POINT -> `chargePointId`,
 * SITE -> `siteId`, OPERATOR -> nenhum.
 */
export interface CreateTariffAssignmentInput {
  operatorId?: string
  tariffId: string
  scope: TariffAssignmentScope
  connectorId?: string
  chargePointId?: string
  siteId?: string
  priority?: number
  validFrom?: string
  validTo?: string
}

/** `scope`/`connectorId`/`chargePointId`/`siteId` são imutáveis após criados — só reapontar a tarifa, reordenar prioridade ou ajustar a janela de validade. */
export interface UpdateTariffAssignmentInput {
  tariffId?: string
  priority?: number
  validFrom?: string
  validTo?: string | null
}

// ---------------------------------------------------------------------------
// AuthToken (RFID/app) — só ADMIN, ver authTokens.routes.ts
// ---------------------------------------------------------------------------

export const AUTH_TOKEN_TYPES = ["RFID", "VIRTUAL", "APP"] as const
export type AuthTokenType = (typeof AUTH_TOKEN_TYPES)[number]

export const AUTH_TOKEN_STATUSES = ["ACCEPTED", "BLOCKED", "EXPIRED", "INVALID"] as const
export type AuthTokenStatus = (typeof AUTH_TOKEN_STATUSES)[number]

export interface AuthToken {
  id: string
  idTag: string
  type: AuthTokenType
  status: AuthTokenStatus
  userId: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateAuthTokenInput {
  idTag: string
  type: AuthTokenType
  userId?: string
  expiresAt?: string
}

export interface UpdateAuthTokenInput {
  status?: AuthTokenStatus
  expiresAt?: string | null
}

// ---------------------------------------------------------------------------
// Sites públicos (GET /api/sites — sem auth, app do motorista)
// ---------------------------------------------------------------------------

export interface PublicConnector {
  id: string
  connectorId: number
  type: ConnectorType
  status: ConnectorStatus
  maxPowerKw: string | number | null
}

export interface PublicChargePoint {
  id: string
  vendor: string | null
  model: string | null
  connectors: PublicConnector[]
}

export interface PublicSite {
  id: string
  name: string
  addressLine: string
  city: string
  state: string
  latitude: number
  longitude: number
  chargePoints: PublicChargePoint[]
}

export interface PublicSitesQuery extends PaginationParams {
  minLat?: number
  maxLat?: number
  minLng?: number
  maxLng?: number
}

// ---------------------------------------------------------------------------
// Retaguarda: Dashboard e Relatórios
// (contrato desenhado pela Nova em `.claude/agent-memory/nova/
// decisoes-retaguarda-relatorios.md`, ainda sem rota real do Vega — ver
// `mocks/handlers.ts` para o espelho fiel usado nesta fase)
// ---------------------------------------------------------------------------

export interface Operator {
  id: string
  name: string
  active: boolean
}

export type ChargingSessionStatus = "STARTED" | "CHARGING" | "FINISHING" | "STOPPED" | "FAULTED"

export const STOP_REASONS = [
  "LOCAL",
  "REMOTE",
  "EV_DISCONNECTED",
  "HARD_RESET",
  "SOFT_RESET",
  "POWER_LOSS",
  "EMERGENCY_STOP",
  "DEAUTHORIZED",
  "UNLOCK_COMMAND",
  "OTHER",
] as const
export type StopReason = (typeof STOP_REASONS)[number]

export type PaymentIntentPurpose = "SESSION_CARD_CAPTURE" | "WALLET_TOPUP_PIX"
export type PaymentProvider = "CIELO_CARD" | "CIELO_PIX" | "WALLET"
export const PAYMENT_INTENT_STATUSES = [
  "CREATED",
  "AUTHORIZED",
  "CAPTURE_PENDING",
  "CAPTURED",
  "CANCELLED",
  "DENIED",
  "VOIDED",
  "FAILED",
  "EXPIRED",
] as const
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number]

/** Filtro de período comum a todas as rotas de relatório. Datas `YYYY-MM-DD` (sem hora) — o backend interpreta no fuso do site (nunca UTC), ver regra 4 da Nova. */
export interface ReportPeriodParams {
  from: string
  to: string
  siteId?: string
  /** Só ADMIN pode filtrar por operador — a API ignora este campo para OPERATOR (sempre escopado ao próprio). */
  operatorId?: string
}

/** Uma métrica com variação vs. período anterior. `deltaPct: null` quando o período anterior é zero (não dá para calcular %) — NUNCA `Infinity`. */
export interface MetricWithDelta {
  value: number
  deltaPct: number | null
}

export interface DashboardSummaryMetrics {
  revenueCents: MetricWithDelta
  sessions: MetricWithDelta
  energyWh: MetricWithDelta
  avgTicketCents: MetricWithDelta
  successRatePct: MetricWithDelta
  utilizationPct: MetricWithDelta
}

export interface DashboardRevenueByDay {
  date: string
  revenueCents: number
}

export interface DashboardPaymentSplit {
  cardCents: number
  walletCents: number
}

export interface DashboardSiteRanking {
  siteId: string
  siteName: string
  revenueCents: number
  sessions: number
}

export interface DashboardOperatorRanking {
  operatorId: string
  operatorName: string
  revenueCents: number
  sessions: number
}

export interface DashboardTodayMovementRow {
  siteId: string
  siteName: string
  sessions: number
  energyWh: number
  revenueCents: number
}

export interface DashboardSummaryResponse {
  period: { from: string; to: string; previousFrom: string; previousTo: string }
  metrics: DashboardSummaryMetrics
  revenueByDay: DashboardRevenueByDay[]
  paymentSplit: DashboardPaymentSplit
  topSites: DashboardSiteRanking[]
  /** Só presente para ADMIN — OPERATOR não vê ranking entre operadores. */
  topOperators?: DashboardOperatorRanking[]
  todayMovement: DashboardTodayMovementRow[]
}

export interface DashboardLiveSession {
  id: string
  siteId: string
  siteName: string
  chargePointId: string
  ocppIdentity: string
  connectorId: number
  /** Nome apenas — nunca e-mail (mesma regra de LGPD do detalhe de sessão). */
  driverName: string
  status: ChargingSessionStatus
  startedAt: string
  energyDeliveredWh: number
}

export interface DashboardLiveChargePointCounts {
  online: number
  offline: number
  faulted: number
  total: number
}

export interface DashboardLiveResponse {
  activeSessions: DashboardLiveSession[]
  chargePoints: DashboardLiveChargePointCounts
  generatedAt: string
}

// ---- Movimento diário -------------------------------------------------------

export interface DailyMovementRow {
  date: string
  siteId: string
  siteName: string
  sessions: number
  energyWh: number
  revenueCents: number
  avgTicketCents: number
}

export interface DailyMovementQuery extends ReportPeriodParams, PaginationParams {}

export interface DailyMovementResponse {
  items: DailyMovementRow[]
  meta: PaginationMeta
  totals: { sessions: number; energyWh: number; revenueCents: number }
}

// ---- Faturamento --------------------------------------------------------------

export type RevenueGranularity = "day" | "week" | "month"
export type RevenueBreakdownDimension = "site" | "chargePoint" | "method" | "tariff"

export interface RevenueSeriesPoint {
  bucket: string
  revenueCents: number
  energyWh: number
  sessions: number
}

export interface RevenueBreakdownRow {
  key: string
  label: string
  revenueCents: number
  energyWh: number
  sessions: number
}

export interface RevenueReportQuery extends ReportPeriodParams {
  granularity?: RevenueGranularity
  breakdown?: RevenueBreakdownDimension
}

export interface RevenueReportResponse {
  granularity: RevenueGranularity
  breakdown: RevenueBreakdownDimension
  series: RevenueSeriesPoint[]
  breakdownRows: RevenueBreakdownRow[]
  totals: { revenueCents: number; energyWh: number; sessions: number }
}

// ---- Sessões (analítico + drill-down) ------------------------------------------

export type SessionPaymentMethod = "CARD" | "WALLET"
export type SessionPaymentStatus = "CAPTURED" | "PENDING" | "FAILED" | "OPEN_DEBT"

export interface SessionListRow {
  id: string
  ocppTransactionId: number
  siteId: string
  siteName: string
  chargePointId: string
  ocppIdentity: string
  connectorId: number
  /** Nome apenas — e-mail só aparece no detalhe, e só para ADMIN (ver `SessionDetail.driver`). */
  driverName: string
  status: ChargingSessionStatus
  startedAt: string
  stoppedAt: string | null
  energyDeliveredWh: number | null
  totalCostCents: number | null
  paymentMethod: SessionPaymentMethod | null
  paymentStatus: SessionPaymentStatus | null
}

export interface SessionsReportQuery extends ReportPeriodParams, PaginationParams {
  status?: ChargingSessionStatus
  paymentMethod?: SessionPaymentMethod
  minAmountCents?: number
}

export interface SessionsReportResponse {
  items: SessionListRow[]
  meta: PaginationMeta
}

export interface SessionDetail {
  id: string
  ocppTransactionId: number
  site: { id: string; name: string }
  chargePoint: { id: string; ocppIdentity: string }
  connectorId: number
  /** `email` só vem preenchido para ADMIN — OPERATOR não pode ver e-mail de motorista (regra de LGPD do backend). */
  driver: { name: string; email?: string }
  status: ChargingSessionStatus
  startedAt: string
  chargingEndedAt: string | null
  stoppedAt: string | null
  stopReason: StopReason | null
  meterStartWh: number
  meterStopWh: number | null
  energyDeliveredWh: number | null
  idleSeconds: number | null
  tariffName: string
  costs: {
    energyCostCents: number | null
    timeCostCents: number | null
    idleFeeCents: number | null
    sessionFeeCents: number | null
    minChargeAdjustmentCents: number | null
    totalCostCents: number | null
  }
  paymentIntents: Array<{
    id: string
    provider: PaymentProvider
    status: PaymentIntentStatus
    amountRequestedCents: number
    amountCapturedCents: number | null
    createdAt: string
  }>
}

// ---- Financeiro / Pagamentos --------------------------------------------------

/**
 * Identidade de conciliação (regra 3 da Nova):
 * `expectedCents` (= faturamento) deve bater com `accountedCents` (= capturas
 * de cartão + débitos de carteira + dívida aberta). `differenceCents !== 0` é
 * sinal de bug real no backend — a tela nunca esconde isso.
 */
export interface PaymentsReconciliation {
  revenueCents: number
  cardCapturedCents: number
  walletDebitCents: number
  /** Só ADMIN — é o float Pix da REDE, não da operação de um operador (ver schema Wallet). `null` para OPERATOR. */
  walletTopupPixCents: number | null
  openDebtCents: number
  /** Informativo: valor de tentativas de pagamento que falharam (algumas foram pagas de novo com sucesso, outras viraram `openDebtCents`). */
  failedAttemptsCents: number
  expectedCents: number
  accountedCents: number
  differenceCents: number
}

export interface PaymentListRow {
  id: string
  purpose: PaymentIntentPurpose
  provider: PaymentProvider
  status: PaymentIntentStatus
  amountRequestedCents: number
  amountCapturedCents: number | null
  userName: string
  chargingSessionId: string | null
  siteId: string | null
  siteName: string | null
  createdAt: string
}

export interface PaymentsReportQuery extends ReportPeriodParams, PaginationParams {
  provider?: PaymentProvider
  status?: PaymentIntentStatus
}

export interface PaymentsReportResponse {
  reconciliation: PaymentsReconciliation
  items: PaymentListRow[]
  meta: PaginationMeta
}

// ---------------------------------------------------------------------------
// F4: sessão de recarga cobrando da carteira (desenho da Nova, ver
// PROGRESSO.md §F4 desenhada). Carteira pré-paga SEM hold — sem reserva
// antecipada por débito (proibido pela identidade de conciliação acima:
// reservar e devolver troco abriria diferença em vermelho na tela
// Financeiro). Débito único e atômico no StopTransaction; o que faltar vira
// Debt (bloqueia a próxima recarga).
// ---------------------------------------------------------------------------

// ---- POST /api/admin/charge-points/:id/commands/remote-start --------------

export interface RemoteStartRequest {
  connectorId: number
  userId: string
}

/** 202 — fire-and-forget, mesmo padrão dos outros comandos remotos (ver PROGRESSO.md §F3b). */
export interface RemoteStartResponse {
  correlationId: string
  status: "PENDING"
  /** idTag do AuthToken VIRTUAL criado para esta sessão (amarrado ao userId). */
  idTag: string
  walletBalanceCents: number
  /** Teto calculado (`calcularTetoReserva`) — só informativo aqui, NÃO é reservado/debitado agora (sem hold). */
  estimatedMaxCostCents: number
}

export type RemoteStartErrorCode =
  | "CHARGE_POINT_NOT_FOUND"
  | "CONNECTOR_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "DRIVER_HAS_OPEN_DEBT"
  | "INSUFFICIENT_BALANCE"
  | "CONNECTOR_BUSY"
  | "CHARGE_POINT_OFFLINE"

// ---- POST /api/admin/sessions/:id/stop -------------------------------------

export interface StopSessionResponse {
  correlationId: string
  status: "PENDING"
}

export type StopSessionErrorCode = "SESSION_NOT_FOUND" | "SESSION_NOT_ACTIVE"

// ---- GET /api/admin/drivers -------------------------------------------------

export interface DriverListRow {
  id: string
  name: string
  /** Chave OMITIDA (nunca `null`) para OPERATOR — LGPD, mesma regra do detalhe de sessão. */
  email?: string
  walletBalanceCents: number
  openDebtCents: number
  activeSessionId: string | null
  createdAt: string
}

export interface DriversListQuery extends PaginationParams {
  /**
   * OBRIGATÓRIO (mín. 3 caracteres) para OPERATOR — motorista é conta de
   * rede, não pertence a operador, então OPERATOR nunca lista a base
   * inteira, só busca o que está no poste dele agora. Opcional para ADMIN.
   */
  search?: string
}

export interface DriversListResponse {
  items: DriverListRow[]
  total: number
  page: number
  pageSize: number
}

// ---- GET /api/admin/drivers/:id/wallet --------------------------------------

export type WalletEntryType = "TOPUP_PIX" | "TOPUP_REFUND" | "CHARGE_DEBIT" | "ADJUSTMENT_CREDIT" | "ADJUSTMENT_DEBIT" | "REFUND"

export interface WalletEntryRow {
  id: string
  type: WalletEntryType
  /** Assinado: crédito > 0, débito < 0. */
  amountCents: number
  balanceAfterCents: number
  referenceType: string | null
  referenceId: string | null
  description: string | null
  createdAt: string
}

export type DriverWalletQuery = PaginationParams

export interface DriverWalletResponse {
  driverId: string
  driverName: string
  balanceCents: number
  openDebtCents: number
  entries: WalletEntryRow[]
  total: number
  page: number
  pageSize: number
}

// ---- POST /api/admin/drivers/:id/wallet/entries — ADMIN ONLY ----------------

export interface WalletAdjustmentRequest {
  /** != 0; > 0 credita, < 0 debita; |valor| <= 500000 (R$ 5.000, teto do dono). */
  amountCents: number
  /** Obrigatório, mín. 5 caracteres — trilha de auditoria do lançamento manual. */
  description: string
}

export type WalletAdjustmentErrorCode = "FORBIDDEN" | "INSUFFICIENT_BALANCE"

// ---------------------------------------------------------------------------
// PWA do motorista — rotas /api/me/* (DRIVER only) e a única rota pública
// nova, GET /api/public/charge-points/:ocppIdentity (desenho da Nova, ver
// .claude/agent-memory/nova/decisoes-pwa-motorista.md). O motorista escaneia
// um QR no carregador (codifica `ocppIdentity`, não o cuid) e inicia/
// acompanha/para a própria recarga, gastando da carteira pré-paga da F4.
//
// Núcleo de negócio 100% reaproveitado da F4 (avaliarInicioSessao,
// calcularTetoReserva, calcularCustoSessao) — as rotas admin (`/api/admin/
// sessions`, `/api/admin/charge-points/:id/commands/remote-start`) continuam
// existindo sem mudança de contrato; estas são as equivalentes escopadas por
// `userId` (o motorista) em vez de `operatorId` (o admin).
// ---------------------------------------------------------------------------

// ---- GET /api/public/charge-points/:ocppIdentity — SEM autenticação --------

export interface PublicTariffSummary {
  name: string
  model: TariffModel
  /** Reais por kWh — Decimal serializado como string. */
  pricePerKwh: string | null
  /** Reais por minuto — Decimal serializado como string. */
  pricePerMinute: string | null
  sessionFeeCents: number | null
  minChargeCents: number | null
  idleFeePerMinute: number
  currency: string
}

export interface PublicChargePointConnector {
  connectorId: number
  type: ConnectorType
  maxPowerKw: string | null
  status: ConnectorStatus
  /** `null` = conector sem `TariffAssignment` ativa cadastrada — não bloqueia a listagem, só o início de recarga (`CHARGE_POINT_NOT_FOUND`-like checagem acontece de novo em `POST /api/me/sessions/start`). */
  tariff: PublicTariffSummary | null
}

export interface PublicChargePointCard {
  ocppIdentity: string
  vendor: string | null
  model: string | null
  /** `lastSeenAt` dentro do threshold de "online" do dashboard admin (5min). */
  online: boolean
  site: { id: string; name: string; addressLine: string | null; city: string | null; state: string | null }
  connectors: PublicChargePointConnector[]
  generatedAt: string
}

export type PublicChargePointErrorCode = "CHARGE_POINT_NOT_FOUND"

// ---- POST /api/me/sessions/start --------------------------------------------

export interface MeStartSessionRequest {
  ocppIdentity: string
  connectorId: number
}

/** 202 — fire-and-forget, mesmo padrão do remote-start admin. */
export interface MeStartSessionResponse {
  correlationId: string
  status: "PENDING"
  walletBalanceCents: number
  /** Teto calculado (`calcularTetoReserva`) — só informativo, NUNCA reservado/debitado antecipadamente. */
  estimatedMaxCostCents: number
  /** Cobrança mínima da tarifa — precisa aparecer ANTES de iniciar (achado de produto da F6, ver decisoes-pwa-motorista.md §6), não só no recibo. */
  minChargeCents: number | null
}

export type MeStartSessionErrorCode =
  | "CHARGE_POINT_NOT_FOUND"
  | "CONNECTOR_NOT_FOUND"
  | "CHARGE_POINT_OFFLINE"
  | "CONNECTOR_BUSY"
  | "DRIVER_HAS_OPEN_DEBT"
  | "INSUFFICIENT_BALANCE"
  | "ALREADY_HAS_ACTIVE_SESSION"

// ---- GET /api/me/sessions/active --------------------------------------------

export interface MeActiveSession {
  id: string
  status: ChargingSessionStatus
  startedAt: string
  chargePoint: { ocppIdentity: string; vendor: string | null; model: string | null }
  site: { id: string; name: string; addressLine: string | null; city: string | null }
  connector: { connectorId: number; type: ConnectorType; maxPowerKw: string | null }
  energyDeliveredWh: number
  lastPowerW: number | null
  lastSoc: number | null
  lastSampleAt: string | null
  /** Calculado pela MESMA função (`calcularCustoSessao`) que a guarda ao vivo do MeterValues usa — nunca diverge do que pode disparar o auto-stop. */
  estimatedCostCents: number
  estimatedMaxCostCents: number
  minChargeCents: number | null
  tariff: PublicTariffSummary
}

export interface MeActiveSessionResponse {
  /** `null` (200, não 404) quando o motorista não tem sessão ativa agora. */
  session: MeActiveSession | null
  walletBalanceCents: number
  generatedAt: string
}

// ---- GET /api/me/sessions ----------------------------------------------------

export interface MeSessionListItem {
  id: string
  status: ChargingSessionStatus
  startedAt: string
  stoppedAt: string | null
  siteName: string
  ocppIdentity: string
  connectorId: number
  energyDeliveredWh: number | null
  totalCostCents: number | null
}

export type MeSessionsQuery = PaginationParams

export interface MeSessionsListResponse {
  items: MeSessionListItem[]
  total: number
  page: number
  pageSize: number
}

// ---- GET /api/me/sessions/:id -------------------------------------------------

export interface MeSessionDetail {
  id: string
  status: ChargingSessionStatus
  startedAt: string
  stoppedAt: string | null
  stopReason: StopReason | null
  site: { name: string; addressLine: string | null; city: string | null }
  chargePoint: { ocppIdentity: string }
  connector: { connectorId: number; type: ConnectorType }
  energyDeliveredWh: number | null
  idleSeconds: number | null
  energyCostCents: number | null
  timeCostCents: number | null
  idleFeeCents: number | null
  sessionFeeCents: number | null
  minChargeAdjustmentCents: number | null
  totalCostCents: number | null
  tariff: PublicTariffSummary
  walletEntry: { id: string; amountCents: number; balanceAfterCents: number; createdAt: string } | null
  debt: { id: string; amountCents: number } | null
}

export type MeSessionDetailErrorCode = "SESSION_NOT_FOUND"

// ---- POST /api/me/sessions/:id/stop --------------------------------------------

/** 202 — fire-and-forget, mesmo padrão de `POST /api/admin/sessions/:id/stop`. */
export interface MeStopSessionResponse {
  correlationId: string
  status: "PENDING"
}

export type MeStopSessionErrorCode = "SESSION_NOT_FOUND" | "SESSION_NOT_ACTIVE"

// ---- GET /api/me/commands/:correlationId ---------------------------------------

/**
 * Conserta o "202 cego": consulta o resultado real do comando OCPP disparado
 * por `POST /api/me/sessions/start` ou `POST /api/me/sessions/:id/stop`.
 * `PENDING` = ainda não resolveu (ou a chave já expirou/nunca existiu —
 * mesma resposta, não dá para distinguir e não precisa). `TIMEOUT` = o
 * carregador não respondeu dentro do prazo do comando (35s).
 */
export type MeCommandStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "TIMEOUT"

export interface MeCommandStatusResponse {
  status: MeCommandStatus
}

// ---- GET /api/me/wallet ----------------------------------------------------------

export interface MeWalletEntryDTO {
  id: string
  type: WalletEntryType
  /** Assinado: crédito > 0, débito < 0. */
  amountCents: number
  balanceAfterCents: number
  referenceType: string | null
  referenceId: string | null
  description: string | null
  createdAt: string
}

export type MeWalletQuery = PaginationParams

/** Mesmo shape de `DriverWalletResponse`, mas sem `driverId`/`driverName` — o próprio motorista sabe quem é. */
export interface MeWalletResponse {
  balanceCents: number
  openDebtCents: number
  entries: MeWalletEntryDTO[]
  total: number
  page: number
  pageSize: number
}

// ---------------------------------------------------------------------------
// AuditLog (ADMIN-only) — trilha de "quem fez o quê, onde e como" no painel
// admin. Contrato traduzido do desenho da Nova (2026-09-17), decisões
// completas em `.claude/agent-memory/nova/decisoes-audit-log.md`: append-only
// por trigger (UPDATE sempre bloqueado, DELETE só permitido além do piso de
// retenção), payload é ALLOWLIST por entidade — nunca `req.body` cru, e
// segredo (`password`/`basicAuthSecret`/`cieloCardToken`/`*Hash`/`idTag`
// completo) nunca entra em `changes`. Comando remoto grava INTENÇÃO (o
// resultado real mora em `OcppMessage`, correlacionado por `correlationId`).
// Ver o log não gera log; `format=csv` gera (`action=EXPORT`).
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "REMOTE_COMMAND",
  "WALLET_ADJUSTMENT",
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "EXPORT",
  "OTHER",
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const AUDIT_OUTCOMES = ["SUCCESS", "DENIED", "FAILED"] as const
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

/** Mesmos presets de `reportingWindow.ts` (backend) — reuso explícito decidido pela Nova, não uma cópia por acaso. */
export const AUDIT_LOG_PERIODS = ["today", "7d", "30d", "month", "prev_month", "custom"] as const
export type AuditLogPeriod = (typeof AUDIT_LOG_PERIODS)[number]

export interface AuditLogActor {
  userId: string
  name: string
  email: string
  role: Role
  operatorId: string | null
}

export interface AuditLogListItem {
  id: string
  occurredAt: string
  actor: AuditLogActor
  action: AuditAction
  actionDetail: string | null
  outcome: AuditOutcome
  httpStatus: number | null
  entityType: string | null
  entityId: string | null
  targetOperatorId: string | null
  method: string
  path: string
  ipAddress: string | null
  /** `true` quando existe payload em `AuditLogDetail.changes` — evita o cliente abrir o detalhe só para descobrir que está vazio. */
  hasChanges: boolean
}

// ---- GET /api/admin/audit-logs -------------------------------------------------

export interface AuditLogQuery {
  period?: AuditLogPeriod
  from?: string
  to?: string
  tz?: string
  actorUserId?: string
  actorRole?: Role
  action?: AuditAction
  outcome?: AuditOutcome
  entityType?: string
  entityId?: string
  /** Só ADMIN pode filtrar por operador — mesma regra de `ReportPeriodParams.operatorId`. Tela é ADMIN-only, mas o filtro ainda faz sentido com múltiplos operadores na mesma listagem. */
  operatorId?: string
  /** Busca livre (nome/e-mail do ator, id de entidade) — o backend decide o que indexar. */
  q?: string
  page?: number
  pageSize?: number
  format?: "json" | "csv"
}

export interface AuditLogListResponse {
  items: AuditLogListItem[]
  meta: PaginationMeta
}

// ---- GET /api/admin/audit-logs/:id ----------------------------------------------

export interface AuditLogDetail extends AuditLogListItem {
  userAgent: string | null
  requestId: string | null
  correlationId: string | null
  /** `null` quando `hasChanges` é `false`. Allowlist por entidade — nunca contém segredo. */
  changes: Record<string, unknown> | null
}

// ---- GET /api/admin/audit-logs/actors --------------------------------------------

export interface AuditLogActorsQuery {
  period?: AuditLogPeriod
  from?: string
  to?: string
  tz?: string
}

export interface AuditLogActorSummary {
  userId: string
  name: string
  email: string
  role: Role
  operatorId: string | null
  eventCount: number
}

export interface AuditLogActorsResponse {
  items: AuditLogActorSummary[]
}

// ---------------------------------------------------------------------------
// Tempo real (SSE) — canal servidor→cliente para dashboard/sessão ativa/PWA.
// Decisões completas em
// `.claude/agent-memory/nova/decisoes-tempo-real-sse.md` (Nova, 2026-09-17):
// SSE (não WebSocket), fan-out via Redis pub/sub em namespace próprio
// (`ui:ev:*`), fronteira multi-tenant na ASSINATURA do canal (não num `if`
// depois de receber o evento), auth por `Authorization: Bearer` (nunca JWT
// na querystring — vazaria em access log/histórico/Referer), publish sempre
// DEPOIS do commit da transação. Nenhum endpoint existe ainda — só o FORMATO
// do evento, para o cliente SSE já poder ser escrito contra ele.
//
// Regra de consumo (Lyra): default é invalidar a query React Query
// correspondente (o evento só diz "isto ficou velho", o REST continua fonte
// única de forma/autorização). Única exceção enumerada pela Nova:
// `session.metrics` pode ir direto em `setQueryData` (energyWh/powerW/soc/
// partialCostCents da sessão ativa) — a cada poucos segundos, invalidate+
// refetch seria só reinventar o polling com passos a mais.
// ---------------------------------------------------------------------------

export interface RealtimeEventBase {
  type: string
  /** ISO 8601 — momento em que o evento foi gerado no servidor, não em que o cliente recebeu. */
  occurredAt: string
}

/** Única exceção ao "default invalidar" (ver nota acima) — consumir com `setQueryData`. */
export interface SessionMetricsEvent extends RealtimeEventBase {
  type: "session.metrics"
  sessionId: string
  energyWh: number
  powerW: number | null
  soc: number | null
  partialCostCents: number
}

export interface SessionStatusEvent extends RealtimeEventBase {
  type: "session.started" | "session.stopped"
  sessionId: string
  chargePointId: string
}

export interface WalletUpdatedEvent extends RealtimeEventBase {
  type: "wallet.updated"
  userId: string
  balanceCents: number
}

/** `status` é o mesmo enum de `Connector.status` (`ConnectorStatus`), nunca um valor novo inventado para o evento. */
export interface ChargePointStatusEvent extends RealtimeEventBase {
  type: "chargepoint.status"
  chargePointId: string
  connectorId: number
  status: ConnectorStatus
}

/**
 * Sai do MESMO ponto que grava `AuditLog` (`res.on('finish')` do middleware
 * de auditoria) — todo CRUD admin futuro nasce coberto pelos dois de uma vez,
 * sem instrumentação nova. `action` aqui é só CREATE/UPDATE/DELETE (não os 9
 * valores de `AuditAction` — comando remoto/login/export não mudam uma
 * entidade administrável, não fazem sentido aqui).
 */
export interface AdminEntityChangedEvent extends RealtimeEventBase {
  type: "admin.entity.changed"
  entityType: string
  entityId: string
  action: "CREATE" | "UPDATE" | "DELETE"
}

/** No máx. 1 a cada 5s (throttle do servidor) — nunca dispara recálculo do agregado por evento, só invalidação; `getDashboardLive`/`getDashboardSummary` continuam sendo quem busca de verdade. */
export interface DashboardDirtyEvent extends RealtimeEventBase {
  type: "dashboard.dirty"
}

export type RealtimeEvent =
  | SessionMetricsEvent
  | SessionStatusEvent
  | WalletUpdatedEvent
  | ChargePointStatusEvent
  | AdminEntityChangedEvent
  | DashboardDirtyEvent
