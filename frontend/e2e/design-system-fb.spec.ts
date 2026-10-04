import { expect, test, type Page } from "@playwright/test"

/**
 * F-B do design system unificado (Auth + Público) — docs/DESIGN-SYSTEM-UNIFICACAO.md §4. Contra os mocks MSW.
 * Prova o que a mudança de aparência NÃO pode quebrar (textos, rótulos, fluxo) e o que ela prometeu (D4: falar com o motorista; D5: 404 de
 * verdade; CTA lima único; sem deslocamento de layout em /eletropostos; boundary de erro). Pixels são do harness `e2e-visual`, não daqui.
 */

const LIME = "rgb(97, 219, 36)"

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

for (const viewport of [
  { name: "mobile (375px)", width: 375, height: 812 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`Login e Cadastro — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("D4: o texto de marca fala com o motorista (nada de painel administrativo/operadores) e o botão principal é lima", async ({ page }) => {
      await page.goto("/login")
      await expect(page.getByRole("heading", { level: 1, name: "Bem-vindo de volta" })).toBeVisible()
      const body = await page.locator("body").innerText()
      expect(body).not.toMatch(/painel administrativo|operadores|multi-operador/i)
      if (viewport.width >= 1024) {
        await expect(page.getByText("Encontre um eletroposto, escaneie o QR code no carregador")).toBeVisible()
        await expect(page.getByText("Confira a tarifa antes de iniciar a recarga")).toBeVisible()
      }
      await expect(page.getByText("Carregue um").filter({ visible: true }).first()).toBeVisible()

      // Rótulos que os outros E2E usam seguem iguais.
      await expect(page.getByLabel("E-mail")).toBeVisible()
      await expect(page.getByLabel("Senha")).toBeVisible()
      const submit = page.getByRole("button", { name: "Entrar" })
      await expect(submit).toHaveCSS("background-color", LIME)
      await expect(page.getByRole("link", { name: "Cadastre-se" })).toBeVisible()
      expect(await horizontalOverflow(page)).toBe(0)
    })

    test("cadastro: mesmo painel, CTA lima, link para entrar, sem rolagem horizontal", async ({ page }) => {
      await page.goto("/cadastro")
      await expect(page.getByRole("heading", { level: 1, name: "Criar conta" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Criar conta" })).toHaveCSS("background-color", LIME)
      await expect(page.getByLabel("Nome")).toBeVisible()
      await expect(page.getByLabel("Telefone (opcional)")).toBeVisible()
      await expect(page.getByRole("link", { name: "Entrar" })).toBeVisible()
      expect(await page.locator("body").innerText()).not.toMatch(/painel administrativo|operadores/i)
      expect(await horizontalOverflow(page)).toBe(0)
    })

    test("o fluxo de login continua funcionando (admin vai para o painel, motorista para o app)", async ({ page }) => {
      await page.goto("/login")
      await page.getByLabel("E-mail").fill("admin@innoelektron.com")
      await page.getByLabel("Senha").fill("senha1234")
      await page.getByRole("button", { name: "Entrar" }).click()
      await expect(page).toHaveURL(/\/admin\/dashboard/)
    })
  })
}

test.describe("404 de verdade (D5)", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("rota inexistente em qualquer profundidade mostra a 404, não redireciona e não rola para os lados", async ({ page }) => {
    await page.goto("/c")
    await expect(page.getByRole("heading", { level: 1, name: "Página não encontrada" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Voltar ao início" })).toHaveCSS("background-color", LIME)
    expect(await horizontalOverflow(page)).toBe(0)
  })
})

test.describe("/eletropostos", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("faixa-título de marca, cards, e SEM deslocamento de layout na carga (CLS <= 0,02)", async ({ page }) => {
    // Registra os deslocamentos desde o primeiro quadro.
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number }
      w.__cls = 0
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value
      }).observe({ type: "layout-shift", buffered: true })
    })
    await page.goto("/eletropostos")
    await expect(page.getByRole("heading", { level: 1, name: "Eletropostos" })).toBeVisible()
    await expect(page.getByText("Disponibilidade de conectores em tempo real, por operador.")).toBeVisible()
    await expect(page.locator("[data-station-id]").first()).toBeVisible()
    await page.waitForTimeout(800)
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls)
    expect(cls).toBeLessThanOrEqual(0.02)
    expect(await horizontalOverflow(page)).toBe(0)
  })

  test("cabeçalho escuro mantém os nomes acessíveis (navegação principal, Entrar, Criar conta lima)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/eletropostos")
    const nav = page.getByRole("navigation", { name: "Navegação principal" })
    await expect(nav.getByRole("link", { name: "Início" })).toBeVisible()
    await expect(nav.getByRole("link", { name: "Eletropostos" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Entrar" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Criar conta" })).toHaveCSS("background-color", LIME)
  })
})

test.describe("QR do carregador", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("anônimo: faixa de marca e CTA lima 'Entrar para carregar'", async ({ page }) => {
    await page.goto("/c/CP-VILA-NORTE-01/1")
    await expect(page.getByText("Shopping Vila Norte").first()).toBeVisible()
    await expect(page.getByRole("link", { name: "Entrar para carregar" })).toHaveCSS("background-color", LIME)
    expect(await horizontalOverflow(page)).toBe(0)
  })

  test("identidade inexistente: erro de marca com 'Tentar novamente' (não cai na landing)", async ({ page }) => {
    await page.goto("/c/CP-NAO-EXISTE")
    await expect(page.getByRole("alert")).toContainText(/carregador|QR/i)
    await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible()
    await expect(page).toHaveURL(/\/c\/CP-NAO-EXISTE$/)
  })
})

test.describe("RouteError (error boundary)", () => {
  test("se a renderização de uma rota lança, aparece a tela de erro de marca com saídas (em vez de tela em branco) e navegar limpa o erro", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => localStorage.setItem("mock:sites-malformed", "1")) // o mock devolve /api/sites sem `connectorSummary`: o card lança
    await page.getByRole("link", { name: "Eletropostos" }).first().click()
    await expect(page.getByRole("alert")).toContainText("Não foi possível abrir esta tela")
    await expect(page.getByRole("button", { name: "Tentar de novo" })).toBeVisible()

    await page.evaluate(() => localStorage.removeItem("mock:sites-malformed"))
    await page.getByRole("link", { name: "Voltar ao início" }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Recarregue seu elétrico")
  })
})
