import { DRIVER_CLOSURE_COPY } from "./sessionClosureCopy"
import { formatCents } from "./utils"
import type {
  ChargingSessionStatus,
  MeSessionDetail,
  MeterStopSource,
  SessionClosureSource,
  SessionStopRequester,
  StopUnconfirmedReason,
} from "@/types/api"

/**
 * F5.9 — lógica de APRESENTAÇÃO do fechamento de sessão (nenhuma regra de
 * negócio: quem decide o status, o prazo e o valor é o backend). Os textos
 * moram em `sessionClosureCopy.ts`.
 */

/** Estados em que a sessão ainda é "do motorista" na tela de sessão ativa. `STOP_UNCONFIRMED` NÃO entra (vai para o recibo); `FAULTED` entra (F5.9: não é mais beco sem saída). */
export const ACTIVE_SESSION_STATUSES: readonly ChargingSessionStatus[] = ["STARTED", "CHARGING", "FINISHING", "FAULTED"]

export function isActiveSessionStatus(status: ChargingSessionStatus | null | undefined): boolean {
  return !!status && ACTIVE_SESSION_STATUSES.includes(status)
}

/** "HH:MM" no fuso do aparelho; `null` para ausente/inválido (quem chama decide a frase sem horário). */
export function formatClockTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)
}

export interface DriverClosureNotice {
  /** `pending` = ainda não fechou (nada cobrado); `server` = fechada pelo servidor (cobrada só até o medido). */
  kind: "pending" | "server"
  lines: string[]
}

/**
 * O que o recibo do motorista diz sobre o fechamento. `null` = nada a dizer
 * (sessão normal). O stop tardio (`lateStop`) NUNCA aparece aqui — é só do
 * admin e este tipo de entrada nem tem o campo.
 */
export function getDriverClosureNotice(
  session: Pick<MeSessionDetail, "status" | "paymentMode" | "closure" | "payment">,
): DriverClosureNotice | null {
  const { closure } = session
  if (session.status === "STOP_UNCONFIRMED") {
    const lines: string[] = [DRIVER_CLOSURE_COPY.unconfirmed(formatClockTime(closure?.confirmDeadline))]
    const authorized = session.payment?.card?.authorizedCents
    if (session.paymentMode === "CARD" && authorized !== undefined && authorized !== null) {
      lines.push(DRIVER_CLOSURE_COPY.cardHoldKept(formatCents(authorized)))
    }
    return { kind: "pending", lines }
  }
  if (session.status === "STOPPED" && closure?.source === "SERVER") {
    return { kind: "server", lines: [DRIVER_CLOSURE_COPY.serverClosed(formatClockTime(closure.billedUntil))] }
  }
  return null
}

/** Valor mostrado em lista/recibo: sem valor final enquanto confirma (R$ 0,00 seria uma afirmação falsa). */
export function formatSessionAmount(status: ChargingSessionStatus, totalCostCents: number | null | undefined): string {
  if (status === "STOP_UNCONFIRMED") return DRIVER_CLOSURE_COPY.amountPending
  return formatCents(totalCostCents)
}

// ---- Vocabulário do admin ---------------------------------------------------

export const STOP_UNCONFIRMED_REASON_LABELS: Record<StopUnconfirmedReason, string> = {
  STOP_REJECTED: "Carregador rejeitou o comando de parada",
  STOP_NOT_CONFIRMED: "Carregador não confirmou a parada a tempo",
  CHARGER_UNREACHABLE: "Carregador inalcançável (offline)",
  CHARGER_REBOOTED: "Carregador reiniciou durante a sessão",
  CONNECTOR_IDLE: "Conector sem recarga em curso",
  MAX_DURATION: "Duração máxima da sessão excedida",
}

export const CLOSURE_SOURCE_LABELS: Record<SessionClosureSource, string> = {
  CHARGER: "Carregador (StopTransaction)",
  SERVER: "Servidor (encerramento automático)",
}

export const METER_STOP_SOURCE_LABELS: Record<MeterStopSource, string> = {
  STOP_TRANSACTION: "StopTransaction do carregador",
  LAST_METER_SAMPLE: "Última amostra do medidor",
  NO_READING: "Sem leitura do medidor",
}

export const STOP_REQUESTER_LABELS: Record<SessionStopRequester, string> = {
  DRIVER: "Motorista",
  ADMIN: "Administrador",
  GUARD: "Guarda de saldo/teto",
  WATCHDOG: "Vigia automático",
}
