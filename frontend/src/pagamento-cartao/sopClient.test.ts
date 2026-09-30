import { describe, expect, it } from "vitest"
import { tokenizeCard } from "./sopClient"

const mockSession = {
  accessToken: "access_mock",
  merchantId: "merchant_mock",
  environment: "sandbox" as const,
  scriptUrl: "https://mock.invalid/mock-sop.js",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
}

describe("tokenizeCard", () => {
  it("usa o caminho mock quando scriptUrl contém o marcador — nunca bate em rede", async () => {
    const result = await tokenizeCard(mockSession, {
      cardNumber: "4111111111115678",
      holderName: "Maria Teste",
      expiryMonth: "08",
      expiryYear: "2030",
      cvv: "091",
      brand: "Visa",
    })
    expect(result.cardToken).toMatch(/^mocktok\.5678\.082030\./)
    // CVV nunca aparece no token, em nenhuma forma (cvv escolhido de propósito pra não colidir com last4/validade/timestamp).
    expect(result.cardToken).not.toContain("091")
  })

  it("rejeita quando scriptUrl real (fora do marcador mock) ainda não tem SDK plugado", async () => {
    await expect(
      tokenizeCard(
        { ...mockSession, scriptUrl: "https://tokenizacao.cieloecommerce.cielo.com.br/sop.js" },
        { cardNumber: "4111111111111234", holderName: "Maria Teste", expiryMonth: "08", expiryYear: "2030", cvv: "123", brand: "Visa" },
      ),
    ).rejects.toThrow(/Silent Order Post real/)
  })

  it("gera tokens diferentes para o mesmo cartão em chamadas sucessivas (evita colisão no mock de listagem)", async () => {
    const first = await tokenizeCard(mockSession, {
      cardNumber: "4111111111115678",
      holderName: "Maria Teste",
      expiryMonth: "01",
      expiryYear: "2028",
      cvv: "999",
      brand: "Visa",
    })
    const second = await tokenizeCard(mockSession, {
      cardNumber: "4111111111115678",
      holderName: "Maria Teste",
      expiryMonth: "01",
      expiryYear: "2028",
      cvv: "999",
      brand: "Visa",
    })
    expect(first.cardToken).not.toBe(second.cardToken)
  })
})
