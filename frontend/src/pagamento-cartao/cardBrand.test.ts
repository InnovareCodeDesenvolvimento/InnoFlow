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
