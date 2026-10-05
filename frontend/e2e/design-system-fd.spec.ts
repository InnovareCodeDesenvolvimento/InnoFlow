import { expect, test, type Page } from "@playwright/test"

/**
 * F-D do design system unificado (Admin) — docs/DESIGN-SYSTEM-UNIFICACAO.md §4. Contra os mocks MSW.
 * Prova o que a mudança de aparência prometeu e NÃO pode quebrar: sidebar escura com item ativo marcado, título único (sem heading no cabeçalho do shell), CTA lima único,
 * estados de erro/primeiro uso/acesso restrito com o mascote, tabelas compactas sem quebrar data/energia e o drawer mobile sem desfoque. Pixels são do harness `e2e-visual`.
 */

const LIME = "rgb(97, 219, 36)"
const PASSWORD = "senha1234"

async function login(page: Page, email = "admin@innoelektron.com") {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin/)
}

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test.describe("Admin — desktop (1440px)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("sidebar escura com degradê, item ativo com traço lima e aria-current; cabeçalho só com a trilha (sem heading)", async ({ page }) => {
    await login(page)
    await page.goto("/admin/sites")
    const nav = page.getByRole("navigation", { name: "Navegação do painel administrativo" })
    await expect(nav.locator("xpath=ancestor::aside")).toHaveClass(/surface-dark/)
    const ativo = nav.getByRole("link", { name: "Sites", exact: true })
    await expect(ativo).toHaveAttribute("aria-current", "page")
    await expect(ativo.locator("span.bg-lime")).toHaveCount(1)
    await expect(page.locator("header").first().getByRole("heading")).toHaveCount(0)
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sites")
    expect(await horizontalOverflow(page)).toBe(0)
  })

  test("Sites: o 'Novo site' do cabeçalho é o ÚNICO lima da tela; vazio de primeiro uso tem mascote e ação em vidro", async ({ page }) => {
    await login(page)
    await page.evaluate(() => localStorage.setItem("mock:admin-sites", "empty"))
    await page.goto("/admin/sites")
    await expect(page.getByText("Nenhum site cadastrado")).toBeVisible()
    await expect(page.locator(".surface-dark img[width='64']").first()).toBeVisible()
    const botoes = page.getByRole("button", { name: "Novo site" })
    await expect(botoes).toHaveCount(2)
    await expect(botoes.nth(0)).toHaveCSS("background-color", LIME)
    await expect(botoes.nth(1)).not.toHaveCSS("background-color", LIME)
  })

  test("erro de carga do Admin: card de marca com mascote e 'Tentar novamente'", async ({ page }) => {
    await login(page)
    await page.evaluate(() => localStorage.setItem("mock:admin-sites", "error"))
    await page.goto("/admin/sites")
    const erro = page.getByRole("alert").filter({ hasText: /sites|Falha/i })
    await expect(erro).toBeVisible()
    await expect(erro.locator("img").first()).toBeVisible()
    await expect(erro.getByRole("button", { name: "Tentar novamente" })).toBeVisible()
    await page.evaluate(() => localStorage.removeItem("mock:admin-sites"))
    await erro.getByRole("button", { name: "Tentar novamente" }).click()
    await expect(page.getByRole("table")).toBeVisible()
  })

  test("Dashboard: faixa de marca com mascote no topo (nunca sobre dado) e KPI-herói escuro único", async ({ page }) => {
    await login(page)
    await page.goto("/admin/dashboard")
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible()
    const faixa = page.locator("section.surface-dark").first()
    await expect(faixa.locator("img:visible").first()).toBeVisible()
    // Só um card inverso (herói) entre os KPIs; os demais são claros.
    await expect(page.locator(".grid .surface-dark")).toHaveCount(1)
    await expect(page.getByText("Faturamento", { exact: true }).first()).toBeVisible()
    expect(await horizontalOverflow(page)).toBe(0)
  })

  test("Sessões: tabela compacta não quebra a data em duas linhas e o detalhe abre sem desfoque", async ({ page }) => {
    await login(page)
    await page.goto("/admin/sessoes")
    const celula = page.locator("tbody tr").first().locator("td").first()
    await expect(celula).toBeVisible()
    expect(await celula.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap")
    // Mede o CONTEÚDO da célula da data (uma linha), não a altura da linha inteira: a altura da linha depende dos dados do mock (que usam `new Date()`) — um nome de local
    // longo ("Terminal Rodoviário Barra Funda") numa coluna estreita quebra em 3 linhas e estoura a linha sem que a data tenha quebrado.
    expect(
      await celula.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return range.getBoundingClientRect().height
      }),
    ).toBeLessThan(28)
    await page.locator("tbody tr").first().click()
    await expect(page.getByRole("dialog")).toBeVisible()
    expect(await page.locator(".dialog-scrim").evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none")
  })

  test("OPERATOR em tela só de ADMIN: 'Acesso restrito' de marca com mascote (texto igual ao de antes) e link de volta", async ({ page }) => {
    await login(page, "operador@innoelektron.com")
    await page.goto("/admin/auditoria")
    await expect(page.getByRole("heading", { level: 1, name: "Acesso restrito" })).toBeVisible()
    await expect(page.getByText("Você não tem permissão para acessar esta área.")).toBeVisible()
    await expect(page.locator(".surface-dark img[width='64']").first()).toBeVisible()
    await expect(page.getByRole("link", { name: "Voltar ao início" })).toBeVisible()
  })
})

test.describe("Admin — mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("cabeçalho com logo, drawer escuro com véu sem desfoque e fechamento por Esc/botão", async ({ page }) => {
    await login(page)
    await expect(page.getByRole("link", { name: "Ir para o site público" })).toBeVisible()
    await page.getByRole("button", { name: "Abrir menu" }).click()
    const drawer = page.getByRole("navigation", { name: "Navegação do painel administrativo (mobile)" })
    await expect(drawer).toBeVisible()
    await expect(drawer.locator("xpath=ancestor::div[contains(@class,'surface-dark')]")).toHaveCount(1)
    expect(await page.locator(".dialog-scrim").first().evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none")
    // diálogo de verdade: tem papel e nome, o foco entra, Esc fecha e o foco volta ao botão que abriu
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Fechar menu" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
    await expect(page.getByRole("button", { name: "Abrir menu" })).toBeFocused()
    await page.getByRole("button", { name: "Abrir menu" }).click()
    await expect(drawer).toBeVisible()
    await page.getByRole("button", { name: "Fechar menu" }).click()
    await expect(drawer).toBeHidden()
    expect(await horizontalOverflow(page)).toBe(0)
  })
})
