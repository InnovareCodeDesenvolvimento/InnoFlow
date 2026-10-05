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
  /** `CardToken` do cofre da Cielo ("Cartão Protegido") — o que o servidor guarda. NUNCA o `PaymentToken` de uso único. */
  cardToken: string
  /** Últimos 4 dígitos do PAN — PAN TRUNCADO, que o PCI DSS permite guardar e transmitir (o servidor não depende mais de `GET /1/card/{token}`). */
  last4: string
  /** 1..12 */
  expiryMonth: number
  /** 4 dígitos */
  expiryYear: number
}

/**
 * Silent Order Post da Cielo, do lado do NAVEGADOR (C1.2 de `docs/GATEWAY-CIELO-PARQUE-VS-INNOFLOW.md`, F9-F14). Referência provada em
 * produção: `ParquedasFeiras/frontend/src/lib/cieloSop.ts`. O mecanismo NÃO é um `fetch` nosso nem um construtor: o script da Cielo expõe a FUNÇÃO
 * GLOBAL `bpSop_silentOrderPost(options)`, que lê os campos do NOSSO formulário pelas classes fixas `bp-sop-*` (contrato deles) e devolve o
 * resultado pelos callbacks de `options`. Nenhum `fetch` neste arquivo; PAN/CVV nunca são logados nem saem do navegador a não ser pelo próprio
 * script da Cielo.
 *
 * Diferença deliberada do Parque: `enableTokenize: "true"` (string, como a doc) liga o Cartão Protegido e o `onSuccess` devolve `CardToken`
 * reutilizável, em vez do `PaymentToken` de uso único — o InnoFlow salva o cartão. O NOME EXATO do campo no `onSuccess` está na doc e NÃO foi
 * exercitado contra a Cielo (o Parque nunca usou): `CardToken` é o esperado; se vier outro, falha com `SOP_SEM_CARD_TOKEN` (nunca grava um
 * `PaymentToken` como se fosse cofre).
 */

/** Classes que o script procura no DOM (CONTRATO DELES). `CardForm.tsx` as aplica; o CVV leva as duas porque o manual da Cielo se contradiz (`cardcvv` x `cardcvvc`). */
export const SOP_FIELD_CLASSES = {
  holder: "bp-sop-cardholdername",
  number: "bp-sop-cardnumber",
  expiration: "bp-sop-cardexpirationdate",
  cvv: "bp-sop-cardcvv",
} as const

/**
 * Hosts de onde o script do SOP pode vir (os mesmos que a CSP da página libera em `script-src`). A URL chega do servidor pela sessão de
 * tokenização; conferir aqui é defesa em profundidade — uma resposta adulterada não consegue fazer esta página (que vê PAN/CVV) carregar
 * código de um terceiro qualquer, mesmo que a CSP um dia fique frouxa.
 */
const SOP_SCRIPT_HOST = /^([a-z0-9-]+\.)+(pagador\.com\.br|cieloecommerce\.cielo\.com\.br)$/i

export function isAllowedSopScriptUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return url.protocol === "https:" && SOP_SCRIPT_HOST.test(url.hostname)
  } catch {
    return false
  }
}

/**
 * Caminho MOCK (sem rede nenhuma): só existe em DESENVOLVIMENTO/E2E (`import.meta.env.DEV`). Em produção o Vite troca a constante por `false` e o ramo inteiro — junto com
 * `tokenizeCardMock` e o prefixo `mocktok.` — sai do bundle (conferido por grep no `dist/` e pelo CI). Mesmo em dev, a URL tem de ser EXATAMENTE um dos hosts fictícios
 * (`mock.local`, `mock.invalid`, `fake.local`, sempre `https`): um `scriptUrl` qualquer que apenas CONTENHA "mock" (S-4 da auditoria do Órion) não pula a allowlist.
 */
const MOCK_SCRIPT_HOSTS = new Set(["mock.local", "mock.invalid", "fake.local"])

function isMockSopScriptUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return url.protocol === "https:" && MOCK_SCRIPT_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/** Erro tipado: a Cielo (via `onInvalid`) recusou o conteúdo dos campos — a mensagem já vem pronta, em português, dela. */
export class SopInvalidFieldsError extends Error {}

/** Erro tipado: script não carregou, URL não permitida, função global ausente, `onError`, ou resposta sem `CardToken`. `message` é um código curto (sem dado de cartão). */
export class SopTokenizationError extends Error {}

