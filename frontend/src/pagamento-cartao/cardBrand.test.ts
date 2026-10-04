import { describe, expect, it } from "vitest"
import { detectCardBrand } from "./cardBrand"

describe("detectCardBrand", () => {
  it("reconhece Visa (prefixo 4)", () => {
    expect(detectCardBrand("4111 1111 1111 1111")).toBe("Visa")
  })

  it("reconhece Mastercard (faixa 51-55 e 2221-2720)", () => {
    expect(detectCardBrand("5555555555554444")).toBe("Master")
    expect(detectCardBrand("2223000048400011")).toBe("Master")
  })

  it("reconhece Amex (34/37)", () => {
    expect(detectCardBrand("378282246310005")).toBe("Amex")
  })

  it("reconhece Diners (300-305, 36, 38)", () => {
    expect(detectCardBrand("30569309025904")).toBe("Diners")
  })

  it("reconhece Hipercard (606282, 3841)", () => {
    expect(detectCardBrand("6062825624254001")).toBe("Hipercard")
  })

  it("reconhece Elo em uma faixa conhecida", () => {
    expect(detectCardBrand("6362970000457013")).toBe("Elo")
  })

  it("ignora espaços e traços", () => {
    expect(detectCardBrand("4111-1111-1111-1111")).toBe("Visa")
  })

  it("devolve null para prefixo desconhecido — nunca adivinha", () => {
    expect(detectCardBrand("9999999999999999")).toBeNull()
  })

  it("devolve null para número incompleto", () => {
    expect(detectCardBrand("411")).toBeNull()
  })
})

// Achado em PRODUÇÃO no Parque das Feiras (19/09/2026): regras genéricas engoliam as específicas. Bandeira errada = recusa na certa.
describe("detectCardBrand — ordem das regras (Elo antes de Visa/Discover, Hipercard antes de Diners)", () => {
  it("Elo com prefixo 4 NÃO vira Visa", () => {
    for (const bin of ["4011780000000000", "4389350000000000", "4514160000000000", "4573930000000000"]) expect(detectCardBrand(bin)).toBe("Elo")
  })

  it("Elo com prefixo 65 NÃO vira Discover", () => {
    for (const bin of ["6500310000000000", "6504050000000000", "6516520000000000", "6550000000000000"]) expect(detectCardBrand(bin)).toBe("Elo")
  })

  it("Hipercard 3841 NÃO vira Diners (começa com 38)", () => {
    expect(detectCardBrand("3841000000000000000")).toBe("Hipercard")
    expect(detectCardBrand("3841001111111111111")).toBe("Hipercard")
  })

  it("Visa comum continua Visa (4111 não está nas faixas do Elo)", () => {
    expect(detectCardBrand("4111111111111111")).toBe("Visa")
  })

  it("Discover e JCB existem na Cielo mas não no nosso contrato: null (o formulário bloqueia, não adivinha)", () => {
    expect(detectCardBrand("6011000000000004")).toBeNull()
    expect(detectCardBrand("3530111333300000")).toBeNull()
  })
})
