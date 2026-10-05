import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SopInvalidFieldsError, SopTokenizationError, isAllowedSopScriptUrl, tokenizeCard, type CardFormInput } from "./sopClient"

const mockSession = {
  accessToken: "access_mock",
  environment: "sandbox" as const,
  scriptUrl: "https://mock.invalid/mock-sop.js",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
}

const realSession = {
  accessToken: "sop-access-token-do-passo-2",
  environment: "sandbox" as const,
  scriptUrl: "https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js",
  expiresAt: new Date(Date.now() + 1_200_000).toISOString(),
}

const card: CardFormInput = {
  cardNumber: "4111111111115678",
  holderName: "Maria Teste",
  expiryMonth: "08",
  expiryYear: "2030",
  cvv: "091",
  brand: "Visa",
}

describe("tokenizeCard — caminho mock", () => {
  it("usa o caminho mock quando scriptUrl contém o marcador — nunca bate em rede — e devolve last4/validade", async () => {
    const result = await tokenizeCard(mockSession, card)
    expect(result.cardToken).toMatch(/^mocktok\.5678\.082030\./)
    expect(result).toMatchObject({ last4: "5678", expiryMonth: 8, expiryYear: 2030 })
    // CVV nunca aparece no token, em nenhuma forma (cvv escolhido de propósito pra não colidir com last4/validade/timestamp).
    expect(result.cardToken).not.toContain("091")
  })

  it("gera tokens diferentes para o mesmo cartão em chamadas sucessivas (evita colisão no mock de listagem)", async () => {
    const first = await tokenizeCard(mockSession, { ...card, expiryMonth: "01", expiryYear: "2028", cvv: "999" })
    const second = await tokenizeCard(mockSession, { ...card, expiryMonth: "01", expiryYear: "2028", cvv: "999" })
    expect(first.cardToken).not.toBe(second.cardToken)
  })
})

describe("isAllowedSopScriptUrl — só os hosts que a CSP libera", () => {
  it.each([
    ["https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js", true],
    ["https://transaction.cieloecommerce.cielo.com.br/post/scripts/silentorderpost-1.0.min.js", true],
    ["https://www.pagador.com.br/post/scripts/silentorderpost-1.0.min.js", true],
    ["http://transactionsandbox.pagador.com.br/x.js", false], // sem TLS
    ["https://pagador.com.br.evil.example/x.js", false], // sufixo enganoso
    ["https://evilpagador.com.br/x.js", false], // sem ponto antes do domínio
    ["https://cdn.exemplo.com/silentorderpost.js", false],
    ["not a url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isAllowedSopScriptUrl(url)).toBe(expected)
  })
})

describe("tokenizeCard — caminho REAL (função global bpSop_silentOrderPost)", () => {
  type Options = {
    accessToken: string
    environment: string
    language: string
    enableTokenize: string
    onSuccess: (r: unknown) => void
    onError: (r: unknown) => void
    onInvalid: (r: unknown) => void
  }
  let received: Options | null
  let seenAtCall: { number: string; holder: string; expiration: string; cvv: string } | null
  const w = window as unknown as { bpSop_silentOrderPost?: (o: Options) => void }

  /** Reproduz o que o form faz: 4 campos marcados com as classes da Cielo; o número aparece AGRUPADO e a validade em Mês/Ano separados -> campo hidden composto. */
  function mountFields() {
    document.body.innerHTML = `
      <input class="bp-sop-cardnumber" value="4111 1111 1111 5678" />
      <input class="bp-sop-cardholdername" value="" />
      <input type="hidden" class="bp-sop-cardexpirationdate" value="" />
      <input class="bp-sop-cardcvv bp-sop-cardcvvc" value="" />`
  }
  const field = (cls: string) => document.querySelector<HTMLInputElement>(`.${cls}`)!.value

  beforeEach(() => {
    received = null
    seenAtCall = null
    mountFields()
    w.bpSop_silentOrderPost = (options) => {
      received = options
      seenAtCall = { number: field("bp-sop-cardnumber"), holder: field("bp-sop-cardholdername"), expiration: field("bp-sop-cardexpirationdate"), cvv: field("bp-sop-cardcvv") }
    }
  })
  afterEach(() => {
    delete w.bpSop_silentOrderPost
    document.body.innerHTML = ""
    vi.useRealTimers()
  })

  it("chama o script com o contrato da Cielo: accessToken do passo 2, environment minúsculo, language PT e enableTokenize STRING 'true'", async () => {
    const pending = tokenizeCard(realSession, card)
    await vi.waitFor(() => expect(received).not.toBeNull())
    expect(received).toMatchObject({ accessToken: "sop-access-token-do-passo-2", environment: "sandbox", language: "PT", enableTokenize: "true" })
    received!.onSuccess({ CardToken: "cardtoken-do-cofre" })
    await pending
  })

  it("normaliza NO ÚLTIMO INSTANTE: número só com dígitos, validade MM/AAAA, nome e CVV nos campos que o script lê", async () => {
    const pending = tokenizeCard(realSession, card)
    await vi.waitFor(() => expect(received).not.toBeNull())
    expect(seenAtCall).toEqual({ number: "4111111111115678", holder: "Maria Teste", expiration: "08/2030", cvv: "091" })
    received!.onSuccess({ CardToken: "x" })
    await pending
  })

  it("em produção manda environment 'production' (minúsculo)", async () => {
    const pending = tokenizeCard({ ...realSession, environment: "production", scriptUrl: "https://transaction.cieloecommerce.cielo.com.br/post/scripts/silentorderpost-1.0.min.js" }, card)
    await vi.waitFor(() => expect(received).not.toBeNull())
    expect(received!.environment).toBe("production")
    received!.onSuccess({ CardToken: "x" })
    await pending
  })

  it("onSuccess com CardToken: resolve com token + last4 + validade (PAN truncado), sem CVV em lugar nenhum", async () => {
    const pending = tokenizeCard(realSession, card)
    await vi.waitFor(() => expect(received).not.toBeNull())
    received!.onSuccess({ CardToken: "  cardtoken-do-cofre  " })
    const result = await pending
    expect(result).toEqual({ cardToken: "cardtoken-do-cofre", last4: "5678", expiryMonth: 8, expiryYear: 2030 })
    expect(JSON.stringify(result)).not.toContain("091")
  })

  it("onSuccess só com PaymentToken (uso único, não é do cofre): REJEITA em vez de gravar um token inútil", async () => {
    const pending = tokenizeCard(realSession, card)
    await vi.waitFor(() => expect(received).not.toBeNull())
    received!.onSuccess({ PaymentToken: "uso-unico" })
    await expect(pending).rejects.toThrow("SOP_SEM_CARD_TOKEN")
  })

  it("onInvalid: erro tipado com as mensagens (em português) que a Cielo devolveu", async () => {
    const pending = tokenizeCard(realSession, card)
    await vi.waitFor(() => expect(received).not.toBeNull())
    received!.onInvalid([{ Field: "cardnumber", Message: "Número do cartão inválido." }, { Field: "cvv", Message: "CVV inválido." }])
    await expect(pending).rejects.toBeInstanceOf(SopInvalidFieldsError)
    await pending.catch((e: Error) => expect(e.message).toBe("Número do cartão inválido. CVV inválido."))
  })

  it("onError: código curto, sem dado de cartão", async () => {
    const pending = tokenizeCard(realSession, card)
    await vi.waitFor(() => expect(received).not.toBeNull())
    received!.onError({ Code: "999", Text: "falha" })
    await expect(pending).rejects.toThrow("SOP_ON_ERROR")
  })

  it("script que nunca chama nenhum callback: desiste (a tela não fica em 'Validando' para sempre)", async () => {
    vi.useFakeTimers()
    const pending = tokenizeCard(realSession, card)
    const assertion = expect(pending).rejects.toThrow("SOP_TIMEOUT")
    await vi.advanceTimersByTimeAsync(31_000)
    await assertion
  })

  it("scriptUrl fora dos hosts da Cielo: recusa SEM carregar nada", async () => {
    delete w.bpSop_silentOrderPost
    const before = document.head.querySelectorAll("script").length
    const err = await tokenizeCard({ ...realSession, scriptUrl: "https://cdn.exemplo.com/silentorderpost.js" }, card).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SopTokenizationError)
    expect((err as Error).message).toBe("SOP_SCRIPT_URL_NAO_PERMITIDA")
    expect(document.head.querySelectorAll("script").length).toBe(before)
  })

  it("campo marcado ausente do DOM: falha explícita (nunca manda o script ler vazio)", async () => {
    document.body.innerHTML = ""
    await expect(tokenizeCard(realSession, card)).rejects.toThrow("SOP_CAMPO_AUSENTE")
    expect(received).toBeNull()
  })
})

