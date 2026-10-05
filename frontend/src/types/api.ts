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
  /**
   * `true` se a conta TEM senha (login por e-mail+senha possível); `false` para conta que
   * só entra pelo Google (criada por lá, ou cuja senha foi zerada ao vincular o Google —
   * ver `ChangePasswordRequest`). Decide se a tela de senha pede a senha atual. Sempre
   * enviado pelo servidor (login/cadastro/google/troca de senha); opcional no tipo só para
   * não quebrar mocks antigos.
   */
  hasPassword?: boolean
}

export interface AuthResponse {
  token: string
  user: User
}

/**
 * `POST /api/auth/password` (AUTENTICADO — qualquer papel troca a PRÓPRIA senha). Resposta:
 * `AuthResponse` com um token NOVO — a troca revoga todas as sessões anteriores (inclusive a
 * atual), então o cliente precisa SUBSTITUIR o token guardado pelo devolvido.
 *
 * - Conta COM senha (`user.hasPassword`): `currentPassword` é obrigatória.
 * - Conta só-Google (sem senha): `currentPassword` é ignorada — pode DEFINIR a primeira senha
 *   direto (a identidade já foi provada pelo token de sessão).
 * - `newPassword`: 10 a 72 bytes (limite do bcrypt).
 *
 * Erros (trate por `code`): 400 `VALIDATION_ERROR` (ex. senha curta), 400
 * `CURRENT_PASSWORD_REQUIRED`, 400 `PASSWORD_UNCHANGED` (nova = atual), 403 `INVALID_CURRENT_PASSWORD` (**403 de propósito, não 401**:
 * o interceptor global trata 401 como sessão expirada e deslogaria quem só errou a senha
 * atual), 429 `RATE_LIMITED_PASSWORD` (limite por usuário, não por IP). Ver `ChangePasswordErrorCode`.
 *
 * L1.2: esta é a rota que a tela de perfil (PWA) e o diálogo "Alterar senha" (admin) chamam — já existe, não há rota nova de troca de senha.
 */
export interface ChangePasswordRequest {
  currentPassword?: string
  newPassword: string
}
export type ChangePasswordErrorCode =
  | "VALIDATION_ERROR"
  | "CURRENT_PASSWORD_REQUIRED"
  | "PASSWORD_UNCHANGED"
  | "INVALID_CURRENT_PASSWORD"
  | "RATE_LIMITED_PASSWORD"
  | "UNAUTHORIZED"

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
  /**
   * L1.9 (IMPLEMENTADO, backend 40fb2ec): versão dos Termos que a pessoa aceitou (= `PublicLegalConfig.termsVersion` vigente). SÓ é exigida quando o Google vai CRIAR conta: ausente
   * nesse caso = 400 `VALIDATION_ERROR` com `details[].path = "acceptedTermsVersion"` (a tela mostra o aceite e reenvia a MESMA credencial); versão antiga = 409 `TERMS_VERSION_OUTDATED`.
   * Quem já tem conta entra sem mandar nada.
   */
  acceptedTermsVersion?: string
}

/**
 * I-7 (04/10/2026) — `POST /api/auth/google/link` (COM auth, Bearer): vincula o Google à conta JÁ LOGADA (motorista que entrou por senha) para liberar o pagamento
 * com cartão, SEM trocar de conta e SEM apagar a senha (diferente de `POST /api/auth/google`, que é público, ignora o token atual, zera a senha e pode cair em
 * OUTRA conta). Corpo = `GoogleAuthRequest`. Só vincula se o e-mail VERIFICADO do Google for igual ao e-mail da conta (senão o vínculo viraria atalho para
 * a restrição de sandbox/cartão por e-mail). 200 `{ linked: true }`. Erros: `INVALID_GOOGLE_TOKEN` (401), `GOOGLE_EMAIL_NOT_VERIFIED` (403),
 * `GOOGLE_EMAIL_MISMATCH` (403 — o Google escolhido tem outro e-mail), `GOOGLE_ALREADY_LINKED` (409 — esta conta já tem Google, ou este Google já está em
 * outra conta), `GOOGLE_NOT_CONFIGURED` (503), `GOOGLE_LOGIN_NOT_ALLOWED` (403 — só DRIVER).
 */
export interface LinkGoogleResponse {
  linked: true
}
export type LinkGoogleErrorCode =
  | "INVALID_GOOGLE_TOKEN"
  | "GOOGLE_EMAIL_NOT_VERIFIED"
  | "GOOGLE_EMAIL_MISMATCH"
  | "GOOGLE_ALREADY_LINKED"
  | "GOOGLE_NOT_CONFIGURED"
  | "GOOGLE_LOGIN_NOT_ALLOWED"

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

/** Filtros de `GET /api/admin/tariff-assignments` (todos opcionais; `pageSize` máx. 100 como nas demais listagens). */
export interface TariffAssignmentListParams extends PaginationParams {
  tariffId?: string
  siteId?: string
  chargePointId?: string
  connectorId?: string
  scope?: TariffAssignmentScope
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
  /** Status CRU vindo do carregador (StatusNotification). Para decidir "livre" use `isFree` — o status sozinho mente quando o carregador está offline. */
  status: ConnectorStatus
  maxPowerKw: string | number | null
  /**
   * Regra ÚNICA de "livre agora", calculada no SERVIDOR: carregador online
   * (mesmo limiar de `CHARGE_POINT_ONLINE_THRESHOLD_MS` do dashboard) E
   * `status === "AVAILABLE"`. Nunca reescreva essa regra no cliente.
   * Estado de AGORA — não existe reserva (ver `decisoes-mapa-eletropostos.md`).
   */
  isFree: boolean
}

export interface PublicChargePoint {
  id: string
  /** Identidade pública do equipamento — base do deep link `/c/:ocppIdentity/:connectorId`. */
  ocppIdentity: string
  /** Conectado agora (regra única do servidor, ver `PublicConnector.isFree`). */
  online: boolean
  vendor: string | null
  model: string | null
  connectors: PublicConnector[]
}

/** Agregado por (tipo, potência) de um site — o que o mapa/lista mostra sem precisar somar conector por conector. */
export interface PublicConnectorGroup {
  type: ConnectorType
  maxPowerKw: number | null
  total: number
  free: number
}

export interface PublicSite {
  id: string
  name: string
  addressLine: string
  city: string
  state: string
  /** Sempre `number` (o servidor converte o Decimal — nunca string). */
  latitude: number
  longitude: number
  chargePoints: PublicChargePoint[]
  /** Totais do site inteiro, já calculados pelo servidor com a mesma regra de `isFree`. */
  connectorSummary: { total: number; free: number; groups: PublicConnectorGroup[] }
}

export interface PublicSitesQuery extends PaginationParams {
  /** Bounding box GROSSEIRA: o cliente arredonda em grade de 0,1° (~11 km) antes de mandar — a querystring vai pro access log e não pode reconstituir a posição exata (LGPD). A posição real do motorista nunca sai do aparelho. */
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

/**
 * F5.9 (sessão travada): `STOP_UNCONFIRMED` = o servidor acha que a sessão acabou, mas o carregador não confirmou. NÃO é terminal e NÃO é "ativa" para o
 * motorista: nada foi cobrado ainda (WALLET não debitou; CARD continua só pré-autorizado). Vira `STOPPED` quando o carregador confirma ou quando a janela de
 * confirmação vence (encerramento pelo servidor), ou volta a um estado aberto se o carregador voltar a medir ("reanima").
 */
export type ChargingSessionStatus = "STARTED" | "CHARGING" | "FINISHING" | "STOPPED" | "FAULTED" | "STOP_UNCONFIRMED"

/** F5.9 — quem fechou a sessão: o próprio carregador (StopTransaction) ou o servidor (watchdog, com a melhor prova disponível). `null` = aberta/em confirmação/anterior à F5.9. */
export type SessionClosureSource = "CHARGER" | "SERVER"
/** F5.9 — de onde veio a leitura final do medidor usada na cobrança. */
export type MeterStopSource = "STOP_TRANSACTION" | "LAST_METER_SAMPLE" | "NO_READING"
/** F5.9 — por que a sessão entrou em `STOP_UNCONFIRMED`. */
export type StopUnconfirmedReason = "STOP_REJECTED" | "STOP_NOT_CONFIRMED" | "CHARGER_UNREACHABLE" | "CHARGER_REBOOTED" | "CONNECTOR_IDLE" | "MAX_DURATION"
export type SessionStopRequester = "DRIVER" | "ADMIN" | "GUARD" | "WATCHDOG"

/** F5.9 — bloco `closure` do detalhe da sessão (motorista e admin). Todos os campos são `null` em sessão aberta e em sessão anterior à F5.9. */
export interface SessionClosureInfo {
  source: SessionClosureSource | null
  meterStopSource: MeterStopSource | null
  /** ISO — só em `STOP_UNCONFIRMED`. */
  unconfirmedSince: string | null
  unconfirmedReason: StopUnconfirmedReason | null
  /** ISO — até quando o servidor espera o carregador (calculado na leitura pela mesma função pura do watchdog). Só em `STOP_UNCONFIRMED`. */
  confirmDeadline: string | null
  /** ISO — = `stoppedAt` quando `source = "SERVER"`: "cobramos só o que foi medido até este horário". */
  billedUntil: string | null
}

/** F5.9 — só no detalhe ADMIN: StopTransaction que chegou DEPOIS de a sessão ser encerrada pelo servidor (informativo; não altera o total cobrado). O motorista nunca vê isto. */
export interface SessionLateStop {
  meterStopWh: number
  stoppedAt: string
  receivedAt: string
  unbilledCostCents: number
}

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
  /** F5.9 */
  closure: SessionClosureInfo
  stopRequestedAt: string | null
  stopRequestedBy: SessionStopRequester | null
  stopAttempts: number
  lateStop: SessionLateStop | null
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
 * de cartão + capturas de cartão PENDENTES + débitos de carteira + quitações
 * de dívida + dívida aberta). `differenceCents !== 0` é sinal de bug real no
 * backend — a tela nunca esconde isso.
 *
 * F5.4 (2026-09-30): `cardCapturePendingCents`/`debtSettledCents` novos —
 * sem eles a identidade ficava errada nos minutos entre o Stop de uma sessão
 * CARD e o worker confirmar a captura, e quando uma dívida era quitada via
 * Pix (o valor saía de `openDebtCents` e não reaparecia em lugar nenhum).
 */
