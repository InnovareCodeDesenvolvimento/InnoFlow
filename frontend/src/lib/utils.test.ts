import { describe, expect, it } from "vitest"
import {
  centsToReais,
  formatCents,
  formatCurrency,
  formatDate,
  formatDurationMinutes,
  formatEnergyWh,
  formatPercent,
  formatPowerKw,
  reaisToCents,
} from "./utils"

describe("formatCurrency", () => {
  it("formata um número em reais", () => {
    expect(formatCurrency(19.9)).toBe("R$ 19,90")
  })

  it("trata string Decimal do Prisma", () => {
    expect(formatCurrency("0.7912")).toBe("R$ 0,79")
  })

  it("nunca estoura em valor ausente — devolve R$ 0,00", () => {
    expect(formatCurrency(null)).toBe("R$ 0,00")
    expect(formatCurrency(undefined)).toBe("R$ 0,00")
  })
})

describe("formatDate", () => {
  it("nunca estoura em data ausente/inválida — devolve travessão", () => {
    expect(formatDate(null)).toBe("—")
    expect(formatDate(undefined)).toBe("—")
    expect(formatDate("")).toBe("—")
    expect(formatDate("não-é-uma-data")).toBe("—")
  })

  it("formata uma data ISO válida", () => {
    expect(formatDate("2026-01-15T00:00:00.000Z")).toMatch(/15\/01\/2026|14\/01\/2026/)
  })
})

describe("centavos <-> reais (tarifa)", () => {
  it("converte reais digitados no formulário para centavos da API", () => {
    expect(reaisToCents(1.5)).toBe(150)
    expect(reaisToCents(0)).toBe(0)
    expect(reaisToCents(undefined)).toBeUndefined()
  })

  it("converte centavos da API para reais do formulário", () => {
    expect(centsToReais(150)).toBe(1.5)
    expect(centsToReais(null)).toBeUndefined()
  })

  it("formatCents nunca estoura em centavos ausentes", () => {
    expect(formatCents(null)).toBe("R$ 0,00")
    expect(formatCents(150)).toBe("R$ 1,50")
  })
})

describe("formatPowerKw", () => {
  it("devolve travessão para potência ausente ou zero", () => {
    expect(formatPowerKw(null)).toBe("—")
    expect(formatPowerKw(0)).toBe("—")
  })

  it("formata a potência com a unidade kW", () => {
    expect(formatPowerKw(50)).toBe("50 kW")
    expect(formatPowerKw(7.4)).toBe("7.4 kW")
  })
})

describe("formatEnergyWh (retaguarda)", () => {
  it("converte Wh inteiros (contrato da API) para kWh", () => {
    expect(formatEnergyWh(1000)).toBe("1,0 kWh")
    expect(formatEnergyWh(43015)).toBe("43,02 kWh")
  })

  it("devolve travessão para energia ausente", () => {
    expect(formatEnergyWh(null)).toBe("—")
    expect(formatEnergyWh(undefined)).toBe("—")
  })
})

describe("formatPercent (retaguarda)", () => {
  it("formata com uma casa decimal por padrão", () => {
    expect(formatPercent(96.73)).toBe("96.7%")
  })

  it("devolve travessão para valor ausente/NaN — nunca ∞ (regra do dashboard)", () => {
    expect(formatPercent(null)).toBe("—")
    expect(formatPercent(undefined)).toBe("—")
    expect(formatPercent(Number.NaN)).toBe("—")
  })
})

describe("formatDurationMinutes (retaguarda)", () => {
  it("formata minutos menores que 1h só em minutos", () => {
    expect(formatDurationMinutes(45)).toBe("45 min")
  })

  it("formata horas e minutos quando >= 60min", () => {
    expect(formatDurationMinutes(125)).toBe("2h 5min")
  })

  it("devolve travessão para duração ausente ou negativa", () => {
    expect(formatDurationMinutes(null)).toBe("—")
    expect(formatDurationMinutes(-5)).toBe("—")
  })
})
