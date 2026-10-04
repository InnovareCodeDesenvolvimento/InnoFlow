import { expect, test, type Page } from "@playwright/test"

/**
 * Cadastro de cartão pelo caminho REAL do Silent Order Post (C1.2): a sessão de tokenização traz o `scriptUrl` de sandbox da Cielo
 * (conta de cenário `sop-real@`, ver `mocks/data.ts`), a página isolada carrega ESSE script, chama `bpSop_silentOrderPost` com o contrato
 * da Cielo, e o app principal recebe `cardToken` + `last4` + validade.
 *
 * O que isto PROVA: a fiação (script dinâmico -> função global -> campos `bp-sop-*` normalizados -> callbacks -> postMessage -> POST).
 * O que NÃO prova: o script verdadeiro da Cielo. Ele é SUBSTITUÍDO aqui por um duplo que registra o que leu do DOM e chama os callbacks;
 * nada vai à Cielo. O nome do campo no `onSuccess` (`CardToken`) e a aceitação do `enableTokenize: "true"` só se confirmam no sandbox real.
 */

const SOP_SCRIPT = "https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js"

const FAKE_SOP_SCRIPT = `
window.__sopCalls = [];
window.bpSop_silentOrderPost = function (o) {
  var q = function (c) { return document.querySelector('.' + c).value };
  var call = { accessToken: o.accessToken, environment: o.environment, language: o.language, enableTokenize: o.enableTokenize,
    number: q('bp-sop-cardnumber'), holder: q('bp-sop-cardholdername'), expiration: q('bp-sop-cardexpirationdate'), cvv: q('bp-sop-cardcvv') };
  window.__sopCalls.push(call);
  if (call.number === '4000000000000002') return o.onInvalid([{ Field: 'CardNumber', Message: 'Cartão inválido (simulado).' }]);
  if (call.number === '4000000000000010') return o.onSuccess({ PaymentToken: 'uso-unico' });
  o.onSuccess({ CardToken: 'e2e-cardtoken-' + call.number.slice(-4) });
};
`

test.use({ viewport: { width: 390, height: 844 } })

async function loginAsSopDriver(page: Page) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill("sop-real@innoelektron.com")
  await page.getByLabel("Senha").fill("senha1234")
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/app/)
}

async function fill(popup: Page, opts: { number: string; holder: string; month: string; year: string; cvv: string }) {
  await expect(popup.getByRole("heading", { name: "Cadastrar cartão" })).toBeVisible()
  await popup.getByLabel("Número do cartão").fill(opts.number)
  await popup.getByLabel("Nome impresso no cartão").fill(opts.holder)
  await popup.getByLabel("Mês").fill(opts.month)
  await popup.getByLabel("Ano").fill(opts.year)
  await popup.getByLabel("CVV").fill(opts.cvv)
}

test.describe("cadastro de cartão — script REAL do SOP (duplo no lugar do script da Cielo)", () => {
  test.beforeEach(async ({ context }) => {
    await context.route(SOP_SCRIPT, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_SOP_SCRIPT }))
  })

  test("carrega o script de sandbox, chama bpSop_silentOrderPost normalizado e o app salva token + last4 + validade", async ({ page, context }) => {
    await loginAsSopDriver(page)
    await page.goto("/app/carteira/cartoes")

    const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).click()])
    await fill(popup, { number: "4111 1111 1111 1234", holder: "Maria Teste", month: "08", year: "2030", cvv: "123" })

    const posted = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/me/payment-methods"))
    await popup.getByRole("button", { name: "Salvar cartão" }).click()
    await expect(popup.getByText("Cartão validado")).toBeVisible()

    // O que o script da Cielo LEU do DOM: número sem espaços, validade MM/AAAA, enableTokenize string, ambiente minúsculo.
    const call = await popup.evaluate(() => (window as unknown as { __sopCalls: Record<string, string>[] }).__sopCalls[0])
    expect(call).toMatchObject({
      environment: "sandbox",
      language: "PT",
      enableTokenize: "true",
      number: "4111111111111234",
      holder: "MARIA TESTE",
      expiration: "08/2030",
      cvv: "123",
    })
    expect(call.accessToken).toMatch(/^mock_sop_access_/)

    // O app principal recebeu o CardToken e o PAN TRUNCADO — nunca o número inteiro nem o CVV.
    const body = (await posted).postDataJSON()
    expect(body).toEqual({ cardToken: "e2e-cardtoken-1234", brand: "Visa", last4: "1234", expiryMonth: 8, expiryYear: 2030 })
    expect(JSON.stringify(body)).not.toContain("4111111111111234")
    expect(JSON.stringify(body)).not.toContain("123\"") // cvv

    await popup.getByRole("button", { name: "Fechar" }).click()
    await expect(page.getByText("Cartão cadastrado.")).toBeVisible()
    await expect(page.getByText("•••• 1234")).toBeVisible()
  })

  test("Elo com prefixo de Visa vai como Elo (ordem das regras de bandeira)", async ({ page, context }) => {
    await loginAsSopDriver(page)
    await page.goto("/app/carteira/cartoes")
    const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).click()])
    await fill(popup, { number: "4011 7800 0000 9999", holder: "Eloisa Teste", month: "11", year: "2031", cvv: "456" })

    const posted = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/me/payment-methods"))
    await popup.getByRole("button", { name: "Salvar cartão" }).click()
    await expect(popup.getByText("Cartão validado")).toBeVisible()
    expect((await posted).postDataJSON()).toMatchObject({ brand: "Elo", last4: "9999", expiryMonth: 11, expiryYear: 2031 })
  })

  test("a Cielo recusa os campos (onInvalid): a mensagem DELA aparece na página, nada é salvo e dá para tentar de novo", async ({ page, context }) => {
    await loginAsSopDriver(page)
    await page.goto("/app/carteira/cartoes")
    const saves: string[] = []
    page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/me/payment-methods") && saves.push(r.url()))

    const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).click()])
    await fill(popup, { number: "4000 0000 0000 0002", holder: "Maria Teste", month: "08", year: "2030", cvv: "123" })
    await popup.getByRole("button", { name: "Salvar cartão" }).click()

    await expect(popup.getByRole("alert").filter({ hasText: "Cartão inválido (simulado)." })).toBeVisible()
    await expect(popup.getByRole("button", { name: "Salvar cartão" })).toBeEnabled()
    expect(saves).toHaveLength(0)
  })

  test("resposta sem CardToken (só PaymentToken de uso único) NÃO é gravada como cartão salvo", async ({ page, context }) => {
    await loginAsSopDriver(page)
    await page.goto("/app/carteira/cartoes")
    const saves: string[] = []
    page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/me/payment-methods") && saves.push(r.url()))

    const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).click()])
    await fill(popup, { number: "4000 0000 0000 0010", holder: "Maria Teste", month: "08", year: "2030", cvv: "123" })
    await popup.getByRole("button", { name: "Salvar cartão" }).click()

    await expect(popup.getByRole("alert").filter({ hasText: "SOP_SEM_CARD_TOKEN" })).toBeVisible()
    expect(saves).toHaveLength(0)
  })
})
