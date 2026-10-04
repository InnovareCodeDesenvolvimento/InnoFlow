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
 * `CURRENT_PASSWORD_REQUIRED`, 403 `INVALID_CURRENT_PASSWORD` (**403 de propósito, não 401**:
 * o interceptor global trata 401 como sessão expirada e deslogaria quem só errou a senha
 * atual), 429 `RATE_LIMITED_PASSWORD` (limite por usuário, não por IP).
 */
export interface ChangePasswordRequest {
  currentPassword?: string
  newPassword: string
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
export type CardEligibilityReason = "GOOGLE_LOGIN_REQUIRED" | "TEMPORARILY_BLOCKED"
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
  merchantId: string
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
