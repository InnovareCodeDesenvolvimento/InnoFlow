import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { ConnectorStatus, ConnectorType, Role } from "@/types/api"

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

/** Potência do conector formatada com a unidade; travessão quando ausente. */
export function formatPowerKw(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  const n = toNumber(value)
  if (n <= 0) return "—"
  return `${n % 1 === 0 ? n : n.toFixed(1)} kW`
}
