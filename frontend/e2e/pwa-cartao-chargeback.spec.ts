import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

/**
 * L1.8 - BLOQUEIO DO CARTÃO POR CHARGEBACK no app do motorista. Contra o mock MSW (`mocks/meData.ts#cardEligibilityFor` / `cardRefusalFor`): NADA aqui foi provado contra o backend real.
 * Contrato: `GET /api/me/payment-methods` -> `cardEligibility: { eligible:false, reason:"CHARGEBACK_BLOCKED", blockedUntil:null }`; cadastro, sessão de tokenização e `sessions/start` com CARD
 * -> 403 `CARD_CHARGEBACK_BLOCKED`. Pix e carteira NÃO são barrados; cartões salvos continuam na lista (sem uso).
 *
 * Conta de cenário `chargeback@` (2 cartões, bloqueada). Gatilho do 403 INESPERADO (o GET ainda dizia "elegível"): `localStorage["mock:card-refusal"] = "CHARGEBACK_BLOCKED"`.
 * O estado do mock vive na PÁGINA: cada teste faz UM login e o resto é navegação interna.
 */

const PASSWORD = "senha1234"
const CHARGEBACK = "chargeback@innoelektron.com"
const ELEGIVEL = "cartoes@innoelektron.com"
const CHARGE_POINT_URL = "/c/CP-VILA-NORTE-01/1"
const TITLE = "O pagamento com cartão está indisponível para a sua conta"
const TEXT = "O Pix e a carteira continuam disponíveis. Em caso de dúvida, fale com o suporte."

async function login(page: Page, email: string, redirect = "/app") {
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`)
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(new RegExp(redirect.replace(/\//g, "\\/")))
}

const notice = (page: Page) => page.getByTestId("card-eligibility-notice")
const addCardButton = (page: Page) => page.getByRole("button", { name: "Adicionar cartão" })
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const axeViolations = async (page: Page) => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)

async function expectChargebackNotice(page: Page) {
  await expect(notice(page)).toHaveAttribute("data-reason", "CHARGEBACK_BLOCKED")
  await expect(notice(page)).toContainText(TITLE)
  await expect(notice(page)).toContainText(TEXT)
  // Nunca "entre com o Google" para quem tem chargeback, e nenhum botão de ação (o suporte é quem resolve).
  await expect(notice(page)).not.toContainText("Google")
  await expect(notice(page).getByRole("button")).toHaveCount(0)
  await expect(page.getByTestId("card-eligibility-link-note")).toHaveCount(0)
}

for (const viewport of [
  { name: "mobile (375px)", width: 375, height: 812 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`Meus cartões - ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("chargeback: aviso neutro com o texto da API, sem 'Adicionar cartão', cartões na lista desabilitados e sem 'Tornar padrão'", async ({ page }) => {
      const eligibility = page.waitForResponse((r) => r.url().endsWith("/api/me/payment-methods") && r.request().method() === "GET")
      await login(page, CHARGEBACK, "/app/carteira/cartoes")
      const { cardEligibility } = (await (await eligibility).json()) as { cardEligibility: { eligible: boolean; reason: string; blockedUntil: string | null } }
      expect(cardEligibility).toEqual({ eligible: false, reason: "CHARGEBACK_BLOCKED", blockedUntil: null })

      await expectChargebackNotice(page)
      await expect(addCardButton(page)).toHaveCount(0)

      const items = page.getByRole("listitem").filter({ hasText: "••••" })
      await expect(items).toHaveCount(2)
      for (const item of await items.all()) {
        await expect(item).toHaveAttribute("data-disabled", "true")
        await expect(item.getByText("Indisponível", { exact: true })).toBeVisible()
        await expect(item.getByTestId("card-disabled-reason")).toHaveText("Não pode ser usado para novas recargas.")
        await expect(item.getByText("Padrão", { exact: true })).toHaveCount(0)
        const menu = await item.getByRole("button", { name: /Mais opções/ }).boundingBox()
        expect(menu!.height).toBeGreaterThanOrEqual(44)
        expect(menu!.width).toBeGreaterThanOrEqual(44)
      }
      await page.getByRole("button", { name: /Mais opções — cartão Visa/ }).click()
      await expect(page.getByRole("menuitem", { name: "Remover" })).toBeVisible()
      await expect(page.getByRole("menuitem", { name: "Tornar padrão" })).toHaveCount(0)
      await page.keyboard.press("Escape")

      expect(await noHScroll(page)).toBe(0)
      expect(await axeViolations(page)).toEqual([])
    })

    test("403 inesperado ao pedir a sessão de tokenização (o GET ainda dizia 'elegível'): nenhuma aba abre, mensagem aparece e a elegibilidade é atualizada", async ({ page, context }) => {
      await login(page, ELEGIVEL, "/app/carteira/cartoes")
      await expect(addCardButton(page)).toBeVisible()
      await page.evaluate(() => localStorage.setItem("mock:card-refusal", "CHARGEBACK_BLOCKED"))
      let opened = 0
      context.on("page", () => opened++)
      const refetch = page.waitForResponse((r) => r.url().endsWith("/api/me/payment-methods") && r.request().method() === "GET")

      await addCardButton(page).click()
      await refetch // a lista é recarregada depois da recusa
      await expectChargebackNotice(page)
      await expect(addCardButton(page)).toHaveCount(0)
      expect(opened).toBe(0)
      expect(await noHScroll(page)).toBe(0)
    })

    test("elegível: nada muda (botão, sem aviso, sem selo de indisponível)", async ({ page }) => {
      await login(page, ELEGIVEL, "/app/carteira/cartoes")
      await expect(addCardButton(page)).toBeVisible()
      await expect(notice(page)).toHaveCount(0)
      await expect(page.getByText("Indisponível", { exact: true })).toHaveCount(0)
    })
  })
}

