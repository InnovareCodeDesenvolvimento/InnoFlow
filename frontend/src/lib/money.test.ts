import { describe, expect, it } from "vitest"
import { parseReaisToCents } from "./money"

describe("parseReaisToCents — dinheiro sem float", () => {
  it.each([
    ["50", 5000],
    ["50,00", 5000],
    ["50,5", 5050],
    ["0,05", 5],
    ["0,5", 50],
    ["1.250,00", 125000],
    ["1.250", 125000], // 3 dígitos depois do ponto = milhar (pt-BR)
    ["50.555", 5055500], // idem: é cinquenta mil — a confirmação e o teto de R$ 5.000 mostram isso em voz alta
    ["50.5", 5050], // 1–2 dígitos = decimal (colado de planilha)
    ["50.50", 5050],
    ["R$ 50,00", 5000],
    ["  5.000,00 ", 500000],
    ["1.234.567,89", 123456789],
    ["0", 0],
  ])("%s → %d centavos", (input, cents) => {
    expect(parseReaisToCents(input)).toBe(cents)
  })

  it("não sofre do erro clássico de ponto flutuante (19,99 e 1,15 viram centavos exatos)", () => {
    // Em float: 19.99 * 100 = 1998.9999999999998 e 1.15 * 100 = 114.99999999999999.
    expect(19.99 * 100).not.toBe(1999)
    expect(parseReaisToCents("19,99")).toBe(1999)
    expect(parseReaisToCents("1,15")).toBe(115)
    expect(parseReaisToCents("4.35")).toBe(435)
    expect(parseReaisToCents("0,29")).toBe(29)
  })

  it.each(["", "  ", "abc", "-50", "+50", "5e3", "50,", ",5", "50,555", "1,2,3", "1..250", "12.34.56", "1.25.0", "R$", "50 00"])(
    "rejeita %j",
    (input) => {
      expect(parseReaisToCents(input)).toBeNull()
    },
  )

  it("não deixa estourar o inteiro seguro", () => {
    expect(parseReaisToCents("9".repeat(13))).toBeNull()
    expect(Number.isSafeInteger(parseReaisToCents("9".repeat(12)) as number)).toBe(true)
  })
})