export interface PaymentsReconciliation {
  revenueCents: number
  cardCapturedCents: number
  /** Σ totalCostCents das sessões CARD com intent ainda em CAPTURE_PENDING — a captura confirmada chega depois, via worker. */
  cardCapturePendingCents: number
  walletDebitCents: number
  /** Σ dívidas quitadas automaticamente por crédito de Pix no período/escopo (ligadas à sessão via Debt.chargingSessionId). */
  debtSettledCents: number
  /** Só ADMIN — é o float Pix da REDE, não da operação de um operador (ver schema Wallet). `null` para OPERATOR. */
  walletTopupPixCents: number | null
  openDebtCents: number
  /** Informativo: valor de tentativas de pagamento que falharam (algumas foram pagas de novo com sucesso, outras viraram `openDebtCents`). */
  failedAttemptsCents: number
  /** Informativo — estorno/chargeback de cartão. NUNCA entra em `accountedCents` (o intent continua CAPTURED mesmo estornado, senão a identidade quebra de novo). */
  cardRefundedCents: number
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
  /** L1.8 (entregue): achar a venda de um chargeback pelos identificadores da adquirente (igualdade exata). `proofOfSale` = NSU. */
  tid?: string
  authorizationCode?: string
  proofOfSale?: string
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

/**
 * L1.5 (06/10/2026) — **MUDANÇA DELIBERADA**: `reason` passou a ser OBRIGATÓRIO (texto livre do suporte, 10 a 200 caracteres depois do trim, sem
 * caracteres de controle) e vai para a auditoria (`actionDetail`) junto com o motorista-alvo e o `correlationId`. Sem `reason` (ou fora dos limites) = 400
 * `VALIDATION_ERROR` com `details[].path = "reason"`. Nenhum cliente de produção chamava esta rota (só a API); a tela admin é nova.
 *
 * DL4 (decisão do dono, 05/10/2026): no lote 1 só **ADMIN** inicia recarga remota. OPERATOR recebe 403 `FORBIDDEN` (hoje um operador conseguiria debitar a
 * carteira de QUALQUER motorista da rede). Reabrir para OPERATOR depende do aviso por e-mail ao motorista (L1.6). A regra mora numa função única no backend.
 * Continua só carteira (WALLET).
 */
export interface RemoteStartRequest {
  connectorId: number
  userId: string
  /** 10 a 200 caracteres (após trim). Obrigatório. */
  reason: string
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
  /** L1.5/DL4 — 403: só ADMIN inicia recarga remota no lote 1. */
  | "FORBIDDEN"
  /** L1.5 — 400: `reason` ausente ou fora de 10–200 caracteres (ver `details`). */
  | "VALIDATION_ERROR"

/**
 * L1.5 — `GET /api/admin/commands/:correlationId` (ADMIN, DL4; OPERATOR = 403 `FORBIDDEN`). Consulta o resultado do comando disparado por
 * `POST /api/admin/charge-points/:id/commands/remote-start` (mesmo cache de resultado do `GET /api/me/commands/:id`, Redis, TTL de 2 min).
 *
 * - `PENDING` = o comando está em andamento (o registro nasce PENDING no disparo, antes do 202).
 * - `ACCEPTED` / `REJECTED` ("o carregador recusou") / `TIMEOUT` (sem resposta em 35 s).
 * - 404 `COMMAND_NOT_FOUND` = id desconhecido, EXPIRADO (passou de 2 min) ou fora do escopo do chamador — as três situações são indistinguíveis de propósito
 *   (não confirma que um correlationId existe). Quem faz polling de 2 s por até 60 s nunca esbarra no TTL; 404 durante o polling = mostre "resultado indisponível".
 * - Só comandos de `remote-start` gravam nesse registro hoje; `reset`/`unlock`/`change-availability`/`trigger-message` continuam 202 "cegos" (404 aqui).
 */
export interface AdminCommandStatusResponse {
  status: MeCommandStatus
}
export type AdminCommandStatusErrorCode = "COMMAND_NOT_FOUND" | "FORBIDDEN"

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

/**
 * `payment` (F5.4, ver `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md`
 * §2) escolhe a forma de pagamento da recarga: `WALLET` (default, comportamento
 * de sempre) ou `CARD` com um `paymentMethodId` de `GET /api/me/payment-methods`
 * — a pré-autorização roda DENTRO desta rota, antes do RemoteStart, nunca no
 * `StartTransaction`/`Authorize` OCPP. Omitir `payment` equivale a `{ mode:
 * "WALLET" }` (compatibilidade com quem chamava antes da F5.4 existir).
 */
export interface MeStartSessionRequest {
  ocppIdentity: string
  connectorId: number
  payment?: { mode: "WALLET" } | { mode: "CARD"; paymentMethodId: string }
}

/** 202 — fire-and-forget, mesmo padrão do remote-start admin. */
export interface MeStartSessionResponse {
  correlationId: string
  status: "PENDING"
  paymentMode: "WALLET" | "CARD"
  walletBalanceCents: number
  /** Teto calculado (`calcularTetoReserva`) — só informativo, NUNCA reservado/debitado antecipadamente. */
  estimatedMaxCostCents: number
  /** Valor de fato pré-autorizado no cartão — só preenchido quando `paymentMode === "CARD"` (a pré-auth já rodou síncrona, dentro desta mesma chamada). */
  authorizedCents: number | null
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
  /** `payment.paymentMethodId` não existe (mais) para este motorista — pode ter sido removido em outra aba. */
  | "PAYMENT_METHOD_NOT_FOUND"
  | "PAYMENT_METHOD_DISABLED"
  | "CARD_AUTHORIZATION_DENIED"
  | "PAYMENT_GATEWAY_UNAVAILABLE"
  /** I-7: `payment.mode = "CARD"` sem identidade verificada (login Google) — 403. Carteira/Pix seguem normais. */
  | "CARD_REQUIRES_VERIFIED_IDENTITY"
  /** I-7: cartão bloqueado por recusas em excesso — 429 com `Retry-After` e `details: { blockedUntil }`. */
  | "CARD_TEMPORARILY_BLOCKED"

/**
 * Forma de pagamento usada na sessão (F5.4) — `card` só existe quando
 * `paymentMode === "CARD"` (senão `null`, nunca omitido, pra não confundir
 * com "ainda não sabemos"). `status` é o `PaymentIntentStatus` do intent de
 * captura (`SESSION_CARD_CAPTURE`): `AUTHORIZED` antes do Stop,
 * `CAPTURE_PENDING` logo depois (o worker captura fora do caminho síncrono,
 * ver decisoes-f5-pagamento-cielo.md §2), `CAPTURED` quando resolve.
 * `capturedCents < totalCostCents` da sessão = sobra virou `Debt`, mesmo
 * espírito do aviso que WALLET já mostra quando o saldo não cobre tudo.
 */
export interface MeSessionPaymentInfo {
  mode: "WALLET" | "CARD"
  card: {
    brand: string
    last4: string | null
    authorizedCents: number
    capturedCents: number | null
    status: PaymentIntentStatus
  } | null
}

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
  paymentMode: "WALLET" | "CARD"
  payment?: MeSessionPaymentInfo
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
  paymentMode: "WALLET" | "CARD"
  payment?: MeSessionPaymentInfo
  /** F5.9 */
  closure: SessionClosureInfo
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

// ---- POST /api/me/wallet/topups, GET /api/me/wallet/topups/:id -----------------

/**
 * Recarga de saldo via Pix (F5.1 — ver `.claude/agent-memory/nova/
 * decisoes-f5-pagamento-cielo.md`). `PENDING` é o único estado "vivo": a UI
 * descobre `PAID`/`EXPIRED`/`FAILED` primariamente por polling de
 * `GET /api/me/wallet/topups/:id` (mesmo espírito de `MeCommandStatusResponse`
 * /`useCommandStatus`) — `topup.updated` (ver `RealtimeEvent` abaixo) já está
 * PREPARADO no cliente, mas o backend real ainda não emite esse evento.
 */
export type MeTopupStatus = "PENDING" | "PAID" | "EXPIRED" | "FAILED"

export interface MeCreateTopupRequest {
  /** Entre `TOPUP_MIN_AMOUNT_CENTS` e `TOPUP_MAX_AMOUNT_CENTS` (ver `lib/topupAmount.ts`) — R$ 10,00 a R$ 500,00. */
  amountCents: number
  /** Opcional por enquanto — D3 (se a Cielo exige CPF no Pix) segue em aberto com o dono, ver PROGRESSO.md. */
  cpf?: string
}

export interface MeTopupDTO {
  id: string
  status: MeTopupStatus
  amountCents: number
  /** "Copia e cola" do Pix (EMV) — `null` só se a geração falhar antes de existir (não deveria acontecer no 201). */
  qrCodeString: string | null
  /** Base64 SEM o prefixo `data:image/...` — quem exibe monta o `data:` URL. */
  qrCodeImageBase64: string | null
  expiresAt: string | null
  paidAt: string | null
  createdAt: string
  /** Parte do `amountCents` que quitou `openDebtCents` automaticamente — 0 quando não havia dívida em aberto. */
  debtSettledCents: number
}

export type MeTopupErrorCode =
  | "TOPUP_AMOUNT_OUT_OF_RANGE"
  | "CPF_REQUIRED"
  | "INVALID_CPF"
  | "TOO_MANY_PENDING_TOPUPS"
  | "PAYMENT_GATEWAY_UNAVAILABLE"
  | "TOPUP_NOT_FOUND"

// ---------------------------------------------------------------------------
// Cartão salvo (F5.3, 2026-09-30) — D1 decidida pelo dono: cadastro único via
// Silent Order Post da Cielo, enquadramento PCI SAQ A-EP. O formulário de
// cartão vive num DOCUMENTO ISOLADO (`frontend/pagamento-cartao.html`, entry
// própria do Vite, CSP própria, zero script de terceiro fora da Cielo) — CSP
// vale por documento, uma SPA não isola nada. Ver
// `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` §2. Este app
// principal NUNCA recebe PAN/CVV — só o `cardToken` que o documento isolado
// devolve via postMessage (contrato em `types/cardTokenizationChannel.ts`).
// Bloco abaixo é o contrato LITERAL implementado pelo Vega em
// `backend/src/api/routes/mePaymentMethods.routes.ts` — reconciliado em
// paralelo (ver handoff da Lyra em PROGRESSO.md).
// ---------------------------------------------------------------------------

// ---- Cadastro de cartão (F5.3) — GET/POST/PATCH/DELETE /api/me/payment-methods ----

/**
 * Cartão salvo do motorista (D1 do dono: SAQ A-EP via Silent Order Post — o
 * número do cartão nunca passa pelo nosso backend). `id`/`brand`/`last4`/
 * etc. são só o suficiente para exibir/escolher o cartão; o token
 * tokenizado nunca é devolvido ao cliente.
 */
export interface MePaymentMethodDTO {
  id: string
  brand: string
  last4: string | null
  holderName: string | null
  expiryMonth: number | null
  expiryYear: number | null
  isDefault: boolean
  createdAt: string
}

// ---- GET /api/me/payment-methods ----
/**
 * I-7 (decisão do dono, 04/10/2026): pagar com CARTÃO exige identidade verificada (login com Google, ou conta de equipe) e some por um tempo se houver
 * recusas em excesso (suspeita de teste de cartões roubados). Pix e carteira NÃO são afetados. `eligible=false` -> a tela explica o motivo em vez de oferecer
 * "Adicionar cartão"/"Pagar com cartão"; o servidor também recusa (403 `CARD_REQUIRES_VERIFIED_IDENTITY` / 429 `CARD_TEMPORARILY_BLOCKED`).
 */
export type CardEligibilityReason =
  | "GOOGLE_LOGIN_REQUIRED"
  | "TEMPORARILY_BLOCKED"
  /** L1.8, DL7: o ADMIN registrou um chargeback deste motorista -> cartão bloqueado (Pix e carteira seguem; cartões salvos continuam na lista, sem uso). Vem ANTES de `GOOGLE_LOGIN_REQUIRED`; sem `blockedUntil`. O servidor também recusa com 403 `CARD_CHARGEBACK_BLOCKED` (cadastro, tokenização, iniciar sessão com CARD). */
  | "CHARGEBACK_BLOCKED"
export interface CardEligibility {
  eligible: boolean
  reason: CardEligibilityReason | null
  /** ISO — só quando `reason = "TEMPORARILY_BLOCKED"`. */
  blockedUntil: string | null
}
export interface MePaymentMethodsResponse {
  items: MePaymentMethodDTO[]
  cardEligibility: CardEligibility
}

// ---- POST /api/me/payment-methods/tokenization-session ----
/**
 * Dados para a página ISOLADA de tokenização carregar o script do Silent
 * Order Post da Cielo e tokenizar o cartão DIRETO no navegador do motorista
 * — o backend nunca vê o número do cartão. O app principal busca isto
 * autenticado (JWT normal) e repassa por `postMessage` para o documento
 * isolado — NUNCA por querystring (ver `types/cardTokenizationChannel.ts`
 * para o porquê). `scriptUrl` real ainda não foi confirmado pela Cielo
 * (pergunta em aberto, PROGRESSO.md §F5) — o `FakeAdapter` do backend e o
 * mock MSW do frontend devolvem cada um o seu marcador reconhecido só por
 * `pagamento-cartao/sopClient.ts` como "usar o mock local".
 */
export interface MeCardTokenizationSessionResponse {
  accessToken: string
  /** Opcional: o front NÃO usa (só o `accessToken` e o `scriptUrl` valem para o SOP). O backend deixa de devolvê-lo (S-9 da auditoria do Órion). */
  merchantId?: string
  environment: "sandbox" | "production"
  scriptUrl: string
  expiresAt: string
}

export type CardBrand = "Visa" | "Master" | "Elo" | "Amex" | "Hipercard" | "Diners"

// ---- POST /api/me/payment-methods -> 201 MePaymentMethodDTO ----
export interface MeCreatePaymentMethodRequest {
  /** CardToken PERMANENTE devolvido pelo Silent Order Post — nunca o PAN/CVV. */
  cardToken: string
  /** Detectado no documento isolado a partir do BIN do cartão (a sessão de tokenização não devolve bandeira) — ver `pagamento-cartao/cardBrand.ts`. */
  brand: CardBrand
  makeDefault?: boolean
  /** C1.3 (aditivo): últimos 4 dígitos, EXATAMENTE 4 dígitos - PAN TRUNCADO vindo da página isolada; nunca o número inteiro. O servidor deixou de depender de `GET /1/card/{token}`; os dados da Cielo, quando existem, prevalecem. */
  last4?: string
  /** 1..12. Vem junto com `expiryYear` (o servidor recusa um sem o outro). */
  expiryMonth?: number
  /** 4 dígitos. */
  expiryYear?: number
}

export type MePaymentMethodErrorCode =
  | "INVALID_CARD_TOKEN"
  | "CARD_VERIFICATION_FAILED"
  | "TOO_MANY_PAYMENT_METHODS"
  | "PAYMENT_METHOD_NOT_FOUND"
  | "PAYMENT_GATEWAY_UNAVAILABLE" // 503 — configuração do gateway ilegível (GET/POST) ou ambiente mudou durante a verificação do cartão (POST)
  | "CARD_REQUIRES_VERIFIED_IDENTITY" // 403 — I-7: cartão só com login Google (ou equipe); vale também em tokenization-session e ao iniciar sessão com paymentMode CARD
  | "CARD_TEMPORARILY_BLOCKED" // 429 (com `Retry-After`) — I-7: recusas em excesso; `details: { blockedUntil }`

// ---- PATCH /api/me/payment-methods/:id { isDefault: true } -> MePaymentMethodDTO ----
export interface MeUpdatePaymentMethodRequest {
  isDefault: true
}

// ---- DELETE /api/me/payment-methods/:id -> 204 (soft delete) ----

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
  // Lote 1 (L1.3/L1.4/L1.8) + F5: espelham o enum `AuditAction` do Prisma e o `auditActionEnum` do backend (sem eles, filtrar por esses valores dava 400).
  "PAYMENT_CREDIT",
  "PAYMENT_CONFIG_CHANGE",
  "PASSWORD_RESET",
  "ACCOUNT_DELETION",
  "REFUND",
  "CHARGEBACK",
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
  /** F5.9: `session.updated` = a sessão virou `STOP_UNCONFIRMED` ou foi reanimada; mesmo payload, o cliente invalida as mesmas chaves + o detalhe. */
  type: "session.started" | "session.stopped" | "session.updated"
  sessionId: string
  chargePointId: string
}

export interface WalletUpdatedEvent extends RealtimeEventBase {
  type: "wallet.updated"
  userId: string
  balanceCents: number
}

/**
 * PREPARADO, NÃO CONECTADO: o crédito Pix (F5.1) chega por webhook→worker
 * reconsultando a Cielo (`decisoes-f5-pagamento-cielo.md` item 3 — o webhook
 * é só uma dica, nunca verdade), e esse caminho ainda não existe no backend
 * real. O handler (`realtimeEventHandlers.ts`) e o tipo já existem para o dia
 * em que existir; até lá `useMeTopup` sobrevive sozinho por polling (mesmo
 * padrão de `MeCommandStatusResponse`/`useCommandStatus`) — nunca dependa só
 * deste evento para a tela de recarga Pix funcionar.
 */
export interface TopupUpdatedEvent extends RealtimeEventBase {
  type: "topup.updated"
  topupId: string
  status: MeTopupStatus
}

/**
 * `status` é o mesmo enum de `Connector.status` (`ConnectorStatus`), nunca um valor novo inventado para o evento.
 * Também chega a TODO motorista logado pelo canal público `ui:ev:stations` (mapa "perto de mim") —
 * por isso o payload é só o que já é público na resposta de `GET /api/sites`; nada sensível entra aqui.
 */
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
  | TopupUpdatedEvent
  | ChargePointStatusEvent
  | AdminEntityChangedEvent
  | DashboardDirtyEvent

// ============================================================================
// F5.5 — Configuração do gateway de pagamento (Cielo). ADMIN-ONLY.
// ============================================================================
// Contrato escrito e commitado PELO ATLAS antes da implementação (Vega e Lyra
// trabalham em paralelo contra este texto literal — não editem nem dupliquem:
// se faltar campo, avisem no handoff). A conta Cielo é ÚNICA da plataforma
// (decisão D2: a carteira é da rede), então só ADMIN vê e altera; OPERATOR não.
//
//   GET /api/admin/payment-gateway  -> PaymentGatewayConfigDTO
//   PUT /api/admin/payment-gateway  -> PaymentGatewayConfigDTO (já atualizado)
//
// SEGREDOS NUNCA VOLTAM: merchantKey, sopClientSecret e webhookHeaderSecret são
// só de ESCRITA; o GET devolve apenas `...Set: boolean`. Campo ausente no PUT =
// "não mexer". Não há "apagar segredo" nesta versão (só substituir).

export type PaymentGatewayEnvironment = "sandbox" | "production"

/** Pré-requisito que falta para um meio de pagamento funcionar. Códigos estáveis (a tela mapeia para texto em português). */
export type PaymentGatewayRequirement =
  | "MERCHANT_ID"
  | "MERCHANT_KEY"
  | "SOP_CLIENT_ID"
  | "SOP_CLIENT_SECRET"
  | "SOP_SCRIPT_URL" // só variável de ambiente do servidor — a tela não edita
  | "SOP_OAUTH_TOKEN_URL" // idem
  | "WEBHOOK_PATH_TOKEN" // idem (compõe `webhookUrl`)
  | "WEBHOOK_HEADER_SECRET"
  | "PAYMENT_SECRETS_KEY" // idem — sem ela o servidor não consegue cifrar/guardar os segredos acima

export interface PaymentMethodReadiness {
  /** `true` = todos os pré-requisitos presentes (independe de estar habilitado pelo admin). */
  ready: boolean
  missing: PaymentGatewayRequirement[]
}

// ---- POST /api/admin/payment-gateway/test-connection (C2.1) ----
// Sem corpo, ADMIN-only, SEM step-up (só LÊ). Credencial errada NÃO é erro HTTP: vem 200 com o status por passo. Erros HTTP: 401/403 (não admin),
// 429 `RATE_LIMITED_PAYMENT_GATEWAY` (6/min por ADMIN), 503 `PAYMENT_GATEWAY_UNAVAILABLE` (config ilegível). Nunca devolve segredo nem token.

export type PaymentGatewayTestStep = "MERCHANT_CREDENTIALS" | "SOP_OAUTH" | "SOP_ACCESS_TOKEN"

export type PaymentGatewayTestStatus =
  | "OK"
  | "CREDENTIAL_REJECTED" // inclui "credencial de OUTRO ambiente"
  | "IP_NOT_ALLOWED" // 403: IP de saída fora da lista de IPs confiáveis do Site Cielo - a credencial pode estar certa
  | "UNAVAILABLE" // 5xx, timeout, rede
  | "RATE_LIMITED"
  | "REQUEST_REFUSED" // a Cielo/Braspag recusou a NOSSA requisição por motivo que não parece credencial
  | "MISCONFIGURED" // ambiente x URLs incoerentes, ou segredo salvo que não decifra
  | "NOT_CONFIGURED" // falta credencial para este passo (não é falha)
  | "SKIPPED" // um passo anterior falhou (não é falha)

export interface PaymentGatewayTestStepResult {
  step: PaymentGatewayTestStep
  status: PaymentGatewayTestStatus
  /** Só o HOST contatado (público), sem caminho nem query. */
  host: string | null
  httpStatus: number | null
  durationMs: number
  /** PT-BR, pronta para o admin; nunca contém segredo, token nem corpo cru da Cielo. */
  message: string
}

export interface PaymentGatewayTestResult {
  environment: PaymentGatewayEnvironment
  testedAt: string
  /** `true` só se algum passo deu OK e NENHUM falhou (NOT_CONFIGURED/SKIPPED não são falha, mas sozinhos não bastam). */
  ok: boolean
  /** Sempre 3 itens, nesta ordem: MERCHANT_CREDENTIALS, SOP_OAUTH, SOP_ACCESS_TOKEN. */
  steps: PaymentGatewayTestStepResult[]
}

export interface PaymentGatewayConfigDTO {
  /**
   * De onde vêm os valores efetivos. `"database"` = existe configuração salva pelo admin (ela manda).
   * `"env"` = nada salvo ainda: vale o ambiente do servidor (comportamento anterior à F5.5), e a tela
   * deve avisar que salvar passa a valer o que foi salvo aqui.
   */
  source: "database" | "env"
  environment: PaymentGatewayEnvironment
  merchantId: string | null
  merchantKeySet: boolean
  sopClientId: string | null
  sopClientSecretSet: boolean
  webhookHeaderSecretSet: boolean
  /** URL que o dono cadastra no Site Cielo (somente leitura). `null` se o token de caminho do webhook ainda não está configurado no servidor. */
  webhookUrl: string | null
  /** Nome do header que a Cielo deve enviar com o segredo (constante do servidor, somente leitura). */
  webhookHeaderName: string
  /**
   * `true` só se o webhook está configurado por inteiro (token do caminho no servidor + segredo do header). `false` = "webhook não usado": o Pix é creditado por consulta periódica
   * (polling). NÃO é erro nem pendência - conta Cielo COMPARTILHADA com o Parque não tem URL de notificação do InnoFlow, e `readiness.pix.missing` não lista mais os códigos de webhook.
   * Opcional no tipo só para tolerar servidor antigo (ausente = comportamento antigo).
   */
  webhookInUse?: boolean
  cardEnabled: boolean
  pixEnabled: boolean
  readiness: { card: PaymentMethodReadiness; pix: PaymentMethodReadiness }
  /**
   * `true` = todos os segredos salvos no banco foram lidos e decifrados agora; `false` = ao menos um NÃO decifra
   * (chave `PAYMENT_SECRETS_KEY` trocada/perdida ou dado corrompido) e o gateway está em 503 — a tela deve alertar
   * mesmo que os chips digam "Configurada". `null` = não há segredo salvo no banco (`source: "env"` ou nada gravado).
   */
  secretsDecryptable: boolean | null
  /**
   * `true` = ambiente efetivo é SANDBOX em servidor de PRODUÇÃO (`NODE_ENV=production`): os cartões de teste da Cielo
   * são públicos, então Pix e cartão só funcionam para os e-mails da lista de testadores do servidor
   * (`PAYMENT_SANDBOX_TESTER_EMAILS`); os demais motoristas recebem `PAYMENT_METHOD_DISABLED` com
   * `reason: "SANDBOX_RESTRICTED"`. A tela deve mostrar um aviso permanente.
   */
  sandboxRestricted: boolean
  /** `null` quando `source === "env"` (nada salvo). */
  updatedAt: string | null
}

export interface UpdatePaymentGatewayConfigRequest {
  environment?: PaymentGatewayEnvironment
  merchantId?: string
  /** Só escrita. */
  merchantKey?: string
  sopClientId?: string
  /** Só escrita. */
  sopClientSecret?: string
  /** Só escrita. Mínimo de 32 caracteres (o servidor exige desde a F5.7; o gerador da tela faz 40). */
  webhookHeaderSecret?: string
  cardEnabled?: boolean
  pixEnabled?: boolean
  /**
   * OBRIGATÓRIO como `true` quando o PUT muda `environment` de "sandbox" para "production"
   * (a tela pede confirmação digitada e envia isto). Ausente nesse caso => 400
   * `PRODUCTION_CONFIRMATION_REQUIRED`.
   */
  confirmProduction?: true
  /**
   * OBRIGATÓRIO em TODO PUT (step-up): a senha ATUAL do ADMIN logado. Quem rouba um token de 12 h não consegue
   * redirecionar o dinheiro para outra conta Cielo sem saber a senha. Ausente => 400 `VALIDATION_ERROR`; errada =>
   * 403 `INVALID_CURRENT_PASSWORD` (403 e NÃO 401, para o interceptor não deslogar). Nunca é logada nem auditada.
   */
  currentPassword: string
}

export type PaymentGatewayConfigErrorCode =
  | "VALIDATION_ERROR" // 400
  | "PRODUCTION_CONFIRMATION_REQUIRED" // 400 — mudou para production sem `confirmProduction: true`
  | "GATEWAY_NOT_READY" // 409 — `environment: production` (ou habilitar um meio) com pré-requisito faltando; `details` é um ARRAY DE STRINGS com os `PaymentGatewayRequirement` (ordem estável) — diferente dos outros `details` da API, que são objetos
  | "PAYMENT_SECRETS_KEY_MISSING" // 503 — servidor sem chave de cifragem: não aceita gravar segredos (só quando o body TEM segredo; salvar só `merchantId` passa)
  | "FORBIDDEN" // 403 — só ADMIN
  | "UNAUTHORIZED" // 401 — sem sessão válida
  | "RATE_LIMITED" // 429 — limite geral da API admin
  | "RATE_LIMITED_PAYMENT_GATEWAY" // 429 (com `Retry-After`) — PUT: 10 por minuto por usuário; TAMBÉM quando 5 senhas atuais erradas em 15 min trancam o step-up (60 s, dobrando até 15 min), inclusive com a senha certa
  | "PAYMENT_GATEWAY_UNAVAILABLE" // 503 — GET/PUT com a configuração ilegível (banco fora, segredo que não decifra): fail-closed
  | "INTERNAL_ERROR" // 500 — a auditoria falhou: NADA foi gravado (fail-closed); pode tentar de novo
  | "INVALID_CURRENT_PASSWORD" // 403 — step-up: a senha atual informada está errada (conta o limite de tentativas)
  | "GATEWAY_HAS_INFLIGHT_PAYMENTS" // 409 — trocar `environment` com pagamentos em trânsito (CREATED/AUTHORIZED/PENDING/CAPTURE_PENDING) do ambiente atual; `details: { count }`; aguarde liquidarem
  | "STEPUP_UNAVAILABLE" // 503 — step-up: o Redis do throttle de senha está fora; o servidor NÃO tentou a senha nem gravou nada (fail-closed). Sem `Retry-After`. Tela: "tente de novo", rascunho mantido, SEM deslogar

/**
 * Regras do PUT que a tela precisa respeitar (comportamento real do servidor, F5.5):
 * - PARES de credenciais andam juntos: `merchantId`+`merchantKey` e `sopClientId`+`sopClientSecret`. Se o par
 *   ainda vem do env (`source: "env"`) ou não há chave salva e a tela envia só um lado => 409 `GATEWAY_NOT_READY`
 *   com a metade que falta. Ao trocar o `merchantId`, a tela deve exigir reenviar a chave nesses casos.
 * - Na 1ª gravação (`source: "env"`) a linha nasce semeada com o ambiente atual (`CIELO_SANDBOX`) e flags =
 *   "há credenciais no env": salvar uma flag qualquer NÃO desliga o que já funcionava pelo env.
 * - Desabilitar um meio NUNCA dá 409 de prontidão; habilitar sem pré-requisito dá. Editar campo alheio de um meio
 *   já habilitado e quebrado também não é bloqueado.
 * - `confirmProduction` só é exigido na mudança sandbox -> production (não se já está em production).
 * - PUT `{}` ou só `{ confirmProduction: true }` => 400; campo desconhecido => 400 (strict); strings são aparadas.
 * - `webhookUrl` carrega o token de caminho do webhook: só ADMIN deve ver.
 */

/**
 * `PAYMENT_METHOD_DISABLED` (409) tem DOIS sentidos nas rotas do motorista — a tela deve ramificar por
 * `details[0].reason`:
 * - sem `details` (ou sem `reason`): o CARTÃO escolhido foi removido/desativado pelo próprio motorista -> pedir outro cartão;
 * - `reason: "SANDBOX_RESTRICTED"`: servidor de produção em ambiente SANDBOX e este motorista não está na lista de testadores — mesma
 *   mensagem de "indisponível no momento" (não revele o motivo);
 * - `details: [{ method: "CARD" | "PIX", reason: "GATEWAY_DISABLED" }]`: o ADMIN desligou esse meio de pagamento na
 *   configuração do gateway -> esconder/avisar "indisponível no momento", NÃO pedir "escolha outro cartão".
 * Rotas afetadas: `POST /api/me/payment-methods/tokenization-session`, `POST /api/me/payment-methods`,
 * `POST /api/me/sessions/start` (modo CARD) e `POST /api/me/wallet/topups` (Pix).
 */
export interface PaymentMethodDisabledDetail {
  method: "CARD" | "PIX"
  reason: "GATEWAY_DISABLED" | "SANDBOX_RESTRICTED"
}

// ============================================================================
// LOTE 1 DA F6 (Vega-B, 06/10/2026) — contrato literal de L1.2 a L1.9.
//
// Fonte: docs/PLANO-FUNCIONALIDADES.md §2, com as decisões do dono DL1-DL8 JÁ ACEITAS (05/10/2026).
// Legenda de estado de cada bloco:
//   "IMPLEMENTADO (L1.x)"  = a rota existe no backend e este tipo é o contrato real.
//   "planejado (L1.x)"     = a rota AINDA NÃO existe; o formato é o combinado e pode ser consumido por mocks, mas nenhum cliente deve
//                            depender dele em produção até o backend marcar como implementado aqui.
// Regras que valem para TODAS as rotas /api/me/*: nenhum `userId` vem de body/query/param (sempre o do token); o corpo é `.strict()` (campo desconhecido = 400).
// Erro = `ApiErrorBody` (`{ error, code, details? }`) — sempre trate por `code`, nunca pelo texto.
// ============================================================================

// ---- L1.2 — Perfil do motorista: GET/PATCH /api/me/profile (DRIVER) — IMPLEMENTADO (L1.2) ------------------------------------------------------------

/**
 * `GET /api/me/profile` -> 200 `MeProfile`. `cpfMasked` = `***.456.789-**` (o CPF inteiro só sai na exportação LGPD, L1.4); `null` se não informado.
 * `identityVerified` = a mesma regra do I-7 (login com Google vinculado) que libera o cartão. `googleLinked` = há Google vinculado à conta.
 * `hasPassword=false` = conta só-Google (a tela mostra "Definir senha", sem campo de senha atual — ver `ChangePasswordRequest`).
 */
export interface MeProfile {
  id: string
  name: string
  email: string
  phone: string | null
  cpfMasked: string | null
  hasPassword: boolean
  googleLinked: boolean
  identityVerified: boolean
  /** ISO. */
  createdAt: string
}

/**
 * `PATCH /api/me/profile` -> 200 `MeProfile` (o DTO já atualizado). Corpo `.strict()`, ao menos UM campo. O **e-mail NÃO é editável** neste lote (a troca exige
 * verificação no endereço novo — F7). Campos:
 * - `name`: 1 a 120 caracteres (após trim).
 * - `phone`: 8 a 30 caracteres entre dígitos, espaço, `+`, `(`, `)` e `-`; `null` apaga.
 * - `cpf`: com ou sem pontuação (o servidor guarda só os 11 dígitos); precisa passar no dígito verificador; `null` apaga.
 * Erros: 400 `VALIDATION_ERROR` (por campo, em `details[].path`), 409 `CPF_IN_USE` (CPF já é de outra conta), 429 `RATE_LIMITED_PROFILE`, 401, 403 (não é DRIVER).
 * A mudança é auditada (só os NOMES dos campos alterados — nunca os valores: são dado pessoal).
 */
export interface UpdateMeProfileRequest {
  name?: string
  phone?: string | null
  cpf?: string | null
}
export type MeProfileErrorCode = "VALIDATION_ERROR" | "CPF_IN_USE" | "RATE_LIMITED_PROFILE" | "UNAUTHORIZED" | "FORBIDDEN"

// ---- L1.3 — Esqueci / redefinição de senha — entregue (backend 1996aad) ----------------------------------------------------------------------------------------

/**
 * `POST /api/auth/password/forgot` (sem auth) -> **SEMPRE 202 `{ ok: true }`** — exista ou não a conta, ativa ou não, de qualquer papel (não vira oráculo de
 * e-mails nem de papéis). O envio é assíncrono (fila), nunca inline. DL1: o e-mail com o link só é enviado para DRIVER e OPERATOR; **ADMIN NÃO recebe**
 * (troca de senha de ADMIN só pelo script `user:set-password`) — mesmo assim a resposta é a mesma 202. Conta só-Google recebe um aviso "sua conta entra com
 * o Google" SEM token. Erros: 400 `VALIDATION_ERROR` (e-mail malformado), 429 `RATE_LIMITED_AUTH` (por IP; o limite por e-mail é silencioso).
 */
export interface ForgotPasswordRequest {
  email: string
}
export interface ForgotPasswordResponse {
  ok: true
}

/**
 * `POST /api/auth/password/reset` (sem auth) -> 204 sem corpo. O token vem no CORPO (o link do e-mail o carrega no FRAGMENTO:
 * `https://<app>/redefinir-senha#t=<token>` — a tela lê `location.hash` e apaga o fragmento; nunca na querystring). `newPassword`: 10 a 72 bytes.
 * Efeito: troca a senha e derruba TODAS as sessões (inclusive SSE); **não há auto-login** — depois do 204 a tela manda para `/login`.
 * Erros: 400 `VALIDATION_ERROR`, 400 `RESET_TOKEN_INVALID` (UM código só para token expirado/usado/inexistente/conta que não pode redefinir), 429 `RATE_LIMITED_AUTH`.
 */
export interface ResetPasswordRequest {
  token: string
  newPassword: string
}
/**
 * 429 `RATE_LIMITED_AUTH` traz `Retry-After` (segundos) — mas o CORS do backend não expõe esse header (sem `exposedHeaders`): só é legível com o mesmo domínio (nginx na frente).
 * 503 `SERVICE_UNAVAILABLE`: o serviço de redefinição está sem o Redis/estado que precisa (fail-closed) — o token NÃO é gasto; tentar de novo vale.
 * 400 `VALIDATION_ERROR` com `details[].path="newPassword"` (10 a 72 bytes): o token NÃO é gasto — a tela mantém o formulário.
 */
export type ResetPasswordErrorCode = "VALIDATION_ERROR" | "RESET_TOKEN_INVALID" | "RATE_LIMITED_AUTH" | "SERVICE_UNAVAILABLE"

// ---- L1.4 — LGPD: exportação e exclusão de conta — IMPLEMENTADO (L1.4; backend dd1e5b8 exportação, 52897ec exclusão) ------------------------------------------------

/**
 * `GET /api/me/data-export` -> 200 `application/json` com `Content-Disposition: attachment; filename="innoflow-meus-dados-AAAAMMDD.json"`. Síncrono.
 * 3 exportações por dia por usuário (429 `RATE_LIMITED_EXPORT`). Gera auditoria `EXPORT`. NUNCA contém token/ciphertext de cartão, `passwordHash` nem `googleSub`.
 * Os blocos abaixo são o mínimo prometido; o backend pode acrescentar campos (a tela só oferece o download, não renderiza o conteúdo).
 */
export interface MeDataExport {
  /** ISO. */
  exportedAt: string
  /** Aqui (e só aqui) o CPF sai INTEIRO — é dado do próprio titular. */
  profile: { id: string; name: string; email: string; phone: string | null; cpf: string | null; createdAt: string }
  consents: Array<{ kind: string; version: string; acceptedAt: string }>
  sessions: unknown[]
  walletEntries: unknown[]
  topups: unknown[]
  /** Bandeira/final/validade/titular — nunca token. */
  paymentMethods: Array<{ brand: string; last4: string; expiry: string; holderName: string | null }>
  /** `idTag` mascarado. */
  authTokens: Array<{ idTagMasked: string; type: AuthTokenType; status: AuthTokenStatus }>
  notifications: unknown[]
}

/**
 * `POST /api/me/account/deletion` -> 200 `MeAccountDeletionResponse`. ANONIMIZAÇÃO (não DELETE): a pessoa some, o registro financeiro fica sob um id
 * pseudônimo. Reautenticação OBRIGATÓRIA: conta com senha manda `currentPassword`; conta só-Google manda `googleCredential` (ID token, mesmo formato de
 * `GoogleAuthRequest.credential`). `confirmation` é o literal `"EXCLUIR"`.
 * - DL2: **saldo positivo NÃO bloqueia** — a conta é excluída e o saldo vira devolução MANUAL por Pix (o ADMIN registra `TOPUP_REFUND`). Com saldo > 0 o
 *   corpo precisa de `refundPixKey` (senão 400 `REFUND_PIX_KEY_REQUIRED`) e a resposta é `DELETED_PENDING_REFUND`; sem saldo, `DELETED`.
 * - DL3: **dívida aberta BLOQUEIA** até quitar -> 409 `OPEN_DEBT`.
 * Erros: 400 `VALIDATION_ERROR`, 400 `CURRENT_PASSWORD_REQUIRED`, 400 `REFUND_PIX_KEY_REQUIRED`, 403 `INVALID_CURRENT_PASSWORD`, 401 `INVALID_GOOGLE_TOKEN`,
 * 409 `ACTIVE_SESSION` (inclui sessão `STOP_UNCONFIRMED`), 409 `PAYMENT_IN_PROGRESS` (cartão autorizado/captura pendente/Pix pendente), 409 `OPEN_DEBT`,
 * 429 `RATE_LIMITED_ACCOUNT_DELETION`. Depois de `DELETED*` o token atual deixa de valer (a tela volta ao login).
 */
export interface MeAccountDeletionRequest {
  confirmation: "EXCLUIR"
  currentPassword?: string
  googleCredential?: string
  /** Chave Pix para a devolução do saldo (só é lida se houver saldo positivo). Guardada cifrada; apagada quando o ADMIN registrar o reembolso. */
  refundPixKey?: string
}
export interface MeAccountDeletionResponse {
  status: "DELETED" | "DELETED_PENDING_REFUND"
}
export type MeAccountDeletionErrorCode =
  | "VALIDATION_ERROR"
  | "CURRENT_PASSWORD_REQUIRED"
  | "REFUND_PIX_KEY_REQUIRED"
  | "INVALID_CURRENT_PASSWORD"
  | "INVALID_GOOGLE_TOKEN"
  | "ACTIVE_SESSION"
  | "PAYMENT_IN_PROGRESS"
  | "OPEN_DEBT"
  | "RATE_LIMITED_ACCOUNT_DELETION"
  // Acrescentados com o backend real (nada renomeado): 503 sem a chave de cifragem do cofre (a chave Pix não pode ser guardada), 503 do throttle da senha fora do ar
  // (fail-closed, nada é tentado), 503 Google sem Client ID no servidor, 403 conta sem como se reautenticar / não é DRIVER, 401 sessão inválida.
  | "PAYMENT_SECRETS_KEY_MISSING"
  | "STEPUP_UNAVAILABLE"
  | "GOOGLE_NOT_CONFIGURED"
  | "FORBIDDEN"
  | "UNAUTHORIZED"

/**
 * `GET /api/me/data-export` - erros (a rota só existe para DRIVER): 429 `RATE_LIMITED_EXPORT` (3 por dia; traz `Retry-After`, mas o CORS não o expõe fora do mesmo domínio),
 * 401 sessão inválida, 403 não é DRIVER, 5xx. A resposta de sucesso é o arquivo `MeDataExport` (a tela baixa, não renderiza).
 */
export type MeDataExportErrorCode = "RATE_LIMITED_EXPORT" | "UNAUTHORIZED" | "FORBIDDEN"

/** Estado da devolução do saldo de uma conta excluída (DL2). */
export type AccountDeletionRefundStatus = "NOT_REQUIRED" | "PENDING_REFUND" | "REFUNDED"

/**
 * `GET /api/admin/account-deletions?status=PENDING_REFUND&page&pageSize` (ADMIN-only) -> `PaginatedResponse<AdminAccountDeletionRow>`. `refundPixKey` é a chave que
 * o motorista informou (decifrada só para o ADMIN fazer o Pix); some (`null`) depois de `REFUNDED`.
 */
export interface AdminAccountDeletionRow {
  id: string
  /** Id pseudônimo (o usuário já foi anonimizado). */
  userId: string
  /** ISO. */
  requestedAt: string
  balanceCentsAtRequest: number
  refundStatus: AccountDeletionRefundStatus
  refundPixKey: string | null
  refundedAt: string | null
  refundedByUserId: string | null
  /** Aditivo (L1.4, entregue): idade do pedido em dias. */
  ageDays: number
  /** Aditivo: `true` quando passou do prazo recomendado de 30 dias e ainda é `PENDING_REFUND`. */
  overdue: boolean
  /** Aditivo: só presente (`true`) quando a chave guardada NÃO pôde ser decifrada (`PAYMENT_SECRETS_KEY` trocada/ausente) — `refundPixKey` vem `null`; falar com o titular por outro canal. */
  refundPixKeyUnreadable?: true
}
export interface AdminAccountDeletionsQuery extends PaginationParams {
  status?: AccountDeletionRefundStatus
}

/**
 * `POST /api/admin/account-deletions/:id/refund` (ADMIN-only, step-up por senha) -> 200 `AdminAccountDeletionRow`. O ADMIN fez o Pix por fora e registra aqui:
 * lança `WalletEntry TOPUP_REFUND` e apaga a chave Pix guardada. Erros: 400 `VALIDATION_ERROR`, 403 `INVALID_CURRENT_PASSWORD`, 404 `NOT_FOUND`,
 * 409 `ALREADY_REFUNDED`, 409 `AMOUNT_EXCEEDS_BALANCE` (`amountCents` > saldo no pedido).
 */
export interface AdminAccountDeletionRefundRequest {
  amountCents: number
  /** Comprovante/identificador do Pix feito por fora (texto livre, 1 a 120). */
  proofReference: string
  currentPassword: string
}
/**
 * Erros de `GET/POST /api/admin/account-deletions*` (entregue, L1.4). A devolução é INTEGRAL: valor menor = 409 `PARTIAL_REFUND_NOT_ALLOWED`; maior = 409 `AMOUNT_EXCEEDS_BALANCE`;
 * pedido sem saldo = 409 `REFUND_NOT_REQUIRED`; já devolvido = 409 `ALREADY_REFUNDED`. Senha: 403 `INVALID_CURRENT_PASSWORD`, 429 `RATE_LIMITED_ACCOUNT_DELETION` (+ `Retry-After`),
 * 503 `STEPUP_UNAVAILABLE` (nada gravado). `PAYMENT_SECRETS_KEY_MISSING` (503) = o servidor não tem a chave de cifragem.
 */
export type AdminAccountDeletionErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_CURRENT_PASSWORD"
  | "NOT_FOUND"
  | "ALREADY_REFUNDED"
  | "REFUND_NOT_REQUIRED"
  | "AMOUNT_EXCEEDS_BALANCE"
  | "PARTIAL_REFUND_NOT_ALLOWED"
  | "PAYMENT_SECRETS_KEY_MISSING"
  | "STEPUP_UNAVAILABLE"
  | "RATE_LIMITED_ACCOUNT_DELETION"

// ---- L1.6 — Notificações ao motorista (e-mail) — planejado (L1.6) ------------------------------------------------------------------------------------

export const NOTIFICATION_TYPES = [
  "SESSION_COMPLETED",
  "SESSION_PAYMENT_FAILED",
  "SESSION_CLOSED_BY_SERVER",
  "LOW_BALANCE",
  "TOPUP_CREDITED",
  "REMOTE_START_BY_SUPPORT",
  "PASSWORD_CHANGED",
  "ACCOUNT_DELETED",
] as const
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/**
 * DL5: e-mails de SEGURANÇA e de COBRANÇA são SEMPRE enviados e não têm chave de desligar (`PASSWORD_CHANGED`, `SESSION_PAYMENT_FAILED`, `ACCOUNT_DELETED`) — a tela
 * os mostra como "sempre ativos", sem interruptor. Recibo e saldo baixo são opcionais e vêm LIGADOS por padrão, com limiar de R$ 20,00 (2000 centavos).
 */
export const ALWAYS_ON_NOTIFICATION_TYPES = ["PASSWORD_CHANGED", "SESSION_PAYMENT_FAILED", "ACCOUNT_DELETED"] as const satisfies readonly NotificationType[]
export const LOW_BALANCE_THRESHOLD_MIN_CENTS = 500
export const LOW_BALANCE_THRESHOLD_MAX_CENTS = 50000
export const LOW_BALANCE_THRESHOLD_DEFAULT_CENTS = 2000

/** `GET /api/me/notification-preferences` -> 200. Defaults: `{ sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: 2000 }`. */
export interface MeNotificationPreferences {
  sessionReceiptEmail: boolean
  lowBalanceEnabled: boolean
  /** 500 a 50000 (R$ 5,00 a R$ 500,00). */
  lowBalanceThresholdCents: number
}
/**
 * `PATCH /api/me/notification-preferences` -> 200 `MeNotificationPreferences`. `.strict()`, ao menos um campo. Erros: 400 `VALIDATION_ERROR` (limiar fora de 500-50000
 * ou campo desconhecido — inclusive qualquer tentativa de desligar segurança/cobrança), 429.
 */
export type UpdateMeNotificationPreferencesRequest = Partial<MeNotificationPreferences>

// ---- L1.8 — Estorno e chargeback (fluxo manual assistido) — planejado (L1.8) -------------------------------------------------------------------------

/**
 * DL8: neste lote NÃO há chamada de estorno por API da Cielo. Estorno de sessão paga com carteira = crédito interno imediato; paga com cartão = (a) crédito na
 * carteira, ou (b) devolução feita pelo dono NO PORTAL DA CIELO e registrada aqui (`CARD_VIA_PORTAL`, fica `PENDING_CONFIRMATION` até a confirmação).
 */
export type RefundDestination = "WALLET" | "CARD_VIA_PORTAL"
export type RefundStatus = "CONFIRMED" | "PENDING_CONFIRMATION" | "CANCELLED"

/**
 * `POST /api/admin/sessions/:id/refunds` (ADMIN-only, step-up por senha) -> 201 `CreateSessionRefundResponse`. Erros: 400 `VALIDATION_ERROR`,
 * 403 `INVALID_CURRENT_PASSWORD`, 404 `SESSION_NOT_FOUND`, 409 `AMOUNT_EXCEEDS_REFUNDABLE` (soma dos estornos > valor cobrado — também sob requisições
 * concorrentes), 409 `SESSION_NOT_BILLED`.
 */
export interface CreateSessionRefundRequest {
  amountCents: number
  reason: string
  destination: RefundDestination
  /** Referência da devolução no portal da Cielo (só em `CARD_VIA_PORTAL`). */
  portalReference?: string
  currentPassword: string
}
export interface CreateSessionRefundResponse {
  refundId: string
  status: RefundStatus
}
export type SessionRefundErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_CURRENT_PASSWORD"
  | "SESSION_NOT_FOUND"
  | "AMOUNT_EXCEEDS_REFUNDABLE"
  | "SESSION_NOT_BILLED"
  /** 409 — `CARD_VIA_PORTAL` numa sessão que não foi paga com cartão (não há venda na Cielo para devolver). */
  | "NO_CARD_PAYMENT"
  /** 409 — `WALLET` e a conta do motorista foi excluída (LGPD): não há carteira para receber. */
  | "DRIVER_ACCOUNT_DELETED"
  /** 409 — `cancel` de devolução que não é do cartão pendente (confirmada, já cancelada ou na carteira). */
  | "REFUND_NOT_CANCELLABLE"
  /** 409 — `confirm` de devolução que não é do cartão pendente (outro ADMIN/job chegou antes, cancelada ou na carteira). */
  | "REFUND_NOT_CONFIRMABLE"
  | "STEPUP_UNAVAILABLE"
  | "RATE_LIMITED"

/**
 * `GET /api/admin/sessions/:id/refunds` (ADMIN-only, ADITIVA, entregue) -> 200. Só ADMIN (OPERATOR = 403). Sessão não encerrada devolve `billedCents`/`refundableCents` = 0.
 * `refundedCents` soma os estornos NÃO cancelados (pendentes no portal seguram o teto). Sem nome/e-mail do motorista: só ids.
 */
export interface SessionRefundDTO {
  id: string
  sessionId: string
  paymentIntentId: string | null
  destination: RefundDestination
  status: RefundStatus
  amountCents: number
  /** Texto livre do ADMIN (10 a 500, sem nome do motorista). */
  reason: string
  /** No cartão confirmado à mão: a referência do COMPROVANTE do portal; antes disso, a referência do registro (se houve). */
  portalReference: string | null
  /** `true` = um ADMIN confirmou à mão; `false` = o job confirmou sozinho, está pendente/cancelado ou é carteira. */
  confirmedManually: boolean
  walletEntryId: string | null
  createdAt: string
  resolvedAt: string | null
}
export interface SessionRefundsResponse {
  sessionId: string
  billedCents: number
  refundedCents: number
  refundableCents: number
  items: SessionRefundDTO[]
}

/** `POST /api/admin/refunds/:id/cancel` `{ currentPassword }` -> 200. Só devolução no cartão `PENDING_CONFIRMATION`; libera o teto. Erros: 403 `INVALID_CURRENT_PASSWORD`, 404 `NOT_FOUND`, 409 `REFUND_NOT_CANCELLABLE`. */
export interface CancelRefundRequest {
  currentPassword: string
}
export interface CancelRefundResponse {
  refundId: string
  status: "CANCELLED"
}

/**
 * `POST /api/admin/refunds/:id/confirm` (ADMIN-only, step-up) -> 200. Confirmação MANUAL de uma devolução no cartão pendente (estorno parcial ou venda com mais de ~3 meses, que o job
 * nunca confirma). `proofReference`: 5 a 120, só letras/números e `. _ - / # :` (sem espaço nem e-mail; recusa CPF com máscara e número de cartão). 409 `REFUND_NOT_CONFIRMABLE`.
 */
export interface ConfirmRefundRequest {
  proofReference: string
  currentPassword: string
}
export interface ConfirmRefundResponse {
  refundId: string
  status: "CONFIRMED"
  confirmedManually: true
  proofReference: string
}

export type ChargebackOutcome = "WON" | "LOST" | "ACCEPTED"

/**
 * `POST /api/admin/payments/:intentId/chargebacks` (ADMIN-only) -> 201 `CreateChargebackResponse`. REGISTRAR o chargeback já BLOQUEIA o modo cartão do motorista
 * (`CardEligibilityReason = "CHARGEBACK_BLOCKED"`; Pix e carteira seguem) e tira um snapshot do dossiê. A conciliação não muda (estorno/chargeback são informativos).
 * Erros: 400 `VALIDATION_ERROR`, 404 `PAYMENT_NOT_FOUND`, 409 `CHARGEBACK_ALREADY_REGISTERED`.
 */
export interface CreateChargebackRequest {
  amountCents: number
  /** ISO — quando a Cielo avisou o dono. */
  notifiedAt: string
  caseReference: string
  reasonCode?: string
  /** ISO. */
  responseDeadline?: string
}
export interface CreateChargebackResponse {
  chargebackId: string
  dossierId: string
}

/**
 * DL7: chargeback PERDIDO (`LOST`/`ACCEPTED`) = a plataforma ABSORVE e o motorista fica sem o modo cartão. Dívida só por ação MANUAL do ADMIN:
 * `debtPolicy` omitido ou `"ABSORB"` = não cria dívida; `"CREATE_DEBT"` = o ADMIN decide, no caso concreto, cobrar o motorista. `WON` = devolve o modo cartão.
 * `PATCH /api/admin/chargebacks/:id` (ADMIN-only, step-up) -> 200 `ChargebackDTO`. Erros: 400, 403 `INVALID_CURRENT_PASSWORD`, 404 `NOT_FOUND`,
 * 409 `CHARGEBACK_ALREADY_RESOLVED`.
 */
export interface UpdateChargebackRequest {
  outcome: ChargebackOutcome
  debtPolicy?: "CREATE_DEBT" | "ABSORB"
  currentPassword: string
}
export interface ChargebackDTO {
  id: string
  paymentIntentId: string
  amountCents: number
  caseReference: string
  outcome: ChargebackOutcome | null
  notifiedAt: string
  responseDeadline: string | null
  dossierId: string
  // ---- aditivos (entregues, L1.8) ----
  chargingSessionId: string | null
  reasonCode: string | null
  /** Estado bruto: `OPEN` enquanto não há desfecho (`outcome` é `null`). */
  status: ChargebackStatus
  /** Dívida criada pelo desfecho `CREATE_DEBT` (se houve). */
  debtId: string | null
  createdAt: string
  resolvedAt: string | null
  /** O motorista está sem o modo cartão POR ESTE chargeback agora (aberto, ou perdido/aceito ainda não desbloqueado). */
  cardBlocked: boolean
  /** Desbloqueio manual (P3): quando e por quê (texto do ADMIN, só na tela do ADMIN). `null` enquanto não houve. */
  cardUnblockedAt: string | null
  cardUnblockReason: string | null
}
export type ChargebackStatus = "OPEN" | ChargebackOutcome

/** `GET /api/admin/chargebacks?outcome=&paymentIntentId=&page=&pageSize=` (ADMIN-only, ADITIVA) -> 200 `{ items, total, page, pageSize }` (NÃO `meta`). Mais recentes primeiro. */
export interface ChargebacksListQuery extends PaginationParams {
  outcome?: ChargebackStatus
  paymentIntentId?: string
}
export interface ChargebacksListResponse {
  items: ChargebackDTO[]
  total: number
  page: number
  pageSize: number
}

/**
 * `POST /api/admin/chargebacks/:id/unblock-card` (ADMIN-only, step-up, ADITIVA) -> 200 `ChargebackDTO`. Só em `LOST`/`ACCEPTED` com o cartão ainda bloqueado; devolve o modo cartão sem
 * apagar nada (registro, desfecho, dossiê e dívida ficam). Erros: 400, 403 `INVALID_CURRENT_PASSWORD`, 404 `NOT_FOUND`, 409 `CHARGEBACK_NOT_LOST`, 409 `CARD_ALREADY_UNBLOCKED`.
 */
export interface UnblockCardRequest {
  /** 10 a 500, sem nome do motorista (o texto fica gravado). */
  reason: string
  currentPassword: string
}

/** Erros das rotas de chargeback (registro, desfecho, desbloqueio, dossiê). */
export type ChargebackErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_CURRENT_PASSWORD"
  | "NOT_FOUND"
  | "PAYMENT_NOT_FOUND"
  /** 409 — a venda não tem valor capturado: não há o que contestar. */
  | "PAYMENT_NOT_CAPTURED"
  | "CHARGEBACK_ALREADY_REGISTERED"
  | "CHARGEBACK_ALREADY_RESOLVED"
  | "CHARGEBACK_NOT_LOST"
  | "CARD_ALREADY_UNBLOCKED"
  | "STEPUP_UNAVAILABLE"
  | "RATE_LIMITED"

/** Recusa DO MOTORISTA ao tentar pagar com cartão com chargeback ativo: 403 `CARD_CHARGEBACK_BLOCKED` (Pix e carteira seguem). Documentado aqui; quem trata é o PWA. */
export type CardChargebackBlockedCode = "CARD_CHARGEBACK_BLOCKED"
/** `GET /api/admin/chargebacks/:id/dossier` (ADMIN-only) -> JSON do snapshot (formato aberto; a Lyra só oferece o download). */
export type ChargebackDossier = Record<string, unknown>

// ---- L1.9 — Termos de uso, privacidade, aceite e contato — IMPLEMENTADO (L1.9; backend 40fb2ec) ---------------------------------------------------------------

/** `GET /api/public/legal` (sem auth) -> 200. Os dados da empresa dependem do dono (CNPJ, e-mail de suporte, encarregado/DPO) — podem vir `null` até ele mandar. */
export interface PublicLegalConfig {
  termsVersion: string
  privacyVersion: string
  company: {
    name: string | null
    cnpj: string | null
    supportEmail: string | null
    supportPhone: string | null
    dpoEmail: string | null
  }
}

/**
 * `POST /api/auth/register` e `POST /api/auth/google` passarão a exigir `acceptedTermsVersion` (= `PublicLegalConfig.termsVersion` vigente). Versão diferente =
 * 409 `TERMS_VERSION_OUTDATED` (a tela recarrega `GET /api/public/legal` e pede o aceite de novo); ausente = 400 `VALIDATION_ERROR` (`details[].path = "acceptedTermsVersion"`).
 * `register`: SEMPRE exigido. `google`: só quando o Google cria a conta (ver `GoogleAuthRequest.acceptedTermsVersion`). O aceite cobre Termos E Privacidade (o servidor grava os dois).
 */
export type TermsErrorCode = "TERMS_VERSION_OUTDATED"

/** `GET /api/me/consents` (DRIVER) -> 200. `upToDate=false` = abrir o modal de reaceite no próximo login. */
export interface MeConsentStatus {
  termsVersion: string | null
  privacyVersion: string | null
  acceptedAt: string | null
  upToDate: boolean
}
/** `POST /api/me/consents` (DRIVER) -> 201 `MeConsentStatus`. Versão que não é a vigente = 409 `TERMS_VERSION_OUTDATED`. */
export interface MeAcceptConsentsRequest {
  termsVersion: string
  privacyVersion: string
}

// ---- N-7 — Configurações de comunicação (e-mail SMTP e WhatsApp Evolution). ADMIN-ONLY --------------------------------------------------------------------
// Copiado LITERALMENTE de `docs/CONTRATO-COMUNICACAO-ADMIN.md` (fonte da verdade: `backend/src/api/routes/communicationSettings.routes.ts`). NÃO renomear.
// Rotas: GET/PUT `/api/admin/communication-settings`, POST `.../test-email` e `.../test-whatsapp`. Segredos NUNCA voltam; PUT exige `currentPassword` (step-up).

export type NotificationSeverity = 'INFO' | 'IMPORTANTE' | 'CRITICO'

/** `GET /api/admin/communication-settings` e resposta do `PUT`. SEGREDOS NUNCA VOLTAM. */
export interface CommunicationSettingsDTO {
  /** `database` = existe configuração salva no painel; `env` = tudo vem das variáveis de ambiente (reserva). */
  source: 'database' | 'env'
  email: {
    /** De onde vale o canal AGORA: painel, env, ou nenhum. */
    source: 'database' | 'env' | 'none'
    /** Intenção: ligado (no painel) ou configurado pela env. */
    enabled: boolean
    /** O canal está funcionando agora (config completa e válida). `enabled && !active` = há problema: ver `warnings`. */
    active: boolean
    host: string | null
    port: number | null
    /** `true` = TLS direto (porta 465); `false` = STARTTLS (587). */
    secure: boolean
    user: string | null
    /** Há senha SMTP salva. A senha NUNCA é devolvida (nem dica de caracteres). */
    passwordSet: boolean
    fromName: string | null
    fromAddress: string | null
    /** Destinatários dos avisos ao dono. */
    recipients: string[]
    minSeverity: NotificationSeverity
  }
  whatsapp: {
    source: 'database' | 'env' | 'none'
    enabled: boolean
    active: boolean
    /** Do painel é sempre `evolution`; da env pode ser `generic`. */
    provider: 'evolution' | 'generic' | null
    baseUrl: string | null
    instance: string | null
    apiKeySet: boolean
    /** Últimos 4 caracteres da apikey, para o admin reconhecer a chave ("…a1b2"); `null` se não há/ não decifra / veio da env. */
    apiKeyHint: string | null
    apiVersion: 1 | 2
    /** Só dígitos com DDI (ex.: "5511999999999"). */
    recipients: string[]
    minSeverity: NotificationSeverity
  }
  alerts: {
    /** Janela de dedupe em minutos (mesmo alerta+contexto avisa no máximo 1x por janela). */
    dedupeMinutes: number
    dedupeSource: 'database' | 'env'
    /** Piso global (env `ALERT_MIN_SEVERITY`, só leitura aqui): vale para qualquer canal além do mínimo de cada um. */
    globalMinSeverity: NotificationSeverity
    /** Teto de avisos por hora (env `ALERT_MAX_PER_HOUR`, só leitura aqui). */
    maxPerHour: number
  }
  /** `PAYMENT_SECRETS_KEY` configurada no servidor. `false` => não dá para salvar senha/apikey (PUT responde 503 `SECRETS_KEY_MISSING`). */
  secretsKeyConfigured: boolean
  /** `true` = segredos salvos decifram; `false` = algum NÃO decifra (chave trocada/perdida: canal desligado até salvar o segredo de novo); `null` = não há segredo salvo no banco. */
  secretsDecryptable: boolean | null
  /** Informativo: o deploy liberou destinos de rede privada (`COMMUNICATION_ALLOW_PRIVATE_HOSTS`). Não é editável pelo painel. */
  privateHostsAllowed: boolean
  /** Problemas de configuração em PT-BR, sem segredo (ex.: "e-mail ligado no painel, mas sem destinatário válido"). Mostrar como alerta na tela. */
  warnings: string[]
  /** `null` se nada foi salvo ainda. */
  updatedAt: string | null
}

/** `PUT /api/admin/communication-settings`. Campo ausente = "não mexer". `strict`: campo desconhecido é 400. */
export interface UpdateCommunicationSettingsRequest {
  email?: {
    /** Liga/desliga o canal (o painel manda: `false` desliga mesmo que a env o configure). A 1ª gravação do grupo, sem `enabled`, nasce DESLIGADA. */
    enabled?: boolean
    /** Só o endereço (nome ou IP): sem `http://`, sem porta, sem caminho. */
    host?: string
    port?: number // 1..65535
    secure?: boolean
    /** `null` limpa. */
    user?: string | null
    /** SENHA nova (troca). Para apagar a salva use `clearSecrets`. */
    password?: string
    fromName?: string | null // máx. 80
    fromAddress?: string
    recipients?: string[] // até 10 e-mails; REPLACE (a lista inteira)
    minSeverity?: NotificationSeverity
  }
  whatsapp?: {
    enabled?: boolean
    baseUrl?: string // URL da Evolution API (https em produção)
    instance?: string // letras, números, ponto, hífen e sublinhado
    /** apikey nova (troca). */
    apiKey?: string
    apiVersion?: 1 | 2
    /** Até 10 números (aceita "+55 (11) 99999-9999"; o backend normaliza para só dígitos com DDI); REPLACE. */
    recipients?: string[]
    minSeverity?: NotificationSeverity
  }
  alerts?: {
    /** 1..1440; `null` volta ao padrão da env (30). */
    dedupeMinutes?: number | null
  }
  /** Apaga um segredo salvo. */
  clearSecrets?: Array<'smtpPassword' | 'evolutionApiKey'>
  /** OBRIGATÓRIA: a senha ATUAL do ADMIN logado (step-up). Nunca vai para log/auditoria. */
  currentPassword: string
}
// Pelo menos UM entre email / whatsapp / alerts / clearSecrets; grupo vazio (`email: {}`) é 400.

export type TestChannelErrorCode =
  | 'DESTINATION_BLOCKED' // endereço aponta para rede interna/reservada
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_CONNECTION_FAILED'
  | 'SMTP_TLS_REQUIRED'
  | 'SMTP_REJECTED'
  | 'WHATSAPP_AUTH_FAILED' // 401/403: apikey errada
  | 'WHATSAPP_INSTANCE_OR_URL_NOT_FOUND' // 404
  | 'WHATSAPP_REJECTED' // outro 4xx (número, versão da API)
  | 'WHATSAPP_REDIRECT' // a URL redireciona (não seguimos)
  | 'WHATSAPP_PROVIDER_ERROR' // 5xx
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_CONFIGURATION' // falta destinatário, host, remetente, segredo ilegível...

/** `POST .../test-email` — corpo opcional. Sem `config`, testa a config SALVA (painel > env). */
export interface TestEmailRequest {
  /** Destinatário do teste; padrão: o 1º destinatário de alertas salvo. */
  to?: string
  /** Config AINDA NÃO SALVA para testar (não persiste nada). Mesmos nomes do PUT. */
  config?: { host?: string; port?: number; secure?: boolean; user?: string | null; password?: string; fromName?: string | null; fromAddress?: string }
}

/** `POST .../test-whatsapp` */
export interface TestWhatsappRequest {
  /** Número do teste (só dígitos com DDI); padrão: o 1º destinatário salvo. */
  to?: string
  config?: { baseUrl?: string; instance?: string; apiKey?: string; apiVersion?: 1 | 2 }
}

/** Resposta dos dois testes. SEMPRE `200`: erro do provedor é o RESULTADO do teste (`ok: false`), não erro da rota. */
export interface TestChannelResult {
  channel: 'email' | 'whatsapp'
  ok: boolean
  testedAt: string
  durationMs: number
  /** Destinatário MASCARADO (`d***@dominio.com`, `5511*****9999`); `null` se não chegou a escolher. */
  to: string | null
  error: { code: TestChannelErrorCode; message: string } | null
}

/** Etapas do teste de conexão SMTP (`CONNECT` = TCP, `TLS` = negociação segura, `AUTH` = usuário/senha, `OK` = tudo passou). `stage` é a etapa em que PAROU. */
export type SmtpConnectionStage = 'CONNECT' | 'TLS' | 'AUTH' | 'OK'

/**
 * `POST /api/admin/communication-settings/test-smtp-connection`. Contrato literal: `docs/CONTRATO-COMUNICACAO-ADMIN.md` (rota 9). Só conecta, negocia TLS e autentica; NÃO envia e-mail.
 * Sempre 200 com o resultado (`DESTINATION_BLOCKED` e `INVALID_CONFIGURATION` também são RESULTADO, etapa `CONNECT`);
 * 400 `SECRET_REQUIRED_FOR_NEW_DESTINATION` se `config` troca host/usuário sem reenviar a senha. Mesmo balde de 5/min do `test-email`.
 */
export interface TestSmtpConnectionRequest {
  /** Sem `config`, testa a config SALVA. Mesmos nomes do PUT. */
  config?: { host?: string; port?: number; secure?: boolean; user?: string | null; password?: string; fromName?: string | null; fromAddress?: string }
}

export interface TestSmtpConnectionResult {
  ok: boolean
  stage: SmtpConnectionStage
  /** `null` no sucesso. */
  code: TestChannelErrorCode | null
  /** Texto fixo em PT-BR do servidor (`null` se `ok`); a tela escolhe o seu texto por `code`. */
  message: string | null
  /** `true` = fez login com usuário/senha; `false` = servidor usado sem autenticação (nada configurado). */
  authenticated: boolean
  testedAt: string
  durationMs: number
}

export type DnsRecordStatus = 'OK' | 'ATENCAO' | 'AUSENTE' | 'ERRO'

/** Um registro verificado (SPF, DKIM ou DMARC). `valorEncontrado` é TXT público do DNS, truncado. */
export interface DnsRecordCheck {
  status: DnsRecordStatus
  /** Nome DNS consultado; `null` = não consultado (DKIM sem seletor). */
  nomeConsultado: string | null
  valorEncontrado: string | null
  /** Texto em PT-BR, pronto para exibir. */
  recomendacao: string
}

export interface DnsInstruction {
  /** Nome (host) do registro a cadastrar no DNS. */
  nome: string
  tipo: 'TXT' | 'TXT ou CNAME'
  /** Valor pronto para colar: só existe para o DMARC (SPF e DKIM dependem do provedor e vêm `null`). */
  valorSugerido: string | null
  texto: string
}

/**
 * `GET /api/admin/communication-settings/domain-check?selector=` — diagnóstico de SPF/DKIM/DMARC do domínio do e-mail REMETENTE SALVO (o domínio nunca vem do cliente; só o seletor DKIM, opcional:
 * letras, números e hífen, até 63). Contrato literal: `docs/CONTRATO-COMUNICACAO-ADMIN.md` (rota 10). Balde de 6/min;
 * falha de DNS vira `ERRO` no registro (200). `Cache-Control: no-store`.
 */
export interface DomainCheckResponse {
  /** `false` = não há e-mail remetente (ou o domínio dele não é público): nada foi consultado (veja `warnings`). */
  senderConfigured: boolean
  domain: string | null
  smtpProvider: string | null
  /** Pior resultado entre SPF, DMARC e (se houve seletor) DKIM; `null` quando nada foi consultado. */
  overallStatus: DnsRecordStatus | null
  spf: DnsRecordCheck | null
  dkim: DnsRecordCheck | null
  dmarc: DnsRecordCheck | null
  warnings: string[]
  instructions: { spf: DnsInstruction; dkim: DnsInstruction; dmarc: DnsInstruction } | null
  note: string
  checkedAt: string
}

// ---------------------------------------------------------------------------
// Dados da empresa e versões dos Termos/Privacidade (Admin > Configurações > Geral). Contrato LITERAL: `docs/CONTRATO-EMPRESA-ADMIN.md` (copiado sem renomear, salvo o comentário).
// ---------------------------------------------------------------------------

/** `db` = o painel já assumiu o dado; `env` = nada salvo, valem as variáveis `LEGAL_*` do deploy (reserva). */
export type LegalDataSource = 'db' | 'env'

/** `GET/PUT /api/admin/company-profile` (ADMIN-only). Nada aqui é segredo: tudo aparece na página pública de termos, no rodapé e nos e-mails ao motorista. */
export interface CompanyProfileDTO {
  source: LegalDataSource
  /** O que o dono DIGITOU (a razão social verdadeira, sem o "nome de exibição" com fallback do público). */
  profile: {
    legalName: string | null
    tradeName: string | null
    /** Formatado `00.000.000/0000-00` (ou alfanumérico, mesma máscara). O PUT aceita com ou sem pontuação. */
    cnpj: string | null
    supportEmail: string | null
    supportPhone: string | null
    address: string | null
    website: string | null
    dpoName: string | null
    dpoEmail: string | null
  }
  versions: {
    /** Versões VIGENTES agora (a que o motorista aceita). */
    termsVersion: string
    privacyVersion: string
    termsSource: LegalDataSource
    privacySource: LegalDataSource
    /** A versão que vale se o campo do painel for limpo (`null`): a variável `LEGAL_*_VERSION` do deploy ou o padrão do código. */
    envTermsVersion: string
    envPrivacyVersion: string
  }
  /** Campos da ENV com valor inválido (ficam vazios na página pública). Só aparece enquanto `source = env`. */
  invalidEnvFields: string[]
  updatedAt: string | null
}

/**
 * `PUT /api/admin/company-profile`. Campo AUSENTE = "não mexer"; `null` (ou texto vazio) = "limpar". `strict`: campo desconhecido é 400; ao menos um campo além de `confirmVersionChange`.
 * SEM step-up de senha (não há segredo), mas cada PUT é auditado. Rate limit de 10/min por ADMIN (`RATE_LIMITED`).
 */
export interface UpdateCompanyProfileRequest {
  legalName?: string | null // até 160
  tradeName?: string | null // até 120
  /** Com ou sem pontuação; o servidor valida os dígitos verificadores (numérico e alfanumérico) e normaliza. */
  cnpj?: string | null
  supportEmail?: string | null // até 180
  supportPhone?: string | null // 8 a 30 caracteres: números, DDD e + ( ) - . espaço
  address?: string | null // até 300
  website?: string | null // https://… (o servidor completa o https://)
  dpoName?: string | null // até 120
  dpoEmail?: string | null
  /** Até 32 caracteres: letras, números, ponto, hífen e sublinhado. `null` volta a valer a variável `LEGAL_*_VERSION`. */
  termsVersion?: string | null
  privacyVersion?: string | null
  /** OBRIGATÓRIO (`true`) quando o PUT MUDA a versão efetiva dos Termos ou da Privacidade: todos os motoristas voltam a `upToDate=false` e aceitam de novo. */
  confirmVersionChange?: boolean
}

export type CompanyProfileErrorCode =
  | 'VALIDATION_ERROR' // 400 — details: [{ path: 'cnpj' | 'supportEmail' | ..., message }]; nada gravado
  | 'VERSION_CHANGE_NOT_CONFIRMED' // 409 — details: [VersionChangeDetail]
  | 'RATE_LIMITED' // 429 — 10 PUTs/min por ADMIN
  | 'LEGAL_SETTINGS_UNAVAILABLE' // 503 — não deu para ler/gravar no banco

/** `details[0]` do 409 `VERSION_CHANGE_NOT_CONFIRMED` (nada foi gravado): mostre "isto obriga N motoristas a aceitar de novo" e reenvie o MESMO PUT com `confirmVersionChange: true`. */
export interface VersionChangeDetail {
  field: 'confirmVersionChange'
  reason: 'REQUIRED_TRUE'
  currentTermsVersion: string
  currentPrivacyVersion: string
  newTermsVersion: string
  newPrivacyVersion: string
  /** Motoristas ativos que terão de aceitar de novo. */
  driversAffected: number
}

export type CommunicationSettingsErrorCode =
  | 'VALIDATION_ERROR' // 400 (details: [{ path, message }])
  | 'INVALID_CURRENT_PASSWORD' // 403 — step-up
  | 'RATE_LIMITED_PAYMENT_GATEWAY' // 429 — tentativas ERRADAS de senha demais (mesmo código/balde do gateway), header Retry-After
  | 'RATE_LIMITED_COMMUNICATION_SETTINGS' // 429 — limite por minuto do PUT/testes
  | 'STEPUP_UNAVAILABLE' // 503 — Redis do step-up fora (fail-closed): nada foi gravado
  | 'SECRETS_KEY_MISSING' // 503 — servidor sem PAYMENT_SECRETS_KEY: não dá para guardar senha/apikey
  | 'COMMUNICATION_SETTINGS_UNAVAILABLE' // 503 — não deu para ler a config no banco (só GET/testes)
  | 'DESTINATION_NOT_ALLOWED' // 400 — details: [{ field: 'email.host' | 'whatsapp.baseUrl', reason: 'LOOPBACK' | 'REDE_PRIVADA' | 'NOME_INTERNO' | 'ENDERECO_DE_METADADOS' | 'ENDERECO_NAO_ROTEAVEL' | 'HOST_INVALIDO' | 'HTTPS_REQUIRED' | 'INVALID_URL' }]
  | 'SECRET_REQUIRED_FOR_NEW_DESTINATION' // 400 — trocar host/usuário SMTP ou URL/instância da Evolution exige reenviar a senha/apikey (details: [{ field: 'email.password' | 'whatsapp.apiKey' | 'config.password' | 'config.apiKey' }])
  | 'CHANNEL_INCOMPLETE' // 409 — não dá para LIGAR o canal: details: [{ channel: 'email' | 'whatsapp', problems: string[] }]; nada foi gravado

// ---------------------------------------------------------------------------
// Backup automático do banco (Admin > Backups). Contrato LITERAL: `docs/CONTRATO-BACKUP-ADMIN.md` (copiado sem renomear). Fonte do backend: `backend/src/api/routes/backup.routes.ts`.
// ---------------------------------------------------------------------------

export type BackupDestination = 'S3' | 'DRIVE'
export type BackupTrigger = 'SCHEDULED' | 'MANUAL' | 'VERIFY'
export type BackupRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED'

/** Código do erro de uma execução (`BackupRunDTO.errorCode`). Nunca texto livre. */
export type BackupErrorCode =
  | 'CONFIG' // destino incompleto/recusado, DATABASE_URL ausente
  | 'CREDENTIAL' // o destino recusou a credencial
  | 'FOLDER' // bucket/pasta inexistente ou sem acesso
  | 'QUOTA' // sem espaço no destino
  | 'NETWORK' // rede/instabilidade do destino
  | 'OAUTH_DISCONNECTED' // Google: acesso revogado — reconectar
  | 'DUMP' // pg_dump/pg_restore falhou (cliente ausente na imagem, versão antiga...)
  | 'DUMP_TIMEOUT' // pg_dump passou do prazo
  | 'KEY' // chave do backup ausente/ilegível/diferente da do arquivo
  | 'SECRETS_KEY' // PAYMENT_SECRETS_KEY ausente/mudou: segredos do destino não decifram
  | 'TOO_BIG' // arquivo > 5 GiB (envio simples do S3)
  | 'NO_BACKUP' // conferência: destino vazio
  | 'VERIFY' // conferência reprovou (vazio, adulterado, sem marca, índice vazio)
  | 'CHECKSUM' // SHA-256 do arquivo no destino não bate com o gravado no envio
  | 'BUSY' // já havia um em andamento
  | 'INTERRUPTED' // o processo morreu no meio
  | 'NOT_PICKED_UP' // pedido manual que o worker nunca pegou (worker fora do ar)
  | 'UNKNOWN'

/** Pendências para LIGAR o automático (vazio = pode ligar). */
export type BackupProblemToEnable = 'DESTINATION_INCOMPLETE' | 'KEY_MISSING' | 'SECRETS_KEY_MISSING' | 'SECRETS_UNREADABLE'

/** `GET /api/admin/backup/config` e resposta do `PUT` e do `POST /google/disconnect`. SEGREDOS NUNCA VOLTAM. */
export interface BackupConfigDTO {
  enabled: boolean
  /** Hora cheia em Brasília (UTC-3 fixo), 0..23. */
  hourLocal: number
  /** 1 = diário, 2 = dia sim dia não, 7 = semanal. */
  frequencyDays: 1 | 2 | 7
  /** Quantas cópias manter no destino (>= 1). Nunca apaga a única/última. */
  retentionCount: number
  /** Sem sucesso há mais que isto (h), com o automático ligado, dispara o alerta de atraso. 6..720. */
  alertAfterHours: number
  /** Destino ESCOLHIDO (manda sobre o que estiver preenchido). */
  destination: BackupDestination | null
  /** O destino escolhido está completo (S3: endereço+bucket+chave+segredo; Drive: conta conectada). */
  destinationReady: boolean
  s3: {
    endpoint: string | null
    region: string | null
    bucket: string | null
    prefix: string | null
    /** Há chave de acesso / segredo salvos. NUNCA são devolvidos (nem dica de caracteres). */
    accessKeySet: boolean
    secretKeySet: boolean
  }
  drive: {
    clientId: string | null
    clientSecretSet: boolean
    /** Conta Google conectada (fluxo OAuth concluído). "Client ID preenchido" NÃO é conectado. */
    connected: boolean
    connectedAt: string | null
    accountEmail: string | null
    /** O `redirect_uri` que o dono precisa cadastrar no app do Google Cloud (null se a API não sabe o próprio endereço: defina PUBLIC_API_BASE_URL). */
    redirectUri: string | null
  }
  encryptionKey: {
    exists: boolean
    /** 8 hex: confere "é a chave certa?" sem revelar a chave. */
    fingerprint: string | null
    createdAt: string | null
    shownAt: string | null
  }
  /** O servidor tem a PAYMENT_SECRETS_KEY (sem ela não dá para guardar credenciais nem a chave). */
  secretsKeyConfigured: boolean
  /** Os segredos salvos decifram agora (false = a PAYMENT_SECRETS_KEY mudou: recadastrar). */
  secretsReadable: boolean
  problemsToEnable: BackupProblemToEnable[]
  updatedAt: string
}

/** Uma execução (backup agendado/manual ou conferência). */
export interface BackupRunDTO {
  id: string
  trigger: BackupTrigger
  status: BackupRunStatus
  destination: BackupDestination | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  /** Nome do arquivo no destino (`backup-innoflow-AAAA-MM-DD-HHhMMmSSs.dump.enc`). */
  fileName: string | null
  /** Chave do objeto no S3, ou `drive:<id>/<nome>` no Drive. Nulo em teste sem destino. */
  objectKey: string | null
  /** Tamanho do arquivo CIFRADO que subiu. */
  sizeBytes: number | null
  /** SHA-256 (hex) do arquivo cifrado que subiu. */
  checksumSha256: string | null
  tablesWithData: number | null
  /** Impressão digital da chave que cifrou (nulo = execução de teste sem destino). */
  keyFingerprint: string | null
  /** CÓDIGO do erro (só quando `status === 'FAILED'`). */
  errorCode: BackupErrorCode | null
  /** Texto fixo, pronto para mostrar, derivado do código (nunca o stderr do pg_dump). */
  errorMessage: string | null
}

/** `GET /api/admin/backup/status`. */
export interface BackupStatusDTO {
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  /** Há um backup rodando agora (trava viva no banco). */
  running: boolean
  /** Atrasado: automático ligado e sem sucesso dentro de `alertAfterHours`. */
  stale: boolean
  /** Ligado e nunca saiu uma cópia. */
  neverRan: boolean
  /** Horas desde o último sucesso (null se nunca). */
  ageHours: number | null
  /** Próxima execução agendada (ISO, UTC), ou null com o automático desligado. */
  nextRunAt: string | null
  /** Pedido manual/conferência enfileirado ou rodando agora (para o spinner). */
  activeRun: BackupRunDTO | null
  lastBackupRun: BackupRunDTO | null
  lastVerifyRun: BackupRunDTO | null
}

/** `PUT /api/admin/backup/config` — tudo opcional, campo ausente = "não mexer", `null` onde permitido = limpar. `.strict()`: campo desconhecido é 400. */
export interface UpdateBackupConfigRequest {
  enabled?: boolean
  hourLocal?: number // 0..23
  frequencyDays?: 1 | 2 | 7
  retentionCount?: number // 1..365
  alertAfterHours?: number // 6..720
  destination?: BackupDestination | null
  s3?: {
    endpoint?: string // URL: https em produção; sem usuário/senha/query
    region?: string | null // ex.: us-east-1, auto
    bucket?: string
    prefix?: string | null // pasta dentro do bucket
    accessKey?: string // SÓ-ESCRITA
    secretKey?: string // SÓ-ESCRITA
  }
  drive?: {
    clientId?: string | null // trocar o Client ID DESCONECTA a conta (o escopo drive.file é por app)
    clientSecret?: string // SÓ-ESCRITA
  }
  /** Apaga um segredo salvo. Para TROCAR, mande o valor novo no campo próprio. */
  clearSecrets?: Array<'s3AccessKey' | 's3SecretKey' | 'driveClientSecret'>
  /** Senha ATUAL do ADMIN logado. Obrigatória exceto quando o PUT só traz hourLocal/frequencyDays/alertAfterHours ou `enabled: false`. */
  currentPassword?: string
}

/** `POST /api/admin/backup/key` → 201. A chave sai UMA vez: a tela deve oferecer o download do `fileText` e NÃO guardá-la. */
export interface GenerateBackupKeyRequest {
  currentPassword: string
  /** Trocar uma chave que JÁ existe exige `replace: true` E `confirmation: 'GERAR NOVA CHAVE'` (exatamente). */
  replace?: boolean
  confirmation?: string
  /** A impressão digital que a tela viu; se já mudou (outra pessoa gerou), 409 `BACKUP_KEY_CHANGED`. */
  expectedFingerprint?: string | null
}
export interface GeneratedBackupKeyResponse {
  /** A chave inteira, 8 grupos de 8 hex separados por hífen. */
  key: string
  fingerprint: string
  /** `chave-backup-innoflow-<impressão digital>.txt` */
  fileName: string
  /** Conteúdo do .txt para download (tem a linha `CHAVE: ...` que os scripts leem). */
  fileText: string
  replaced: boolean
}

/** `POST /api/admin/backup/test-destination` → SEMPRE 200 com o RESULTADO (`ok:false` não é erro da rota). */
export interface BackupTestDestinationResponse {
  ok: boolean
  destination: BackupDestination | null
  message: string
  error?: { code: BackupErrorCode; message: string }
}

/** `GET /api/admin/backup/runs?page=&pageSize=&trigger=&status=` (pageSize 1..100, padrão 20). */
export interface BackupRunsResponse {
  items: BackupRunDTO[]
  meta: { page: number; pageSize: number; total: number; totalPages: number }
}

/** `POST /api/admin/backup/google/start` → 200. Navegue (`window.location`) para `url`. */
export interface BackupGoogleStartResponse {
  url: string
  redirectUri: string | null
}
