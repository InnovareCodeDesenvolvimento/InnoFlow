import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

/**
 * CARTÃO ILEGÍVEL no app do motorista (05/10/2026: a chave dos segredos do servidor passou a ser derivada do JWT_SECRET; se ele mudar, o token de um cartão salvo não abre mais).
 * Contra o mock MSW (`mocks/meData.ts`): NADA aqui foi provado contra o backend real. Contrato: `GET /api/me/payment-methods` -> `items[].unreadable: boolean` (aditivo);
 * `POST /api/me/sessions/start` com esse cartão -> 409 `PAYMENT_METHOD_UNREADABLE` (nada autorizado nem cobrado).
 *
 * Contas de cenário: `cartao-ilegivel@` (padrão Visa 1111 ILEGÍVEL + Master 4444 legível) e `cartao-ilegivel-todos@` (os dois ilegíveis). Gatilho do 409 INESPERADO (a lista ainda
 * dizia "legível"): `localStorage["mock:cartao-ilegivel"] = "ao-iniciar"` na conta `cartoes@`. O estado do mock vive na PÁGINA: cada teste faz UM login e o resto é navegação interna.
 */

const PASSWORD = "senha1234"
const MISTA = "cartao-ilegivel@innoelektron.com"
const TODOS = "cartao-ilegivel-todos@innoelektron.com"
const ELEGIVEL = "cartoes@innoelektron.com"
const CHARGE_POINT_URL = "/c/CP-VILA-NORTE-01/1"
const MESSAGE = "Por segurança, precisamos que você cadastre este cartão novamente."

