import { describe, expect, it } from "vitest"
import { toCreateRequest } from "./useAddCardFlow"
import { CARD_TOKENIZATION_CHANNEL_SOURCE } from "@/types/cardTokenizationChannel"

const base = { cardToken: "tok", brand: "Visa" as const, last4: "1234", expiryMonth: 8, expiryYear: 2030 }

describe("toCreateRequest — mensagem da aba isolada -> corpo do POST /api/me/payment-methods", () => {
  it("manda token, bandeira, last4 e validade (PAN truncado, nunca o número)", () => {
    expect(toCreateRequest(base)).toEqual({ cardToken: "tok", brand: "Visa", last4: "1234", expiryMonth: 8, expiryYear: 2030 })
    expect(CARD_TOKENIZATION_CHANNEL_SOURCE).toBeTruthy()
  })

  it("last4 que não tem EXATAMENTE 4 dígitos não vai (o servidor recusaria o cadastro inteiro)", () => {
    for (const last4 of ["123", "12345", "12a4", "4111111111111234"]) {
      const request = toCreateRequest({ ...base, last4 })
      expect(request).not.toHaveProperty("last4")
      expect(request.cardToken).toBe("tok") // o cartão ainda salva
    }
  })

  it("validade fora da faixa ou não inteira: nenhum dos dois campos vai (o servidor exige os dois juntos)", () => {
    for (const bad of [{ expiryMonth: 13, expiryYear: 2030 }, { expiryMonth: 0, expiryYear: 2030 }, { expiryMonth: 8, expiryYear: 30 }, { expiryMonth: 8.5, expiryYear: 2030 }]) {
      const request = toCreateRequest({ ...base, ...bad })
      expect(request).not.toHaveProperty("expiryMonth")
      expect(request).not.toHaveProperty("expiryYear")
    }
  })
})
