import type { CardBrand } from "@/types/api"

/**
 * Detecção de bandeira por prefixo (BIN), no VOCABULÁRIO da Cielo (`Visa`, `Master`, `Elo`, `Amex`, `Hipercard`, `Diners`) — o script do
 * Silent Order Post NÃO devolve a bandeira, e `MeCreatePaymentMethodRequest.brand` é obrigatório. Por isso isto roda no documento isolado,
 * sobre o número ainda em memória, e só a string da bandeira sai daqui junto com o `cardToken`.
 *
 * ORDEM IMPORTA (achado em produção no Parque das Feiras, 19/09/2026, ver `docs/GATEWAY-CIELO-PARQUE-VS-INNOFLOW.md` F13): a regra mais
 * ESPECÍFICA vem primeiro. Com Visa/Discover/Diners antes, um Elo de prefixo 4 (401178, 438935, 451416...) virava Visa, um Elo 65xxxx virava
 * Discover e um Hipercard 3841 virava Diners ("começa com 38") — e bandeira errada é recusa na certa. Elo vem antes de tudo; Hipercard antes
 * de Diners. As faixas do Elo são as publicamente conhecidas, não exaustivas: um Elo fora delas cai em "bandeira não reconhecida", nunca é
 * cobrado com a bandeira errada.
 *
 * Discover e JCB existem no vocabulário da Cielo mas NÃO no `CardBrand` do nosso contrato (o backend só aceita as seis acima): são
 * reconhecidos aqui só para não serem engolidos por outra regra, e devolvem `null` (o formulário bloqueia em vez de adivinhar — salvar a
 * bandeira errada quebraria a exibição em "Meus cartões" sem como corrigir depois, porque o número não fica guardado em lugar nenhum).
 */
const ELO =
  /^(401178|401179|431274|438935|451416|457393|45763[12]|504175|627780|636297|636368|65003[1-9]|65004[0-9]|65005[01]|65040[5-9]|6504[1-3]\d|65048\d|65049\d|6505\d\d|65070\d|6507[12]\d|65090[1-9]|6509[12]\d|65165[2-9]|6516[67]\d|65500\d|655\d{3})/

const RULES: ReadonlyArray<readonly [RegExp, CardBrand | null]> = [
  [ELO, "Elo"],
  [/^(606282|3841)/, "Hipercard"],
  [/^3[47]/, "Amex"],
  [/^(30[0-5]|36|38)/, "Diners"],
  [/^(6011|65|64[4-9])/, null], // Discover: fora do nosso contrato
  [/^35(2[89]|[3-8]\d)/, null], // JCB: fora do nosso contrato
  [/^(5[1-5]|2(2[2-9][1-9]|[3-6]\d\d|7[01]\d|720))/, "Master"],
  [/^4/, "Visa"],
]

export function detectCardBrand(cardNumber: string): CardBrand | null {
  const digits = cardNumber.replace(/\D/g, "")
  if (digits.length < 6) return null
  for (const [pattern, brand] of RULES) {
    if (pattern.test(digits)) return brand
  }
  return null
}