async function login(page: Page, email: string, redirect = "/app") {
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`)
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(new RegExp(redirect.replace(/\//g, "\\/")))
}

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const axeViolations = async (page: Page) => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)
const startPosts = (page: Page) => {
  const requests: Array<{ payment: unknown }> = []
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/me/sessions/start") && requests.push(JSON.parse(r.postData() ?? "{}")))
  return requests
}

test.describe("Iniciar recarga (página do carregador) - cartão ilegível", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("padrão ilegível: aparece com o selo e o aviso, não é escolhível nem pré-selecionado; a Carteira vem marcada e o outro cartão pode ser escolhido", async ({ page }) => {
    await login(page, MISTA, CHARGE_POINT_URL)
    const group = page.getByRole("radiogroup", { name: "Forma de pagamento" })
    await expect(group).toBeVisible()

    const unreadable = group.getByRole("radio", { name: /Visa.*1111/ })
    await expect(unreadable).toBeDisabled()
    await expect(unreadable).not.toBeChecked()
    const row = group.locator("[data-unreadable]")
    await expect(row).toHaveCount(1)
    await expect(row).toContainText("Cadastre de novo")
    await expect(row.getByTestId("unreadable-card-note")).toHaveText(new RegExp(`${MESSAGE}\\s*Ver meus cartões`))
    await expect(unreadable).toHaveAccessibleDescription(new RegExp(MESSAGE)) // o leitor de tela lê o motivo junto com o cartão
    await expect(row).not.toContainText("Padrão") // o selo "Padrão" não disputa com o aviso

    await expect(group.getByRole("radio", { name: "Carteira" })).toBeChecked() // o padrão era o ilegível: cai na carteira
    await expect(page.getByText("pré-autorização")).toHaveCount(0)
    await expect(group.getByRole("radio", { name: /Master.*4444/ })).toBeEnabled()

    // Geometria (375 px): sem rolagem lateral, selo e texto dentro da tela, alvo do botão >= 44 px.
    expect(await noHScroll(page)).toBe(0)
    const rowBox = await row.boundingBox()
    const badgeBox = await row.getByText("Cadastre de novo").boundingBox()
    expect(rowBox!.x).toBeGreaterThanOrEqual(0)
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(375)
    expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width)
    expect((await page.getByRole("button", { name: "Iniciar recarga" }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await axeViolations(page)).toEqual([])

    // Escolher o cartão legível e iniciar: vai CARD com o id dele (nunca o do ilegível).
    const requests = startPosts(page)
    await group.getByText(/Master/).click()
    await expect(group.getByRole("radio", { name: /Master.*4444/ })).toBeChecked()
    await expect(page.getByText("pré-autorização")).toBeVisible()
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)
    expect(requests[0].payment).toEqual({ mode: "CARD", paymentMethodId: "pm_seed_user_driver_cartao_ilegivel_2" })
  })

  test("todos ilegíveis: nenhum cartão escolhível, Carteira selecionada, um aviso por cartão, e a recarga inicia pela carteira", async ({ page }) => {
    await login(page, TODOS, CHARGE_POINT_URL)
    const group = page.getByRole("radiogroup", { name: "Forma de pagamento" })
    await expect(group.locator("[data-unreadable]")).toHaveCount(2)
    await expect(group.getByRole("radio", { name: /Visa.*1111/ })).toBeDisabled()
    await expect(group.getByRole("radio", { name: /Master.*4444/ })).toBeDisabled()
    await expect(group.getByRole("radio", { name: "Carteira" })).toBeChecked()
    await expect(group.getByTestId("unreadable-card-note")).toHaveCount(2)
    await expect(page.getByText("pré-autorização")).toHaveCount(0)
    expect(await noHScroll(page)).toBe(0)
    expect(await axeViolations(page)).toEqual([])

    const requests = startPosts(page)
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)
    expect(requests[0].payment).toEqual({ mode: "WALLET" })
  })

  test("409 PAYMENT_METHOD_UNREADABLE inesperado: lista é atualizada (selo no cartão), aviso sem culpa, não navega, e a carteira inicia", async ({ page }) => {
    await login(page, ELEGIVEL, CHARGE_POINT_URL)
    await expect(page.getByRole("radio", { name: /Visa.*1234/ })).toBeChecked() // a lista ainda dizia "legível"
    await page.evaluate(() => localStorage.setItem("mock:cartao-ilegivel", "ao-iniciar"))
    const refetch = page.waitForResponse((r) => r.url().endsWith("/api/me/payment-methods") && r.request().method() === "GET")

    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await refetch
    const alert = page.getByRole("alert").filter({ hasText: MESSAGE })
    await expect(alert).toBeVisible()
    await expect(alert).toContainText("escolha outro cartão ou a carteira")
    await expect(alert).not.toContainText(/JWT|chave|servidor/i)
    await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/"))) // não navegou
    // A lista atualizada marca o cartão e a seleção cai para a Carteira (os outros cartões da conta seguem escolhíveis).
    const visa = page.getByRole("radio", { name: /Visa.*1234/ })
    await expect(visa).toBeDisabled()
    await expect(page.locator("[data-unreadable]")).toContainText("Cadastre de novo")
    await expect(page.getByRole("radio", { name: "Carteira" })).toBeChecked()

    const requests = startPosts(page)
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)
    expect(requests[0].payment).toEqual({ mode: "WALLET" })
  })

  test("conta sem cartão ilegível: nada muda (seletor igual, sem selo)", async ({ page }) => {
    await login(page, ELEGIVEL, CHARGE_POINT_URL)
    await expect(page.getByRole("radio", { name: /Visa.*1234/ })).toBeChecked()
    await expect(page.locator("[data-unreadable]")).toHaveCount(0)
    await expect(page.getByText("Cadastre de novo")).toHaveCount(0)
  })
})

for (const viewport of [
  { name: "mobile (375px)", width: 375, height: 812 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`Meus cartões - cartão ilegível - ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("selo e aviso no cartão, sem 'Tornar padrão' nele, 'Adicionar cartão' disponível e 'Remover' funciona (o outro vira padrão)", async ({ page }) => {
      await login(page, MISTA, "/app/carteira/cartoes")
      const items = page.getByRole("listitem").filter({ hasText: "••••" })
      await expect(items).toHaveCount(2)
      const bad = items.filter({ hasText: "1111" })
      await expect(bad).toHaveAttribute("data-unreadable", "true")
      await expect(bad).toContainText("Cadastre de novo")
      await expect(bad.getByTestId("card-unreadable-reason")).toContainText(MESSAGE)
      await expect(bad.getByTestId("card-unreadable-reason")).toContainText("Remova-o e use “Adicionar cartão”.")
      await expect(bad).not.toContainText("Padrão")
      await expect(page.getByRole("button", { name: "Adicionar cartão" })).toBeVisible()
      expect(await noHScroll(page)).toBe(0)
      expect(await axeViolations(page)).toEqual([])

      // O cartão legível segue normal e ainda pode virar padrão; o ilegível NÃO oferece "Tornar padrão", só "Remover".
      await bad.getByRole("button", { name: /Mais opções/ }).click()
      await expect(page.getByRole("menuitem", { name: "Tornar padrão" })).toHaveCount(0)
      await page.getByRole("menuitem", { name: "Remover" }).click()
      await page.getByRole("dialog").getByRole("button", { name: "Remover" }).click()
      await expect(page.getByText("Cartão removido.")).toBeVisible()
      await expect(page.getByText("•••• 1111")).toHaveCount(0)
      await expect(page.getByText("Cadastre de novo")).toHaveCount(0)
      await expect(page.getByText("Padrão")).toHaveCount(1) // o Master foi promovido
    })
  })
}
