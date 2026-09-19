import { describe, expect, it } from "vitest"
import {
  adjustmentSummary,
  balanceAfter,
  toSignedCents,
  validateAdjustment,
  walletAdjustmentErrorMessage,
  WALLET_ADJUSTMENT_MAX_CENTS,
  type AdjustmentDraft,
} from "./walletAdjustment"

const draft = (over: Partial<AdjustmentDraft> = {}): AdjustmentDraft => ({ kind: "credit", amountInput: "50,00", description: "Saldo de teste", ...over })

describe("validateAdjustment", () => {
  it("crédito válido: valor em centavos inteiros, descrição com trim", () => {
    const v = validateAdjustment(draft({ description: "  Saldo de teste  " }), 0)
    expect(v.valid).toBe(true)
    expect(v.amountCents).toBe(5000)
    expect(v.description).toBe("Saldo de teste")
  })

  it("valor vazio, inválido e zero", () => {
    expect(validateAdjustment(draft({ amountInput: "" }), 0).errors.amount).toMatch(/Informe o valor/)
    expect(validateAdjustment(draft({ amountInput: "abc" }), 0).errors.amount).toMatch(/inválido/)
    expect(validateAdjustment(draft({ amountInput: "0" }), 0).errors.amount).toMatch(/maior que zero/)
    expect(validateAdjustment(draft({ amountInput: "0,00" }), 0).valid).toBe(false)
  })

  it("teto de R$ 5.000 por lançamento: exatamente o teto passa, 1 centavo a mais não", () => {
    expect(validateAdjustment(draft({ amountInput: "5.000,00" }), 0).valid).toBe(true)
    expect(validateAdjustment(draft({ amountInput: "5.000,01" }), 0).errors.amount).toContain("R$")
    expect(WALLET_ADJUSTMENT_MAX_CENTS).toBe(500_000)
  })

  it("descrição: mínimo de 5 caracteres DEPOIS do trim (espaços não valem) e máximo de 500", () => {
    expect(validateAdjustment(draft({ description: "abc" }), 0).errors.description).toMatch(/mínimo de 5/)
    expect(validateAdjustment(draft({ description: "  ab   " }), 0).errors.description).toBeDefined()
    expect(validateAdjustment(draft({ description: "abcde" }), 0).errors.description).toBeUndefined()
    expect(validateAdjustment(draft({ description: "x".repeat(501) }), 0).errors.description).toMatch(/500/)
  })

  it("débito maior que o saldo é barrado antes de ir ao servidor; igual ao saldo passa", () => {
    expect(validateAdjustment(draft({ kind: "debit", amountInput: "60" }), 5000).errors.amount).toMatch(/saldo atual/)
    expect(validateAdjustment(draft({ kind: "debit", amountInput: "50" }), 5000).valid).toBe(true)
    // crédito nunca é limitado pelo saldo
    expect(validateAdjustment(draft({ kind: "credit", amountInput: "60" }), 0).valid).toBe(true)
  })

  it("acumula os dois erros e não expõe valor quando o valor é inválido", () => {
    const v = validateAdjustment(draft({ amountInput: "x", description: "" }), 0)
    expect(v.valid).toBe(false)
    expect(v.errors.amount).toBeDefined()
    expect(v.errors.description).toBeDefined()
    expect(v.amountCents).toBeNull()
  })
})

describe("sinal, saldo previsto e frase de confirmação", () => {
  it("crédito é positivo, débito é negativo (contrato assinado)", () => {
    expect(toSignedCents("credit", 5000)).toBe(5000)
    expect(toSignedCents("debit", 5000)).toBe(-5000)
  })

  it("saldo previsto em inteiros", () => {
    expect(balanceAfter("credit", 5000, 1999)).toBe(6999)
    expect(balanceAfter("debit", 1999, 5000)).toBe(3001)
  })

  it("'Creditar R$ 50,00 para Fulano' / 'Debitar R$ 12,34 de Fulano'", () => {
    expect(adjustmentSummary("credit", 5000, "Carla Motorista").replace(/\u00a0/g, " ")).toBe("Creditar R$ 50,00 para Carla Motorista")
    expect(adjustmentSummary("debit", 1234, "Carla Motorista").replace(/\u00a0/g, " ")).toBe("Debitar R$ 12,34 de Carla Motorista")
  })
})

describe("walletAdjustmentErrorMessage — por código, em português", () => {
  it.each([
    ["INSUFFICIENT_BALANCE", /Saldo insuficiente/],
    ["FORBIDDEN", /administradores/],
    ["NOT_FOUND", /não encontrado/],
    ["VALIDATION_ERROR", /teto/],
  ])("%s", (code, pattern) => {
    expect(walletAdjustmentErrorMessage(code)).toMatch(pattern)
  })

  it("código desconhecido ou ausente: genérico, garantindo que nada foi alterado", () => {
    expect(walletAdjustmentErrorMessage(undefined)).toMatch(/Nada foi alterado/)
    expect(walletAdjustmentErrorMessage("OUTRO")).toMatch(/Nada foi alterado/)
  })
})
