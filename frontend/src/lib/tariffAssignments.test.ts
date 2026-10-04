import { describe, expect, it } from "vitest"
import type { Connector, TariffAssignment } from "@/types/api"
import {
  assignmentCovers,
  dateInputToEndIso,
  dateInputToStartIso,
  getAssignmentStatus,
  getChargePointCoverage,
  isoToDateInput,
  resolveEffectiveAssignment,
} from "./tariffAssignments"

const NOW = new Date("2026-10-04T12:00:00.000Z")
const cp = { id: "cp1", siteId: "site1", operatorId: "opA" }
const conn1 = { id: "c1" }
const conn2 = { id: "c2" }

let seq = 0
function assignment(over: Partial<TariffAssignment>): TariffAssignment {
  seq += 1
  return {
    id: `a${seq}`,
    operatorId: "opA",
    tariffId: `t${seq}`,
    scope: "OPERATOR",
    connectorId: null,
    chargePointId: null,
    siteId: null,
    priority: 0,
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }
}

describe("getAssignmentStatus", () => {
  it("vigente, agendado e encerrado (validTo == agora ainda vale: o servidor usa gte)", () => {
    expect(getAssignmentStatus({ validFrom: "2026-01-01T00:00:00Z", validTo: null }, NOW)).toBe("active")
    expect(getAssignmentStatus({ validFrom: "2026-11-01T00:00:00Z", validTo: null }, NOW)).toBe("scheduled")
    expect(getAssignmentStatus({ validFrom: "2026-01-01T00:00:00Z", validTo: "2026-10-01T00:00:00Z" }, NOW)).toBe("expired")
    expect(getAssignmentStatus({ validFrom: "2026-01-01T00:00:00Z", validTo: NOW.toISOString() }, NOW)).toBe("active")
  })
})

describe("assignmentCovers", () => {
  it("só cobre o alvo do próprio escopo e o próprio operador", () => {
    expect(assignmentCovers(assignment({ scope: "CONNECTOR", connectorId: "c1" }), cp, conn1)).toBe(true)
    expect(assignmentCovers(assignment({ scope: "CONNECTOR", connectorId: "c1" }), cp, conn2)).toBe(false)
    expect(assignmentCovers(assignment({ scope: "CONNECTOR", connectorId: "c1" }), cp, null)).toBe(false)
    expect(assignmentCovers(assignment({ scope: "CHARGE_POINT", chargePointId: "cp1" }), cp, conn2)).toBe(true)
    expect(assignmentCovers(assignment({ scope: "CHARGE_POINT", chargePointId: "outro" }), cp, conn2)).toBe(false)
    expect(assignmentCovers(assignment({ scope: "SITE", siteId: "site1" }), cp, conn1)).toBe(true)
    expect(assignmentCovers(assignment({ scope: "SITE", siteId: "site9" }), cp, conn1)).toBe(false)
    expect(assignmentCovers(assignment({ scope: "OPERATOR" }), cp, conn1)).toBe(true)
    expect(assignmentCovers(assignment({ scope: "OPERATOR", operatorId: "opB" }), cp, conn1)).toBe(false)
  })
})

