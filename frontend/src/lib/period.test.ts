import { describe, expect, it } from "vitest"
import { resolvePeriod } from "./period"

describe("resolvePeriod", () => {
  it("'hoje' devolve o mesmo dia em from e to", () => {
    const period = resolvePeriod("today")
    expect(period.from).toBe(period.to)
    expect(period.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("'7d' cobre 7 dias corridos (hoje incluso)", () => {
    const period = resolvePeriod("7d")
    const from = new Date(`${period.from}T00:00:00`)
    const to = new Date(`${period.to}T00:00:00`)
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
    expect(days).toBe(7)
  })

  it("'30d' cobre 30 dias corridos (hoje incluso)", () => {
    const period = resolvePeriod("30d")
    const from = new Date(`${period.from}T00:00:00`)
    const to = new Date(`${period.to}T00:00:00`)
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
    expect(days).toBe(30)
  })

  it("'custom' usa o range informado, sem recalcular", () => {
    const period = resolvePeriod("custom", { from: "2026-01-01", to: "2026-01-10" })
    expect(period).toEqual({ preset: "custom", from: "2026-01-01", to: "2026-01-10" })
  })
})