test.describe("Carteira e adicionar saldo - Pix e carteira livres", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("Carteira: a linha 'Meus cartões' avisa; 'Adicionar saldo' segue sendo o CTA e vem ANTES de 'Meus cartões'", async ({ page }) => {
    await login(page, CHARGEBACK, "/app/carteira")
    await expect(page.getByTestId("cartoes-indisponivel")).toHaveText("Cartão indisponível para a sua conta. O Pix e a carteira seguem normais.")

    const add = await page.getByRole("link", { name: /Adicionar saldo/ }).boundingBox()
    const cards = await page.getByRole("link", { name: /Meus cartões/ }).boundingBox()
    expect(add!.y).toBeLessThan(cards!.y)
    expect(add!.height).toBeGreaterThanOrEqual(44)
    expect(cards!.height).toBeGreaterThanOrEqual(44)
    expect(await noHScroll(page)).toBe(0)
    expect(await axeViolations(page)).toEqual([])
  })

  test("Carteira de quem pode usar cartão: texto de sempre", async ({ page }) => {
    await login(page, ELEGIVEL, "/app/carteira")
    await expect(page.getByText("Cadastre um cartão para pagar a recarga sem digitar toda vez.")).toBeVisible()
    await expect(page.getByTestId("cartoes-indisponivel")).toHaveCount(0)
  })

  test("Adicionar saldo: aviso do cartão acima do formulário e o Pix gera QR normalmente", async ({ page }) => {
    await login(page, CHARGEBACK, "/app/carteira")
    await page.getByRole("link", { name: /Adicionar saldo/ }).click()
    await expect(page).toHaveURL(/\/app\/carteira\/adicionar/)
    await expectChargebackNotice(page)

    // Ordem: o aviso vem antes do formulário e o botão de gerar o Pix continua sendo o último do formulário.
    const noticeBox = await notice(page).boundingBox()
    const submit = page.getByRole("button", { name: "Gerar código Pix" })
    const submitBox = await submit.boundingBox()
    expect(noticeBox!.y).toBeLessThan(submitBox!.y)
    expect(submitBox!.height).toBeGreaterThanOrEqual(44)
    expect(await noHScroll(page)).toBe(0)
    expect(await axeViolations(page)).toEqual([])

    await page.getByText(/R\$\s*20,00/).click()
    await submit.click()
    await expect(page.getByText("Aguardando pagamento")).toBeVisible()
    await expect(page.getByRole("img", { name: /QR code Pix/ })).toBeVisible()
    await expect(notice(page)).toHaveCount(0) // o passo do QR é só do Pix
  })

  test("Adicionar saldo de quem pode usar cartão: sem aviso", async ({ page }) => {
    await login(page, ELEGIVEL, "/app/carteira/adicionar")
    await expect(page.getByRole("button", { name: "Gerar código Pix" })).toBeVisible()
    await expect(notice(page)).toHaveCount(0)
  })
})

