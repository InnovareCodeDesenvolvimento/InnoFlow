import { describe, expect, it } from "vitest"
import { CHECKLIST_ITEMS } from "./checklistScript"
import { deriveChecklist, hasActiveAssignment, isCommunicationActive, isGatewayReady } from "./checklistLogic"

const ALL_DONE = { site: true, chargePoint: true, connector: true, tariff: true, assignment: true, gateway: true, communication: true }

describe("deriveChecklist", () => {
  it("tudo feito: completo, o card some", () => {
    const v = deriveChecklist(ALL_DONE)
    expect(v.complete).toBe(true)
    expect(v.doneCount).toBe(CHECKLIST_ITEMS.length)
  })

  it("operação nova (nada feito): 0 de 7, na ordem natural de montar a operação", () => {
    const v = deriveChecklist({ site: false, chargePoint: false, connector: false, tariff: false, assignment: false, gateway: false, communication: false })
    expect(v.complete).toBe(false)
    expect(v.doneCount).toBe(0)
    expect(v.total).toBe(7)
    expect(v.items.map((i) => i.key)).toEqual(["site", "chargePoint", "connector", "tariff", "assignment", "gateway", "communication"])
  })

  it("só falta o gateway: aparece 6 de 7 com UM item pendente", () => {
    const v = deriveChecklist({ ...ALL_DONE, gateway: false })
    expect(v.complete).toBe(false)
    expect(v.doneCount).toBe(6)
    expect(v.items.filter((i) => i.state === "todo").map((i) => i.key)).toEqual(["gateway"])
  })

  it("dado desconhecido (consulta falhou) NÃO vira pendência: o item some e não conta", () => {
    const v = deriveChecklist({ ...ALL_DONE, gateway: undefined, communication: undefined })
    expect(v.items.map((i) => i.key)).not.toContain("gateway")
    expect(v.total).toBe(5)
    expect(v.complete).toBe(true)
  })

  it("nada verificável: some (sem ruído)", () => {
    const v = deriveChecklist({})
    expect(v.items).toEqual([])
    expect(v.complete).toBe(true)
  })

  it("todo item aponta para uma rota do painel", () => {
    for (const item of CHECKLIST_ITEMS) expect(item.href).toMatch(/^\/admin\/[a-z-]+(\/[a-z-]+)?$/)
  })
})

describe("fatos derivados das telas", () => {
  const NOW = Date.parse("2026-10-05T12:00:00Z")
  it("vínculo em vigor: sem fim ou com fim no futuro", () => {
    expect(hasActiveAssignment([{ validTo: null }], 1, NOW)).toBe(true)
    expect(hasActiveAssignment([{ validTo: "2026-12-01T00:00:00Z" }], 1, NOW)).toBe(true)
    expect(hasActiveAssignment([{ validTo: "2026-09-01T00:00:00Z" }], 1, NOW)).toBe(false)
    expect(hasActiveAssignment([], 0, NOW)).toBe(false)
  })
  it("mais vínculos do que a página trouxe: existe ao menos um em vigor (não afirma ausência)", () => {
    expect(hasActiveAssignment([{ validTo: "2026-01-01T00:00:00Z" }], 250, NOW)).toBe(true)
  })
  it("gateway pronto = algum meio LIGADO e com pré-requisitos", () => {
    const base = { cardEnabled: false, pixEnabled: false, readiness: { card: { ready: true }, pix: { ready: true } } }
    expect(isGatewayReady(base)).toBe(false)
    expect(isGatewayReady({ ...base, pixEnabled: true })).toBe(true)
    expect(isGatewayReady({ ...base, cardEnabled: true, readiness: { card: { ready: false }, pix: { ready: true } } })).toBe(false)
  })
  it("comunicação: algum canal ATIVO (não basta estar ligado)", () => {
    expect(isCommunicationActive({ email: { active: false }, whatsapp: { active: false } })).toBe(false)
    expect(isCommunicationActive({ email: { active: false }, whatsapp: { active: true } })).toBe(true)
  })
})
