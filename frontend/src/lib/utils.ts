import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type {
  AuditAction,
  AuditOutcome,
  ChargingSessionStatus,
  ConnectorStatus,
  ConnectorType,
  PaymentIntentStatus,
  PublicTariffSummary,
  Role,
  SessionPaymentStatus,
  User,
  WalletEntryType,
} from "@/types/api"

/** Combina classes Tailwind com o tailwind-merge resolvendo conflitos (última classe conflitante vence). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Prisma Decimal chega serializado como string; aceita number também. */
export function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "number") return value
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Formata um valor em REAIS (não centavos) como moeda BRL. */
export function formatCurrency(value: string | number | null | undefined): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(toNumber(value))
}

/** Centavos inteiros → string formatada em BRL. */
export function formatCents(cents: number | null | undefined): string {
  return formatCurrency((cents ?? 0) / 100)
}

/** Converte reais (o que a pessoa digita) para centavos inteiros (o que a API espera). */
export function reaisToCents(reais: number | undefined | null): number | undefined {
  if (reais === undefined || reais === null || Number.isNaN(reais)) return undefined
  return Math.round(reais * 100)
}

/** Converte centavos (o que a API devolve) para reais (o que mostramos no formulário). */
export function centsToReais(cents: number | null | undefined): number | undefined {
  if (cents === null || cents === undefined) return undefined
  return cents / 100
}

/**
 * Data no formato brasileiro. Devolve travessão em vez de estourar quando a
 * data não vem ou vem inválida — `new Date(undefined)` gera um objeto
 * "Invalid Date" que `Intl.DateTimeFormat().format()` rejeita com
 * RangeError, e um único campo ausente não pode derrubar a tela inteira.
 */
export function formatDate(date: string | Date | null | undefined): string {
  if (date === null || date === undefined || date === "") return "—"
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return "—"
  return new Intl.DateTimeFormat("pt-BR").format(d)
}

/** Data e hora no formato brasileiro, no fuso do navegador. Mesma defesa de `formatDate`. */
export function formatDateTime(date: string | Date | null | undefined): string {
  if (date === null || date === undefined || date === "") return "—"
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return "—"
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(d)
}

export const CONNECTOR_TYPE_LABELS: Record<ConnectorType, string> = {
  AC_TYPE2: "AC Tipo 2",
  DC_CCS2: "DC CCS2",
  DC_CHADEMO: "DC CHAdeMO",
}

export const CONNECTOR_STATUS_LABELS: Record<ConnectorStatus, string> = {
  AVAILABLE: "Disponível",
  PREPARING: "Preparando",
  CHARGING: "Carregando",
  SUSPENDED_EVSE: "Suspenso (posto)",
  SUSPENDED_EV: "Suspenso (veículo)",
  FINISHING: "Finalizando",
  RESERVED: "Reservado",
  UNAVAILABLE: "Indisponível",
  FAULTED: "Com falha",
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrador",
  OPERATOR: "Operador",
  DRIVER: "Motorista",
}

/**
 * Rótulo de contexto multi-tenant para o cabeçalho: `OPERATOR` mostra a
 * empresa (`operatorName`, join que o backend faz em `/api/auth/login`);
 * `ADMIN` atravessa todos os operadores, então não há uma empresa "dona" —
 * mostra um rótulo fixo em vez de nome de empresa. `DRIVER` não tem
 * operador e não usa o painel admin, então não precisa de rótulo aqui.
 */
export function operatorContextLabel(user: Pick<User, "role" | "operatorName"> | null | undefined): string | null {
  if (!user) return null
  if (user.role === "ADMIN") return "Administrador da plataforma"
  if (user.role === "OPERATOR") return user.operatorName ?? "Operador sem empresa vinculada"
  return null
}

/** Potência do conector formatada com a unidade; travessão quando ausente. */
export function formatPowerKw(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  const n = toNumber(value)
  if (n <= 0) return "—"
  return `${n % 1 === 0 ? n : n.toFixed(1)} kW`
}

// ---------------------------------------------------------------------------
// Retaguarda: energia, percentuais e labels de domínio
// ---------------------------------------------------------------------------

/** Wh inteiros (contrato da API) → string em kWh. */
export function formatEnergyWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—"
  return `${(wh / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} kWh`
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  return `${value.toFixed(digits)}%`
}

/** Duração em minutos → "Xh Ymin" (ou só "Ymin" quando < 1h). Travessão quando ausente. */
export function formatDurationMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes < 0) return "—"
  const totalMinutes = Math.round(minutes)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h === 0) return `${m} min`
  return `${h}h ${m}min`
}

export const CHARGING_SESSION_STATUS_LABELS: Record<ChargingSessionStatus, string> = {
  STARTED: "Iniciada",
  CHARGING: "Carregando",
  FINISHING: "Finalizando",
  STOPPED: "Encerrada",
  FAULTED: "Com falha",
}

export const SESSION_PAYMENT_STATUS_LABELS: Record<SessionPaymentStatus, string> = {
  CAPTURED: "Pago",
  PENDING: "Pendente",
  FAILED: "Falhou",
  OPEN_DEBT: "Dívida em aberto",
}

export const PAYMENT_INTENT_STATUS_LABELS: Record<PaymentIntentStatus, string> = {
  CREATED: "Criado",
  AUTHORIZED: "Autorizado",
  CAPTURE_PENDING: "Captura pendente",
  CAPTURED: "Capturado",
  CANCELLED: "Cancelado",
  DENIED: "Negado",
  VOIDED: "Estornado",
  FAILED: "Falhou",
  EXPIRED: "Expirado",
}

