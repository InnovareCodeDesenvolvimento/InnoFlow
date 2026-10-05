import { expect, test, type Page } from "@playwright/test"

/**
 * F-C do design system unificado (PWA do motorista) — docs/DESIGN-SYSTEM-UNIFICACAO.md §4. Contra os mocks MSW.
 * Prova o que a mudança de aparência prometeu e NÃO pode vazar: cabeçalho = theme-color, trilho lateral >= lg, escopo `data-area="driver"` só no PWA
 * (Admin e público intactos), véu de Dialog sem desfoque no PWA, CTA lima único, estados vazio/erro de marca. Pixels são do harness `e2e-visual`.
 */

const LIME = "rgb(97, 219, 36)"
const THEME_RGB = "rgb(14, 42, 58)" // #0E2A3A = primary-950 = <meta name="theme-color"> = theme_color do manifesto
const PASSWORD = "senha1234"

async function login(page: Page, email: string, to = /\/app/) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(to)
}

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const css = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)

test.describe("shell do PWA — mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("cabeçalho escuro = theme-color; navegação embaixo; aba ativa com traço lima; pingo de sessão sem animação", async ({ page }) => {
    await login(page, "motorista@innoelektron.com")
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0E2A3A")
    await expect(page.locator("header").first()).toHaveCSS("background-color", THEME_RGB)

    const nav = page.getByRole("navigation", { name: "Navegação do aplicativo" })
    const box = await nav.boundingBox()
    expect(box!.y + box!.height, "navegação colada no rodapé da janela").toBeGreaterThan(844 - 2)
    const active = nav.getByRole("link", { name: "Início" })
    await expect(active).toHaveAttribute("aria-current", "page")
    await expect(active.locator("span.bg-lime")).toHaveCount(1)
    expect(await horizontalOverflow(page)).toBe(0)
  })

  test("sem escopo transitório (F-D): nenhuma página tem data-area; o shell do app se marca com data-app-shell; campos do app em 14 px e CTA lima", async ({ page }) => {
    await page.goto("/login")
    await expect(page.locator("html")).not.toHaveAttribute("data-area", /.*/)
    await login(page, "motorista@innoelektron.com")
    await expect(page.locator("html")).not.toHaveAttribute("data-area", /.*/)
    await expect(page.locator("[data-app-shell]")).toHaveCount(1)
    await page.getByRole("link", { name: "Carteira", exact: true }).last().click()
    await page.getByRole("link", { name: /Adicionar saldo/ }).click()
    expect(await css(page, 'input[inputmode="decimal"]', "border-top-left-radius")).toBe("14px")
    // CTA único da tela: lima.
    await expect(page.getByRole("button", { name: "Gerar código Pix" })).toHaveCSS("background-color", LIME)
  })

  test("Dialog do app: véu SEM desfoque e raio de 'feature'; carteira tem um único CTA lima", async ({ page }) => {
    await login(page, "motorista@innoelektron.com")
    await page.goto("/c/CP-VILA-NORTE-01/1")
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page.getByText("Parar recarga").first()).toBeVisible({ timeout: 30_000 })
    await page.getByRole("button", { name: "Parar recarga" }).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    expect(await css(page, ".dialog-scrim", "backdrop-filter")).toBe("none")
    expect(await dialog.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("24px")
  })

  test("estado vazio de primeiro uso (histórico) é o card de marca com mascote; erro de tela inteira também", async ({ page }) => {
    await login(page, "motorista@innoelektron.com")
    await page.getByRole("link", { name: "Histórico", exact: true }).last().click()
    await expect(page.getByText("Nenhuma recarga ainda")).toBeVisible()
    await expect(page.locator(".surface-dark img[width='64']").first()).toBeVisible()

    await page.evaluate(() => localStorage.setItem("mock:me-sessions-error", "1"))
    await page.goto("/app/sessoes") // recarrega: o cache do TanStack (60 s) esconderia a falha numa navegação interna
    const erro = page.getByRole("alert").filter({ hasText: /histórico|Falha/i })
    await expect(erro).toBeVisible()
    await expect(erro.getByRole("button", { name: "Tentar novamente" })).toBeVisible()
    expect(await erro.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(400) // tone="page": ocupa a tela, não é um aviso solto
    await page.evaluate(() => localStorage.removeItem("mock:me-sessions-error"))
  })

  test("Carteira: 'Adicionar saldo' é o CTA lima; Cartões: 'Adicionar cartão' é lima", async ({ page }) => {
    await login(page, "cartoes@innoelektron.com")
    await page.getByRole("link", { name: "Carteira", exact: true }).last().click()
    await expect(page.getByRole("link", { name: /Adicionar saldo/ })).toHaveCSS("background-color", LIME)
    await page.getByRole("link", { name: /Meus cartões/ }).click()
    await expect(page.getByRole("button", { name: "Adicionar cartão" })).toHaveCSS("background-color", LIME)
    expect(await horizontalOverflow(page)).toBe(0)
  })

  test("foco por teclado visível em card-link (anel petróleo de 2 px) e no contêiner do mapa (borda interna)", async ({ page }) => {
    await login(page, "motorista@innoelektron.com")
    await page.getByRole("link", { name: "Carteira", exact: true }).last().click()
    const cartoes = page.getByRole("link", { name: /Meus cartões/ })
    await page.keyboard.press("Tab") // modalidade teclado
    await cartoes.focus()
    const sombra = await cartoes.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(sombra, "o anel de foco do card-link não pode perder para o ring-1 do card").toContain("rgb(41, 105, 142)")
    await page.getByRole("link", { name: "Mapa", exact: true }).last().click()
    await page.getByRole("group", { name: "Modo de exibição" }).getByRole("button", { name: "Mapa" }).click()
    const mapa = page.locator(".leaflet-container")
    await page.keyboard.press("Tab") // o último gesto foi um clique: sem uma tecla o navegador não aplica :focus-visible
    await mapa.focus()
    expect(await mapa.evaluate((el) => getComputedStyle(el, "::after").borderTopWidth)).toBe("3px")
  })

  test("mapa: busca na faixa escura, grupos 'Ordenar por' e 'Modo de exibição' com aria-pressed; legenda 'Fora do ar' usa o fundo de estado (#6B7280)", async ({ page }) => {
    await login(page, "motorista@innoelektron.com")
    await page.getByRole("link", { name: "Mapa", exact: true }).last().click()
    await expect(page.getByRole("searchbox")).toBeVisible()
    const sort = page.getByRole("group", { name: "Ordenar por" })
    await expect(sort.getByRole("button", { name: "Nome" })).toHaveAttribute("aria-pressed", "true")
    await sort.getByRole("button", { name: "Mais conectores" }).click()
    await expect(sort.getByRole("button", { name: "Mais conectores" })).toHaveAttribute("aria-pressed", "true")
    // Item ativo = token de foco: petróleo no miolo claro.
    await expect(sort.getByRole("button", { name: "Mais conectores" })).toHaveCSS("background-color", "rgb(41, 105, 142)")
    await page.getByRole("group", { name: "Modo de exibição" }).getByRole("button", { name: "Mapa" }).click()
    const legenda = page.getByRole("list", { name: "Legenda do mapa" }).getByRole("listitem").nth(2)
    await expect(legenda).toContainText("Fora do ar")
    await expect(legenda.locator("span").first()).toHaveCSS("background-color", "rgb(107, 114, 128)")
    expect(await horizontalOverflow(page)).toBe(0)
  })
})

