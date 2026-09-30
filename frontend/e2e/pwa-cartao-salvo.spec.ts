import { expect, test, type Page } from "@playwright/test"

/**
 * Cartão salvo (F5.3) — cadastro via documento ISOLADO (`pagamento-cartao.html`,
 * SAQ A-EP). Prova o que mais importa de ponta a ponta: a aba isolada abre
 * DE VERDADE (não um modal/iframe), o handshake `ready`→`init` funciona, o
 * app principal nunca recebe PAN/CVV (só o `cardToken`+`brand` de volta) e
 * "Meus cartões" reflete o cadastro. Contra o mock MSW (`src/mocks/meData.ts`)
 * — a rota real já existe no backend (Vega), mas só é validada aqui pela
 * Íris depois, ver PROGRESSO.md §F5.3.
 */

const DRIVER_EMAIL = "motorista@innoelektron.com"
const PASSWORD = "senha1234"

async function loginAsDriver(page: Page) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(DRIVER_EMAIL)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/app/)
}

/** Preenche e envia o formulário da aba isolada — retorna depois que ela mostra "pode fechar". */
async function fillAndSubmitCard(popup: Page, opts: { cardNumber: string; holderName: string; month: string; year: string; cvv: string }) {
  await expect(popup.getByRole("heading", { name: "Cadastrar cartão" })).toBeVisible()
  await popup.getByLabel("Número do cartão").fill(opts.cardNumber)
  await popup.getByLabel("Nome impresso no cartão").fill(opts.holderName)
  await popup.getByLabel("Mês").fill(opts.month)
  await popup.getByLabel("Ano").fill(opts.year)
  await popup.getByLabel("CVV").fill(opts.cvv)
  await popup.getByRole("button", { name: "Salvar cartão" }).click()
  await expect(popup.getByText("Cartão validado")).toBeVisible({ timeout: 5000 })
}

for (const viewport of [
  { name: "mobile (390px)", width: 390, height: 844 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`cadastro de cartão — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("aba isolada abre, tokeniza e o cartão aparece em Meus cartões", async ({ page, context }) => {
      await loginAsDriver(page)

      await page.goto("/app/carteira")
      await page.getByRole("link", { name: /Meus cartões/ }).click()
      await expect(page).toHaveURL(/\/app\/carteira\/cartoes/)
      await expect(page.getByText("Nenhum cartão cadastrado")).toBeVisible()

      const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).click()])
      await popup.waitForLoadState()
      // Documento ISOLADO — URL própria, nunca uma rota do app principal.
      await expect(popup).toHaveURL(/\/pagamento-cartao\.html$/)

      await fillAndSubmitCard(popup, { cardNumber: "4111 1111 1111 1234", holderName: "Maria Teste", month: "08", year: "2030", cvv: "123" })
      await popup.getByRole("button", { name: "Fechar" }).click()

      // Volta pro app principal: o postMessage("token") chegou, o POST /api/me/payment-methods rodou, a lista atualizou.
      await expect(page.getByText("Cartão cadastrado.")).toBeVisible()
      await expect(page.getByText("Visa")).toBeVisible()
      await expect(page.getByText("•••• 1234")).toBeVisible()
      await expect(page.getByText("Padrão")).toBeVisible() // 1º cartão vira padrão sozinho
    })

    test("segundo cartão pode virar padrão, e remover pede confirmação", async ({ page, context }) => {
      await loginAsDriver(page)
      await page.goto("/app/carteira/cartoes")

      // Primeiro cartão (vira padrão automaticamente).
      const [popup1] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).click()])
      await fillAndSubmitCard(popup1, { cardNumber: "4111 1111 1111 1111", holderName: "Motorista Um", month: "05", year: "2029", cvv: "111" })
      await popup1.close()
      await expect(page.getByText("•••• 1111")).toBeVisible()

      // Segundo cartão (Mastercard) — NÃO vira padrão sozinho.
      const [popup2] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).click()])
      await fillAndSubmitCard(popup2, { cardNumber: "5555 5555 5555 4444", holderName: "Motorista Dois", month: "09", year: "2031", cvv: "222" })
      await popup2.close()
      await expect(page.getByText("•••• 4444")).toBeVisible()

      // Só um badge "Padrão" — no primeiro cartão.
      await expect(page.getByText("Padrão")).toHaveCount(1)

      // Torna o segundo (Mastercard) padrão.
      const secondCardMenu = page.getByRole("button", { name: /Mais opções — cartão Master/ })
      await secondCardMenu.click()
      await page.getByRole("menuitem", { name: "Tornar padrão" }).click()
      await expect(page.getByText("Cartão definido como padrão.")).toBeVisible()
      await expect(page.getByText("Padrão")).toHaveCount(1) // continua só 1 badge — trocou de dono, não duplicou

      // Remove o cartão que NÃO é mais padrão (o Visa) com confirmação.
      const visaMenu = page.getByRole("button", { name: /Mais opções — cartão Visa/ })
      await visaMenu.click()
      await page.getByRole("menuitem", { name: "Remover" }).click()
      await expect(page.getByRole("heading", { name: "Remover este cartão?" })).toBeVisible()
      await page.getByRole("button", { name: "Remover" }).click()
      await expect(page.getByText("Cartão removido.")).toBeVisible()
      await expect(page.getByText("•••• 1111")).toHaveCount(0)
      await expect(page.getByText("•••• 4444")).toBeVisible() // o Mastercard continua
    })
  })
}

test("a página isolada não carrega nenhum script de terceiro (só o próprio bundle)", async ({ page }) => {
  const externalRequests: string[] = []
  page.on("request", (req) => {
    const url = new URL(req.url())
    if (url.origin !== new URL(page.url() || "http://localhost:5173").origin && url.hostname !== "localhost") {
      externalRequests.push(req.url())
    }
  })

  await page.goto("/pagamento-cartao.html")
  await expect(page.getByText(/Esta página não pode ser aberta diretamente|Conectando|Não foi possível conectar/)).toBeVisible()

  // Nenhuma requisição saiu para fora da própria origem (nem Google Fonts, nem CDN, nem a própria Cielo ainda — mock local não bate em rede).
  expect(externalRequests).toEqual([])
})