interface SopSuccess {
  CardToken?: unknown
  PaymentToken?: unknown
}
interface SopError {
  Code?: unknown
  Text?: unknown
}
interface SopInvalidItem {
  Field?: unknown
  Message?: unknown
}

interface SopOptions {
  accessToken: string
  onSuccess: (response: SopSuccess) => void
  onError: (response: SopError) => void
  onInvalid: (response: SopInvalidItem[]) => void
  /** Minúsculo ("sandbox" | "production"). */
  environment: "sandbox" | "production"
  /** Maiúsculo no exemplo oficial. */
  language: "PT"
  /** String "true" (como na doc): liga o Cartão Protegido e troca `PaymentToken` por `CardToken`. */
  enableTokenize: "true"
}

interface WindowWithSop extends Window {
  bpSop_silentOrderPost?: (options: SopOptions) => void
}

/** Quanto esperar por um callback do script antes de desistir (a Braspag costuma responder em 1-3 s). */
const SOP_CALLBACK_TIMEOUT_MS = 30_000

/** Quanto esperar pelo DOWNLOAD do script do SOP (sem `onload` nem `onerror` — rede que pendura — a tela ficava em "Validando cartão…" para sempre; S-6 do Órion). */
const SOP_SCRIPT_LOAD_TIMEOUT_MS = 15_000

/** Uma promessa por endereço, não por chamada: duas tentativas seguidas não injetam duas tags. Falha de rede limpa a entrada para a próxima tentativa poder recarregar. */
const scriptLoads = new Map<string, Promise<void>>()

function loadSopScript(url: string): Promise<void> {
  if ((window as WindowWithSop).bpSop_silentOrderPost) return Promise.resolve()
  const existing = scriptLoads.get(url)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = url
    script.async = true
    const timer = setTimeout(() => {
      scriptLoads.delete(url)
      script.remove()
      reject(new Error("SOP_SCRIPT_LOAD_TIMEOUT"))
    }, SOP_SCRIPT_LOAD_TIMEOUT_MS)
    script.onload = () => {
      clearTimeout(timer)
      resolve()
    }
    script.onerror = () => {
      clearTimeout(timer)
      scriptLoads.delete(url)
      script.remove()
      reject(new Error("SOP_SCRIPT_LOAD_ERROR"))
    }
    document.head.appendChild(script)
  })
  scriptLoads.set(url, promise)
  return promise
}

/**
 * Escreve nos campos que o script vai ler, NO ÚLTIMO INSTANTE e a partir dos valores já validados do formulário (não do que a tela mostra):
 *  - número só com DÍGITOS (a tela o agrupa de 4 em 4 e não há prova de que a Braspag tolere espaço);
 *  - validade em `MM/AAAA` num único campo (a Braspag recusou `MM/AA` em produção em 03/09/2026) — a tela tem Mês e Ano separados, então
 *    o campo que o script lê é um `<input type="hidden">` com a classe `bp-sop-cardexpirationdate`.
 * Entre esta escrita e a leitura do script não corre nada (um re-render do React poderia restaurar o valor agrupado). Escrever `.value` na mão
 * não dispara `onChange`, então não reabre ciclo de render. Campo ausente do DOM é erro de programação -> falha explícita, não silêncio.
 */
function writeSopFields(input: CardFormInput): void {
  const set = (cls: string, value: string) => {
    const el = document.querySelector<HTMLInputElement>(`.${cls}`)
    if (!el) throw new SopTokenizationError("SOP_CAMPO_AUSENTE")
    el.value = value
  }
  set(SOP_FIELD_CLASSES.number, input.cardNumber.replace(/\D/g, ""))
  set(SOP_FIELD_CLASSES.holder, input.holderName)
  set(SOP_FIELD_CLASSES.expiration, `${input.expiryMonth.padStart(2, "0")}/${input.expiryYear}`)
  set(SOP_FIELD_CLASSES.cvv, input.cvv)
}

function invalidFieldsMessage(items: SopInvalidItem[]): string {
  const messages = (Array.isArray(items) ? items : [])
    .map((item) => (typeof item?.Message === "string" ? item.Message.trim() : ""))
    .filter((m) => m.length > 0)
  return messages.length > 0 ? messages.join(" ") : "Confira os dados do cartão e tente novamente."
}

