import { describe, expect, it } from "vitest"
import { formatCpf, isValidCpf, onlyDigits } from "./cpf"

describe("onlyDigits", () => {
  it("remove tudo que não é dígito", () => {
    expect(onlyDigits("123.456.789-09")).toBe("12345678909")
    expect(onlyDigits("")).toBe("")
  })
})

describe("formatCpf", () => {
  it("aplica a máscara conforme os dígitos chegam", () => {
    expect(formatCpf("123")).toBe("123")
    expect(formatCpf("123456")).toBe("123.456")
    expect(formatCpf("123456789")).toBe("123.456.789")
    expect(formatCpf("12345678909")).toBe("123.456.789-09")
  })

  it("ignora pontuação colada e caracteres além de 11 dígitos", () => {
    expect(formatCpf("123.456.789-09999")).toBe("123.456.789-09")
  })
})

describe("isValidCpf", () => {
  it("aceita um CPF com dígito verificador correto (gerado com a fórmula oficial)", () => {
    expect(isValidCpf("111.444.777-35")).toBe(true)
    expect(isValidCpf("11144477735")).toBe(true)
  })

  it("rejeita dígito verificador errado", () => {
    expect(isValidCpf("111.444.777-36")).toBe(false)
  })

  it("rejeita sequências de dígito único (passam no cálculo mas não são CPF real)", () => {
    expect(isValidCpf("000.000.000-00")).toBe(false)
    expect(isValidCpf("11111111111")).toBe(false)
  })

  it("rejeita tamanho errado e campo vazio", () => {
    expect(isValidCpf("123")).toBe(false)
    expect(isValidCpf("")).toBe(false)
  })
})
