import type { ChargePoint, Connector, TariffAssignment, TariffAssignmentScope } from "@/types/api"

/**
 * Leitura (nunca escrita) dos vínculos de tarifa para o painel: quais valem agora e qual vence para uma tomada.
 * Espelha `resolveActiveTariff` (`backend/src/ocpp/tariffResolution.ts`) — o servidor continua sendo quem decide de
 * verdade no StartTransaction; isto só EXPLICA a regra ao dono. Se a regra do servidor mudar, mudar aqui junto
 * (a ordem de desempate está coberta em `tariffAssignments.test.ts`).
 */

/** Maior = mais específico. Desempata prioridades iguais (NÃO confiar na ordem alfabética do enum). */
const SCOPE_SPECIFICITY: Record<TariffAssignmentScope, number> = { CONNECTOR: 4, CHARGE_POINT: 3, SITE: 2, OPERATOR: 1 }

export const SCOPE_LABELS: Record<TariffAssignmentScope, string> = {
  CONNECTOR: "Uma tomada",
  CHARGE_POINT: "Um carregador",
  SITE: "Um local",
  OPERATOR: "Todo o operador",
}

/** Opção curta do seletor "Onde vale" (cabe em tela de 375 px sem truncar). */
export const SCOPE_OPTION_LABELS: Record<TariffAssignmentScope, string> = {
  CONNECTOR: "Uma tomada específica",
  CHARGE_POINT: "Um carregador inteiro",
  SITE: "Um local",
  OPERATOR: "Todo o operador",
}

/** O que cada escolha significa na prática — aparece abaixo do seletor. */
export const SCOPE_HINTS: Record<TariffAssignmentScope, string> = {
  CONNECTOR: "Vale só nessa tomada. É a regra mais específica.",
  CHARGE_POINT: "Vale em todas as tomadas do carregador escolhido.",
  SITE: "Vale em todos os carregadores desse local.",
  OPERATOR: "Vale em qualquer carregador do operador que não tenha uma regra mais específica.",
}

export type AssignmentStatus = "active" | "scheduled" | "expired"

/** `validFrom <= agora` e (`validTo` vazio ou `validTo >= agora`) — exatamente o filtro do servidor. */
export function getAssignmentStatus(a: Pick<TariffAssignment, "validFrom" | "validTo">, now: Date = new Date()): AssignmentStatus {
  if (new Date(a.validFrom).getTime() > now.getTime()) return "scheduled"
  if (a.validTo !== null && new Date(a.validTo).getTime() < now.getTime()) return "expired"
  return "active"
}

type CpRef = Pick<ChargePoint, "id" | "siteId" | "operatorId">
type ConnectorRef = Pick<Connector, "id">

/** O vínculo cobre esta tomada? (mesmo operador + o alvo do escopo coincide). `connector = null` avalia só o que vale para o carregador todo. */
export function assignmentCovers(a: TariffAssignment, chargePoint: CpRef, connector: ConnectorRef | null): boolean {
  if (a.operatorId !== chargePoint.operatorId) return false
  switch (a.scope) {
    case "CONNECTOR":
      return connector !== null && a.connectorId === connector.id
    case "CHARGE_POINT":
      return a.chargePointId === chargePoint.id
    case "SITE":
      return a.siteId === chargePoint.siteId
    case "OPERATOR":
      return true
  }
}

/** Vínculo vigente que VENCE para a tomada: maior prioridade, depois escopo mais específico, depois o criado por último. `null` = nenhum vale. */
export function resolveEffectiveAssignment(
  assignments: TariffAssignment[],
  chargePoint: CpRef,
  connector: ConnectorRef | null,
  now: Date = new Date(),
): TariffAssignment | null {
  const candidates = assignments.filter((a) => getAssignmentStatus(a, now) === "active" && assignmentCovers(a, chargePoint, connector))
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    const spec = SCOPE_SPECIFICITY[b.scope] - SCOPE_SPECIFICITY[a.scope]
    if (spec !== 0) return spec
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })[0]
}

export type CoverageState =
  /** Nenhuma tomada tem tarifa: o QR não inicia recarga. */
  | "none"
  /** Algumas tomadas têm tarifa e outras não. */
  | "partial"
  /** Todas as tomadas têm a mesma tarifa. */
  | "uniform"
  /** Todas têm tarifa, mas nem todas a mesma. */
  | "mixed"
  /** O carregador não tem tomadas cadastradas (nada a cobrar ainda). */
  | "no-connectors"

export interface ChargePointCoverage {
  state: CoverageState
  /** Tarifa efetiva por tomada (a ordem de `connectors`). */
  perConnector: { connector: Connector; effective: TariffAssignment | null }[]
  /** Quantas tomadas ficaram sem tarifa. */
  uncovered: number
  /** Só em `uniform`: a tarifa comum. */
  tariff?: { id: string; name: string }
}

export function getChargePointCoverage(
  assignments: TariffAssignment[],
  chargePoint: CpRef & { connectors?: Connector[] },
  now: Date = new Date(),
): ChargePointCoverage {
  const connectors = chargePoint.connectors ?? []
  const perConnector = connectors.map((connector) => ({ connector, effective: resolveEffectiveAssignment(assignments, chargePoint, connector, now) }))
  if (perConnector.length === 0) return { state: "no-connectors", perConnector, uncovered: 0 }

  const uncovered = perConnector.filter((p) => !p.effective).length
  if (uncovered === perConnector.length) return { state: "none", perConnector, uncovered }
  if (uncovered > 0) return { state: "partial", perConnector, uncovered }

  const ids = new Set(perConnector.map((p) => p.effective!.tariffId))
  if (ids.size === 1) {
    const first = perConnector[0].effective!
    return { state: "uniform", perConnector, uncovered, tariff: { id: first.tariffId, name: first.tariff?.name ?? "Tarifa" } }
  }
  return { state: "mixed", perConnector, uncovered }
}

/** `YYYY-MM-DD` (campo `<input type="date">`) -> ISO do INÍCIO daquele dia no fuso do navegador. Vazio = `undefined` (o backend usa "agora"). */
export function dateInputToStartIso(value: string | undefined): string | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split("-").map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
}

/** `YYYY-MM-DD` -> ISO do FIM daquele dia (23:59:59.999) no fuso do navegador: "vale até 30/10" inclui o dia 30 inteiro. */
export function dateInputToEndIso(value: string | undefined): string | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split("-").map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
}

/** ISO -> `YYYY-MM-DD` no fuso do navegador (para preencher o `<input type="date">` na edição). */
export function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** O instante (ISO) já passou? Função de módulo (não de render) para a checagem de "data final no passado" no submit. */
export function isInPast(iso: string, now: Date = new Date()): boolean {
  return new Date(iso).getTime() < now.getTime()
}
