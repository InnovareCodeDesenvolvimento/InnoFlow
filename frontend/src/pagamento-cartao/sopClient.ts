import type { CardBrand, MeCardTokenizationSessionResponse } from "@/types/api"

export interface CardFormInput {
  /** Só dígitos — validado antes de chegar aqui (ver `CardForm.tsx`). */
  cardNumber: string
  holderName: string
  expiryMonth: string // "01".."12"
  expiryYear: string // 4 dígitos, ex. "2029"
  cvv: string
  brand: CardBrand
}

export interface TokenizeResult {
  cardToken: string
}

/**
 * Enquanto a Cielo não confirma a URL real do Silent Order Post (pergunta em
 * aberto, ver PROGRESSO.md §F5), tanto o `FakeAdapter` do backend
 * (`https://fake.local/sop/script.js`) quanto o mock MSW deste frontend
 * (`mocks/meData.ts`) devolvem um `scriptUrl` "óbvio" contendo `mock` ou
 * `fake` — reconhecido aqui para cair no caminho local, sem bater em rede
 * nenhuma. Funciona testando contra os dois: só o MSW (`VITE_USE_MOCKS=true`)
 * OU o backend real sem `CIELO_MERCHANT_ID`/`CIELO_MERCHANT_KEY` configurados
 * (cai sozinho para `FakeAdapter`, ver `pagamentoPortInstance.ts`).
 */
const MOCK_SCRIPT_URL_PATTERN = /mock|fake/i

/**
 * Ponto de plugue do SDK real da Cielo (Silent Order Post). Nem a URL do
 * script nem o nome da função que ele expõe foram confirmados ainda (3
 * perguntas em aberto pro comercial da Cielo, ver PROGRESSO.md §F5) — por
 * isso não há nenhuma chamada de rede real aqui hoje.
 *
 * QUANDO a Cielo confirmar: injetar `<script src={session.scriptUrl}>`
 * DINAMICAMENTE aqui dentro (nunca no HTML estático de `pagamento-cartao.html`
 * — script-src da CSP isolada só libera esse host exato quando o Vulcano
 * configurar, ver nginx.conf.template) e chamar a função real de
 * tokenização do SDK no lugar do bloco mock. Regra que NÃO muda: nenhum
 * PAN/CVV pode ser logado nem enviado a qualquer domínio que não seja o da
 * própria Cielo — nem ao nosso backend (recomendação preventiva do Órion,
 * ver PROGRESSO.md §Portão da F5).
 */
export async function tokenizeCard(session: MeCardTokenizationSessionResponse, input: CardFormInput): Promise<TokenizeResult> {
  if (MOCK_SCRIPT_URL_PATTERN.test(session.scriptUrl)) {
    return tokenizeCardMock(input)
  }
  throw new Error("Silent Order Post real ainda não configurado (scriptUrl fora do padrão mock/fake) — ver PROGRESSO.md §F5.")
}

const mockSequenceByLast4 = new Map<string, number>()

/**
 * Simulação local — nunca bate em rede. Embute last4/validade/nome no
 * próprio token (`mocks/meData.ts` decodifica de volta) só para o mock
 * "parecer" o que a Cielo devolveria via `GET /1/card/{token}` num ambiente
 * real (3ª pergunta em aberto pro comercial, PROGRESSO.md §F5) — o CVV NUNCA
 * entra no token, nem aqui nem no mundo real (a Cielo não permite consultar
 * CVV depois da tokenização).
 */
async function tokenizeCardMock(input: CardFormInput): Promise<TokenizeResult> {
  await new Promise((resolve) => setTimeout(resolve, 900)) // simula a ida e volta até a Cielo
  const last4 = input.cardNumber.slice(-4)
  const seq = (mockSequenceByLast4.get(last4) ?? 0) + 1
  mockSequenceByLast4.set(last4, seq)
  // TextEncoder em vez de escape/unescape (descontinuados) — btoa só aceita Latin1, nome do titular pode ter acento.
  const holderBytes = new TextEncoder().encode(input.holderName.trim().slice(0, 40))
  const holderB64 = btoa(String.fromCharCode(...holderBytes))
  const cardToken = `mocktok.${last4}.${input.expiryMonth}${input.expiryYear}.${holderB64}.${Date.now()}${seq}`
  return { cardToken }
}