describe("tokenizeCard — portas de segurança (auditoria do Órion: S-4, S-6)", () => {
  afterEach(() => {
    delete (window as unknown as { bpSop_silentOrderPost?: unknown }).bpSop_silentOrderPost
    document.head.querySelectorAll("script").forEach((s) => s.remove())
    vi.useRealTimers()
  })

  it("sessão vencida: erro claro, sem carregar script nem entregar o accessToken", async () => {
    const vencida = { ...realSession, expiresAt: new Date(Date.now() - 1000).toISOString() }
    await expect(tokenizeCard(vencida, card)).rejects.toMatchObject({ message: "SOP_SESSAO_EXPIRADA" })
    expect(document.head.querySelectorAll("script").length).toBe(0)
  })

  it("scriptUrl que só CONTÉM 'mock' num host de terceiro NÃO usa o caminho mock: cai na allowlist e é recusado", async () => {
    for (const scriptUrl of ["https://evil.example/mock-sop.js", "https://mock.local.evil.example/x.js", "http://mock.local/x.js"]) {
      await expect(tokenizeCard({ ...realSession, scriptUrl }, card)).rejects.toMatchObject({ message: "SOP_SCRIPT_URL_NAO_PERMITIDA" })
    }
  })

  it("script que nunca dispara onload/onerror: depois de 15 s falha com SOP_SCRIPT_LOAD_TIMEOUT (a tela não fica presa em 'Validando cartão…')", async () => {
    vi.useFakeTimers()
    const pending = tokenizeCard(realSession, card)
    const assertion = expect(pending).rejects.toMatchObject({ message: "SOP_SCRIPT_LOAD_TIMEOUT" })
    await vi.advanceTimersByTimeAsync(15_001)
    await assertion
    expect(document.head.querySelectorAll("script").length).toBe(0) // a tag pendurada é removida e a próxima tentativa pode recarregar
  })
})