test.describe("Iniciar recarga (página do carregador) - escolha de pagamento", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("chargeback: sem seletor de cartão, aviso com o motivo e a alternativa, e a recarga inicia pela carteira", async ({ page }) => {
    await login(page, CHARGEBACK, CHARGE_POINT_URL)
    await expectChargebackNotice(page)
    await expect(page.getByRole("radiogroup", { name: "Forma de pagamento" })).toHaveCount(0)
    await expect(page.getByRole("radio", { name: /Visa|Master/ })).toHaveCount(0)
    await expect(page.getByText("pré-autorização")).toHaveCount(0)

    // O botão "Iniciar recarga" continua depois do aviso e com alvo de 44 px.
    const start = page.getByRole("button", { name: "Iniciar recarga" })
    const startBox = await start.boundingBox()
    const noticeBox = await notice(page).boundingBox()
    expect(noticeBox!.y).toBeLessThan(startBox!.y)
    expect(startBox!.height).toBeGreaterThanOrEqual(44)
    expect(await noHScroll(page)).toBe(0)
    expect(await axeViolations(page)).toEqual([])

    const requests: string[] = []
    page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/me/sessions/start") && requests.push(r.postData() ?? ""))
    await start.click()
    await expect(page).toHaveURL(/\/app\/sessao/)
    expect(JSON.parse(requests[0]).payment).toEqual({ mode: "WALLET" })
  })

  test("403 inesperado ao iniciar com o cartão: aviso (uma vez só), seletor some, cartão não é reenviado e a carteira inicia", async ({ page }) => {
    await login(page, ELEGIVEL, CHARGE_POINT_URL)
    await expect(page.getByRole("radio", { name: /Visa.*1234/ })).toBeChecked() // o GET ainda dizia "elegível"
    await page.evaluate(() => localStorage.setItem("mock:card-refusal", "CHARGEBACK_BLOCKED"))
    const refetch = page.waitForResponse((r) => r.url().endsWith("/api/me/payment-methods") && r.request().method() === "GET")

    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await refetch
    await expectChargebackNotice(page)
    await expect(page.getByText(TITLE)).toHaveCount(1) // o texto da API aparece UMA vez (sem alerta duplicado)
    await expect(page.getByRole("radiogroup", { name: "Forma de pagamento" })).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/"))) // não navegou

    const requests: string[] = []
    page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/me/sessions/start") && requests.push(r.postData() ?? ""))
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)
    expect(JSON.parse(requests[0]).payment).toEqual({ mode: "WALLET" })
  })

  test("elegível: o seletor de cartão continua e o cartão padrão vem selecionado", async ({ page }) => {
    await login(page, ELEGIVEL, CHARGE_POINT_URL)
    await expect(notice(page)).toHaveCount(0)
    await expect(page.getByRole("radio", { name: /Visa.*1234/ })).toBeChecked()
  })
})
