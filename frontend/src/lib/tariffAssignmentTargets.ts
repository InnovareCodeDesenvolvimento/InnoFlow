import type { SelectOption } from "@/components/ui/Select"
import { CONNECTOR_TYPE_LABELS, formatCents, formatCurrency } from "@/lib/utils"
import { dateInputToEndIso, dateInputToStartIso } from "@/lib/tariffAssignments"
import type { TariffAssignmentFormValues } from "@/schemas/tariffAssignment.schema"
import type { ChargePoint, Connector, CreateTariffAssignmentInput, Site, TariffAssignment, TariffAssignmentScope, Tariff } from "@/types/api"

/** O que a tela precisa para transformar ids em nomes e montar as listas de alvo. `chargePoints[].connectors` vem embutido na listagem de carregadores. */
export interface AssignmentLookup {
  sites: Site[]
  chargePoints: ChargePoint[]
}

export const siteLabel = (site: Site) => `${site.name} (${site.city}/${site.state})`
export const chargePointLabel = (cp: ChargePoint) => cp.ocppIdentity
export const connectorLabel = (cp: Pick<ChargePoint, "ocppIdentity">, c: Connector) => `${cp.ocppIdentity} · tomada #${c.connectorId} (${CONNECTOR_TYPE_LABELS[c.type]})`

/**
 * Alvos que o usuário pode escolher para um escopo, SEMPRE dentro de um único operador: o servidor responde 404 se a
 * tarifa e o alvo forem de operadores diferentes, então a tela nem oferece a combinação. Só ativos (um site/carregador
 * desativado não recebe vínculo novo). `onlyChargePoint` restringe ao contexto de um carregador (tela "Tarifas do carregador").
 */
export function buildTargetOptions(args: {
  scope: TariffAssignmentScope
  operatorId: string | undefined
  lookup: AssignmentLookup
  onlyChargePoint?: ChargePoint
}): SelectOption[] {
  const { scope, operatorId, lookup, onlyChargePoint } = args
  if (scope === "OPERATOR") return []
  const sameOperator = <T extends { operatorId: string }>(item: T) => !operatorId || item.operatorId === operatorId

  if (scope === "SITE") {
    const sites = onlyChargePoint ? lookup.sites.filter((s) => s.id === onlyChargePoint.siteId) : lookup.sites.filter((s) => s.active && sameOperator(s))
    return sites.map((s) => ({ value: s.id, label: siteLabel(s) }))
  }

  const chargePoints = onlyChargePoint ? [onlyChargePoint] : lookup.chargePoints.filter((cp) => cp.active && sameOperator(cp))
  if (scope === "CHARGE_POINT") return chargePoints.map((cp) => ({ value: cp.id, label: chargePointLabel(cp) }))
  return chargePoints.flatMap((cp) => (cp.connectors ?? []).map((c) => ({ value: c.id, label: connectorLabel(cp, c) })))
}

/** Nome legível do alvo de um vínculo ("Local: Shopping Vila Norte", "Tomada: CP-X · #2"...). Id desconhecido (lista truncada/alvo removido) vira texto neutro, nunca o cuid cru. */
export function describeAssignmentTarget(a: TariffAssignment, lookup: AssignmentLookup): { kind: string; name: string } {
  switch (a.scope) {
    case "OPERATOR":
      return { kind: "Operador", name: "Todos os carregadores do operador" }
    case "SITE": {
      const site = lookup.sites.find((s) => s.id === a.siteId)
      return { kind: "Local", name: site ? siteLabel(site) : "Local não encontrado" }
    }
    case "CHARGE_POINT": {
      const cp = lookup.chargePoints.find((c) => c.id === a.chargePointId)
      return { kind: "Carregador", name: cp ? chargePointLabel(cp) : "Carregador não encontrado" }
    }
    case "CONNECTOR": {
      for (const cp of lookup.chargePoints) {
        const c = cp.connectors?.find((x) => x.id === a.connectorId)
        if (c) return { kind: "Tomada", name: connectorLabel(cp, c) }
      }
      return { kind: "Tomada", name: "Tomada não encontrada" }
    }
  }
}

/**
 * Valores do formulário -> corpo do `POST`. Só o campo de alvo do escopo é enviado (o servidor recusa os outros dois com 400).
 * `operatorId` só vai quando quem cria é ADMIN (o servidor ignora o de OPERATOR); o chamador passa o `operatorId` da tarifa escolhida.
 */
export function buildCreatePayload(values: TariffAssignmentFormValues, operatorId: string | undefined): CreateTariffAssignmentInput {
  const payload: CreateTariffAssignmentInput = {
    ...(operatorId ? { operatorId } : {}),
    tariffId: values.tariffId,
    scope: values.scope,
    priority: values.priority,
    validFrom: dateInputToStartIso(values.validFrom),
    validTo: dateInputToEndIso(values.validTo),
  }
  if (values.scope === "CONNECTOR") payload.connectorId = values.targetId
  if (values.scope === "CHARGE_POINT") payload.chargePointId = values.targetId
  if (values.scope === "SITE") payload.siteId = values.targetId
  return payload
}

/** "R$ 1,99/kWh" / "R$ 0,50/min" / "R$ 1,99/kWh + R$ 0,10/min" — o suficiente para o dono reconhecer a tarifa numa lista. */
export function describeTariffPrice(t: Pick<Tariff, "pricePerKwh" | "pricePerMinute" | "sessionFeeCents">): string {
  const parts: string[] = []
  if (t.pricePerKwh) parts.push(`${formatCurrency(t.pricePerKwh)}/kWh`)
  if (t.pricePerMinute) parts.push(`${formatCurrency(t.pricePerMinute)}/min`)
  if (parts.length === 0 && t.sessionFeeCents) parts.push(`${formatCents(t.sessionFeeCents)}/sessão`)
  return parts.join(" + ") || "sem preço"
}
