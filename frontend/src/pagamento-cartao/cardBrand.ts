import type { CardBrand } from "@/types/api"

/**
 * Detecção de bandeira por prefixo (BIN) — best-effort, faixas usuais do
 * mercado brasileiro (não exaustivo, sobretudo em Elo, que tem dezenas de
 * faixas emitidas por bancos diferentes). A sessão de tokenização da Cielo
 * não devolve a bandeira, e `MeCreatePaymentMethodRequest.brand` é
 * obrigatório — por isso ISTO roda no documento isolado, sobre o número
 * ainda em memória, e só o resultado (a string da bandeira) sai daqui junto
 * com o `cardToken`.
 *
 * Se não reconhecer, devolve `null` — o formulário BLOQUEIA o envio em vez
 * de adivinhar. Salvar a bandeira errada quebraria silenciosamente a
 * exibição em "Meus cartões" sem ninguém perceber (e o valor não é mais
 * corrigível depois, porque o número não fica guardado em lugar nenhum).
 */
export function detectCardBrand(cardNumber: string): CardBrand | null {
  const digits = cardNumber.replace(/\D/g, "")
  if (digits.length < 6) return null

  if (/^4/.test(digits)) return "Visa"
  if (/^3[47]/.test(digits)) return "Amex"
  if (/^3(?:0[0-5]|[68])/.test(digits)) return "Diners"
  if (/^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return "Master"
  if (/^(?:606282|3841)/.test(digits)) return "Hipercard"
  if (/^(?:4011|4312|4389|4514|4573|506699|5067|509|6277|627780|6362|6363|650|6516|6550)/.test(digits)) return "Elo"
  return null
}