describe("resolveEffectiveAssignment — mesma ordem de desempate do servidor", () => {
  it("sem nenhum vínculo -> null", () => {
    expect(resolveEffectiveAssignment([], cp, conn1, NOW)).toBeNull()
  })

  it("1) maior prioridade vence, mesmo contra um escopo mais específico", () => {
    const site = assignment({ scope: "SITE", siteId: "site1", priority: 10 })
    const connector = assignment({ scope: "CONNECTOR", connectorId: "c1", priority: 1 })
    expect(resolveEffectiveAssignment([connector, site], cp, conn1, NOW)?.id).toBe(site.id)
  })

  it("2) prioridade igual: escopo mais específico vence (CONNECTOR > CHARGE_POINT > SITE > OPERATOR)", () => {
    const op = assignment({ scope: "OPERATOR" })
    const site = assignment({ scope: "SITE", siteId: "site1" })
    const charger = assignment({ scope: "CHARGE_POINT", chargePointId: "cp1" })
    const connector = assignment({ scope: "CONNECTOR", connectorId: "c1" })
    expect(resolveEffectiveAssignment([op, site, charger, connector], cp, conn1, NOW)?.id).toBe(connector.id)
    expect(resolveEffectiveAssignment([op, site, charger, connector], cp, conn2, NOW)?.id).toBe(charger.id)
    expect(resolveEffectiveAssignment([op, site], cp, conn2, NOW)?.id).toBe(site.id)
  })

  it("3) empate total: o criado por último vence", () => {
    const older = assignment({ scope: "SITE", siteId: "site1", createdAt: "2026-02-01T00:00:00.000Z" })
    const newer = assignment({ scope: "SITE", siteId: "site1", createdAt: "2026-03-01T00:00:00.000Z" })
    expect(resolveEffectiveAssignment([older, newer], cp, conn1, NOW)?.id).toBe(newer.id)
  })

  it("ignora encerrado e agendado (cai para o que vale hoje)", () => {
    const expired = assignment({ scope: "CONNECTOR", connectorId: "c1", priority: 99, validTo: "2026-10-01T00:00:00.000Z" })
    const scheduled = assignment({ scope: "CONNECTOR", connectorId: "c1", priority: 99, validFrom: "2026-12-01T00:00:00.000Z" })
    const fallback = assignment({ scope: "OPERATOR" })
    expect(resolveEffectiveAssignment([expired, scheduled, fallback], cp, conn1, NOW)?.id).toBe(fallback.id)
  })
})

describe("getChargePointCoverage", () => {
  const connectors = [
    { id: "c1", connectorId: 1 },
    { id: "c2", connectorId: 2 },
  ] as Connector[]
  const full = { ...cp, connectors }

  it("sem vínculos: 'none' e todas as tomadas descobertas", () => {
    const cov = getChargePointCoverage([], full, NOW)
    expect(cov.state).toBe("none")
    expect(cov.uncovered).toBe(2)
  })

  it("só uma tomada coberta: 'partial'", () => {
    const cov = getChargePointCoverage([assignment({ scope: "CONNECTOR", connectorId: "c1" })], full, NOW)
    expect(cov.state).toBe("partial")
    expect(cov.uncovered).toBe(1)
  })

  it("mesma tarifa em todas: 'uniform' com o nome; tarifas diferentes: 'mixed'", () => {
    const base = assignment({ scope: "CHARGE_POINT", chargePointId: "cp1", tariffId: "tA", tariff: { id: "tA", name: "Padrão", model: "PER_KWH" } })
    expect(getChargePointCoverage([base], full, NOW)).toMatchObject({ state: "uniform", tariff: { id: "tA", name: "Padrão" } })
    const special = assignment({ scope: "CONNECTOR", connectorId: "c2", tariffId: "tB" })
    expect(getChargePointCoverage([base, special], full, NOW).state).toBe("mixed")
  })

  it("sem tomadas cadastradas: 'no-connectors'", () => {
    expect(getChargePointCoverage([], { ...cp, connectors: [] }, NOW).state).toBe("no-connectors")
  })

  it("vínculo de outro operador nunca cobre", () => {
    expect(getChargePointCoverage([assignment({ scope: "OPERATOR", operatorId: "opB" })], full, NOW).state).toBe("none")
  })
})

describe("datas do formulário", () => {
  it("início do dia e fim do dia no fuso local; vazio vira undefined", () => {
    const start = new Date(dateInputToStartIso("2026-10-30")!)
    const end = new Date(dateInputToEndIso("2026-10-30")!)
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()]).toEqual([2026, 9, 30, 0, 0])
    expect([end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds()]).toEqual([30, 23, 59, 59])
    expect(dateInputToStartIso("")).toBeUndefined()
    expect(dateInputToEndIso(undefined)).toBeUndefined()
  })

  it("ida e volta ISO <-> input date", () => {
    expect(isoToDateInput(dateInputToStartIso("2026-10-30"))).toBe("2026-10-30")
    expect(isoToDateInput(null)).toBe("")
  })
})
