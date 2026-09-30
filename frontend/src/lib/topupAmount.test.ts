import { describe, expect, it } from "vitest"
import {
  createTopupErrorMessage,
  debtSettledPreviewCents,
  debtWarningMessage,
  freeBalancePreviewCents,
  TOPUP_MAX_AMOUNT_CENTS,
  TOPUP_MIN_AMOUNT_CENTS,
  validateTopupAmount,
} from "./topupAmount"

// `Intl.NumberFormat` (via `formatCents`) usa NBSP entre "R$" e o valor, não espaço comum —
// normaliza antes de comparar (mesma armadilha documentada em `Carteiras.test.tsx`).
const flat = (s: string | null | undefined) => (s ?? "").split(String.fromCharCode(160)).join(" ")

describe("validateTopupAmount", () => {
  it("chip selecionado vence o texto livre", () => {
    expect(validateTopupAmount(5_000, "999999")).toEqual({ amountCents: 5_000, valid: true })
  })

  it("sem chip e sem texto: pede para escolher um valor", () => {
    const result = validateTopupAmount(null, "")
    expect(result.valid).toBe(false)
    expect(result.amountCents).toBeNull()
    expect(result.error).toMatch(/escolha um valor/i)
  })

  it("texto livre inválido", () => {
    const result = validateTopupAmount(null, "abc")
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/inválido/i)
  })

  it("abaixo do mínimo (R$ 10,00)", () => {
    const result = validateTopupAmount(null, "9,99")
    expect(result.valid).toBe(false)
    expect(result.amountCents).toBeNull()
    expect(flat(result.error)).toContain("R$ 10,00")
  })

  it("acima do máximo (R$ 500,00)", () => {
    const result = validateTopupAmount(null, "500,01")
    expect(result.valid).toBe(false)
    expect(flat(result.error)).toContain("R$ 500,00")
  })

  it("aceita exatamente os limites", () => {
    expect(validateTopupAmount(null, "10,00")).toEqual({ amountCents: TOPUP_MIN_AMOUNT_CENTS, valid: true })
    expect(validateTopupAmount(null, "500,00")).toEqual({ amountCents: TOPUP_MAX_AMOUNT_CENTS, valid: true })
  })

  it("valor livre dentro do range", () => {
    expect(validateTopupAmount(null, "35,50")).toEqual({ amountCents: 3_550, valid: true })
  })
})

describe("debt-aware previews", () => {
  it("sem dívida: nada é retido, mensagem some", () => {
    expect(debtSettledPreviewCents(5_000, 0)).toBe(0)
    expect(freeBalancePreviewCents(5_000, 0)).toBe(5_000)
    expect(debtWarningMessage(5_000, 0)).toBeNull()
  })

  it("dívida MENOR que o valor: quita tudo, sobra o resto como saldo livre", () => {
    expect(debtSettledPreviewCents(5_000, 1_850)).toBe(1_850)
    expect(freeBalancePreviewCents(5_000, 1_850)).toBe(3_150)
    expect(flat(debtWarningMessage(5_000, 1_850))).toBe("Os primeiros R$ 18,50 do seu crédito quitam a dívida em aberto automaticamente.")
  })

  it("dívida MAIOR OU IGUAL ao valor: tudo vira quitação, saldo livre zero", () => {
    expect(debtSettledPreviewCents(2_000, 5_000)).toBe(2_000)
    expect(freeBalancePreviewCents(2_000, 5_000)).toBe(0)
  })

  it("valor ainda inválido (null): nunca estoura, sem mensagem", () => {
    expect(debtSettledPreviewCents(null, 5_000)).toBe(0)
    expect(freeBalancePreviewCents(null, 5_000)).toBe(0)
    expect(debtWarningMessage(null, 5_000)).toBeNull()
  })
})

describe("createTopupErrorMessage", () => {
  it("mensagens conhecidas citam os limites/ação certa", () => {
    expect(flat(createTopupErrorMessage("TOPUP_AMOUNT_OUT_OF_RANGE"))).toContain("R$ 10,00")
    expect(createTopupErrorMessage("TOO_MANY_PENDING_TOPUPS")).toMatch(/aguardando pagamento/)
    expect(createTopupErrorMessage("INVALID_CPF")).toMatch(/CPF/)
  })

  it("código desconhecido cai no genérico", () => {
    expect(createTopupErrorMessage(undefined)).toMatch(/não foi possível/i)
    expect(createTopupErrorMessage("ALGO_NOVO")).toMatch(/não foi possível/i)
  })
})