export const PAYMENT_METHOD_LABELS: Record<"CARD" | "WALLET", string> = {
  CARD: "Cartão",
  WALLET: "Carteira",
}

type BadgeVariant = "neutral" | "primary" | "success" | "warning" | "danger" | "info"

export function sessionStatusBadgeVariant(status: ChargingSessionStatus): BadgeVariant {
  switch (status) {
    case "STOPPED":
      return "success"
    case "CHARGING":
      return "info"
    case "FAULTED":
      return "danger"
    case "STARTED":
    case "FINISHING":
      return "warning"
  }
}

// ---------------------------------------------------------------------------
// PWA do motorista
// ---------------------------------------------------------------------------

/**
 * Selo de status simplificado da landing pós-QR (3 estados, não os 9 de
 * `ConnectorStatusBadge` — a tela do motorista não precisa saber a diferença
 * entre `PREPARING`/`FINISHING`, só se dá para carregar agora).
 */
export function landingConnectorStatus(online: boolean, status: ConnectorStatus): { label: string; variant: BadgeVariant } {
  if (!online || status === "UNAVAILABLE" || status === "FAULTED") return { label: "Fora do ar", variant: "neutral" }
  if (status === "AVAILABLE") return { label: "Disponível", variant: "success" }
  return { label: "Ocupado", variant: "warning" }
}

/** Preço em destaque da tarifa — prioriza R$/kWh (o mais comum), cai para R$/min, depois taxa fixa por sessão. */
export function formatTariffHeadlinePrice(tariff: PublicTariffSummary): string {
  if (tariff.pricePerKwh) return `${formatCurrency(tariff.pricePerKwh)} / kWh`
  if (tariff.pricePerMinute) return `${formatCurrency(tariff.pricePerMinute)} / min`
  if (tariff.sessionFeeCents) return `${formatCents(tariff.sessionFeeCents)} / sessão`
  return "Tarifa sob consulta"
}

export const WALLET_ENTRY_TYPE_LABELS: Record<WalletEntryType, string> = {
  TOPUP_PIX: "Recarga via Pix",
  TOPUP_REFUND: "Estorno de recarga",
  CHARGE_DEBIT: "Recarga de veículo",
  ADJUSTMENT_CREDIT: "Crédito manual",
  ADJUSTMENT_DEBIT: "Débito manual",
  REFUND: "Estorno",
}

/**
 * Status da cobrança no cartão (F5.4), em linguagem de MOTORISTA — diferente
 * de `PAYMENT_INTENT_STATUS_LABELS` (painel admin, vocabulário técnico "Captura
 * pendente"/"Capturado"). `AUTHORIZED` é o único estado que o recibo nunca
 * deveria mostrar de fato (a sessão só termina de ser exibida no recibo
 * depois do Stop, quando `finalizarSessao` já marcou `CAPTURE_PENDING`), mas
 * o mapa cobre todos os membros de `PaymentIntentStatus` por exaustividade —
 * nunca cair num `undefined` se o backend mandar um estado intermediário.
 */
export const SESSION_CARD_CAPTURE_STATUS_LABELS: Record<PaymentIntentStatus, string> = {
  CREATED: "Processando",
  AUTHORIZED: "Pré-autorizado",
  CAPTURE_PENDING: "Cobrança em processamento",
  CAPTURED: "Cobrado",
  CANCELLED: "Cancelado",
  DENIED: "Não cobrado — cartão recusado",
  VOIDED: "Estornado",
  FAILED: "Não foi possível cobrar",
  EXPIRED: "Pré-autorização expirada",
}

// ---------------------------------------------------------------------------
// AuditLog (painel admin, ADMIN-only)
// ---------------------------------------------------------------------------

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  CREATE: "Criação",
  UPDATE: "Atualização",
  DELETE: "Exclusão",
  REMOTE_COMMAND: "Comando remoto",
  WALLET_ADJUSTMENT: "Ajuste de carteira",
  LOGIN_SUCCESS: "Login",
  LOGIN_FAILED: "Falha de login",
  EXPORT: "Exportação",
  OTHER: "Outro",
}

export const AUDIT_OUTCOME_LABELS: Record<AuditOutcome, string> = {
  SUCCESS: "Sucesso",
  DENIED: "Negado",
  FAILED: "Falhou",
}

/** `DENIED`/`FAILED` em destaque (`danger`) — é o sinal de segurança mais valioso da tela (pedido explícito do dono). */
export function auditOutcomeBadgeVariant(outcome: AuditOutcome): BadgeVariant {
  switch (outcome) {
    case "SUCCESS":
      return "success"
    case "DENIED":
    case "FAILED":
      return "danger"
  }
}

export function paymentStatusBadgeVariant(status: SessionPaymentStatus | PaymentIntentStatus): BadgeVariant {
  switch (status) {
    case "CAPTURED":
      return "success"
    case "PENDING":
    case "CREATED":
    case "AUTHORIZED":
    case "CAPTURE_PENDING":
      return "info"
    case "OPEN_DEBT":
    case "FAILED":
    case "DENIED":
      return "danger"
    case "CANCELLED":
    case "VOIDED":
    case "EXPIRED":
      return "neutral"
    default:
      return "neutral"
  }
}
