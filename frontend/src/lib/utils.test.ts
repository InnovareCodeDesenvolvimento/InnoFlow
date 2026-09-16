import { describe, expect, it } from "vitest"
import { centsToReais, formatCents, formatCurrency, formatDate, formatPowerKw, reaisToCents } from "./utils"

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