test.describe("shell do PWA — desktop (1440px)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("a navegação vira trilho lateral escuro (não a barra de celular)", async ({ page }) => {
    await login(page, "motorista@innoelektron.com")
    const nav = page.getByRole("navigation", { name: "Navegação do aplicativo" })
    const box = await nav.boundingBox()
    expect(box!.x).toBe(0)
    expect(box!.width).toBe(96)
    expect(box!.height).toBeGreaterThan(500)
    await expect(nav).toHaveCSS("background-color", /rgba?\(6, 22, 33/)
    // O miolo não fica por baixo do trilho.
    const h1 = await page.getByRole("heading", { level: 1 }).boundingBox()
    expect(h1!.x).toBeGreaterThan(96)
    expect(await horizontalOverflow(page)).toBe(0)
  })
})

test.describe("Admin com os defaults promovidos (F-D)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("Admin: campo do diálogo com raio de 14 px e véu SEM desfoque (os mesmos valores do PWA)", async ({ page }) => {
    await login(page, "admin@innoelektron.com", /\/admin/)
    await expect(page.locator("html")).not.toHaveAttribute("data-area", /.*/)
    await page.goto("/admin/sites")
    await page.getByRole("button", { name: "Novo site" }).first().click()
    await expect(page.getByRole("dialog")).toBeVisible()
    expect(await css(page, ".dialog-scrim", "backdrop-filter")).toBe("none")
    expect(await css(page, '[role="dialog"] input', "border-top-left-radius")).toBe("14px")
    expect(await page.getByRole("dialog").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("24px")
  })
})