/** `CardToken` do `onSuccess`, com o nome de campo da doc; tolera só a variação de caixa do nome (a doc e os exemplos da Cielo oscilam), nunca outro campo. */
function extractCardToken(response: SopSuccess | null | undefined): string {
  if (!response || typeof response !== "object") return ""
  const key = Object.keys(response).find((k) => k.toLowerCase() === "cardtoken")
  const value = key ? (response as Record<string, unknown>)[key] : undefined
  return typeof value === "string" ? value.trim() : ""
}

function buildResult(cardToken: string, input: CardFormInput): TokenizeResult {
  return { cardToken, last4: input.cardNumber.replace(/\D/g, "").slice(-4), expiryMonth: Number(input.expiryMonth), expiryYear: Number(input.expiryYear) }
}

/** Sessão de tokenização vencida? Não adianta (nem convém) entregar um `accessToken` morto ao script: erro claro, sem rede. `expiresAt` ilegível = não bloqueia (o servidor decide). */
function isSessionExpired(session: MeCardTokenizationSessionResponse): boolean {
  const expiresAt = Date.parse(session.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= Date.now()
}

export async function tokenizeCard(session: MeCardTokenizationSessionResponse, input: CardFormInput): Promise<TokenizeResult> {
  if (isSessionExpired(session)) throw new SopTokenizationError("SOP_SESSAO_EXPIRADA")

  // O ramo mock só existe em dev; em produção a URL crua vai DIRETO para a allowlist. `import.meta.env.DEV &&` NA CONDIÇÃO (e não dentro da função) para o minificador
  // enxergar a constante `false` e descartar o ramo e o `tokenizeCardMock` (um `return false` dentro da função NÃO bastou: `mocktok.` continuou no bundle).
  if (import.meta.env.DEV && isMockSopScriptUrl(session.scriptUrl)) {
    return tokenizeCardMock(input)
  }

  if (!isAllowedSopScriptUrl(session.scriptUrl)) throw new SopTokenizationError("SOP_SCRIPT_URL_NAO_PERMITIDA")
  try {
    await loadSopScript(session.scriptUrl)
  } catch (err) {
    throw new SopTokenizationError(err instanceof Error && err.message === "SOP_SCRIPT_LOAD_TIMEOUT" ? "SOP_SCRIPT_LOAD_TIMEOUT" : "SOP_SCRIPT_LOAD_ERROR")
  }
  const sop = (window as WindowWithSop).bpSop_silentOrderPost
  if (!sop) throw new SopTokenizationError("SOP_SCRIPT_SEM_FUNCAO_GLOBAL")

  writeSopFields(input)

  return new Promise<TokenizeResult>((resolve, reject) => {
    // Rede de segurança: se o script nunca chamar nenhum callback, a tela não pode ficar em "Validando cartão" para sempre.
    const timer = setTimeout(() => reject(new SopTokenizationError("SOP_TIMEOUT")), SOP_CALLBACK_TIMEOUT_MS)
    const settle = <T,>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(timer)
      fn(value)
    }
    sop({
      accessToken: session.accessToken,
      environment: session.environment === "production" ? "production" : "sandbox",
      language: "PT",
      enableTokenize: "true",
      onSuccess: settle((response: SopSuccess) => {
        const cardToken = extractCardToken(response)
        if (!cardToken) {
          reject(new SopTokenizationError("SOP_SEM_CARD_TOKEN"))
          return
        }
        resolve(buildResult(cardToken, input))
      }),
      // `Code`/`Text` existem, mas sem lista fechada de códigos -> o chamador mostra mensagem genérica + este código curto (nada de dado de cartão).
      onError: settle(() => reject(new SopTokenizationError("SOP_ON_ERROR"))),
      onInvalid: settle((items: SopInvalidItem[]) => reject(new SopInvalidFieldsError(invalidFieldsMessage(items)))),
    })
  })
}

const mockSequenceByLast4 = new Map<string, number>()

/**
 * Simulação local — nunca bate em rede. Embute last4/validade/nome no próprio token (`mocks/meData.ts` decodifica de volta) só para o mock
 * "parecer" o que a Cielo guardaria; o CVV NUNCA entra no token. `last4`/validade também saem no resultado, como no caminho real.
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
  return buildResult(cardToken, input)
}
