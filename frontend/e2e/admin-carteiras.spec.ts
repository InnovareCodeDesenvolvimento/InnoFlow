import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → Carteiras (saldo e extrato dos motoristas), contra os mocks MSW
 * (`src/mocks/driversData.ts` + `handlers.ts`, espelho de `drivers.routes.ts`).
 * ADMIN busca → abre o extrato → ajusta o saldo COM confirmação; OPERATOR só
 * consulta (busca ≥ 3 letras, sem e-mail, sem botão de ajuste).
 *
 * Motorista de teste: "Carla Motorista" (`user_driver`, saldo inicial R$ 50,00)
 * — a MESMA carteira que o PWA lê, então creditar aqui muda o que ele vê lá.
 * "Patrícia Nunes" tem 35 lançamentos (paginação do extrato).
 */

const PASSWORD = "senha1234"
const money = (s: string | null) => (s ?? "").split(String.fromCharCode(160)).join(" ")

async function login(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

const search = (page: Page) => page.getByRole("searchbox", { name: "Buscar motorista" })
const drawer = (page: Page) => page.getByRole("dialog", { name: /Carla Motorista/ })

test.describe("ADMIN", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("navegação: 'Carteiras' no grupo Financeiro leva a /admin/carteiras", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Carteiras" }).click()
    await expect(page).toHaveURL(/\/admin\/carteiras$/)
    await expect(page.getByRole("heading", { name: "Carteiras", level: 1 })).toBeVisible()
  })

  test("lista todos com e-mail; busca → abre → credita R$ 50 COM confirmação → saldo muda no extrato e na lista", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await page.goto("/admin/carteiras")

    // ADMIN lista sem digitar nada; e-mail aparece (só ADMIN recebe).
    await expect(page.getByRole("row")).toHaveCount(13) // cabeçalho + 12 motoristas
    await expect(page.getByText("rafael.souza@example.com")).toBeVisible()
    // Dívida em destaque (Juliana tem R$ 18,50 em aberto).
    await expect(page.getByRole("row", { name: /Juliana Alves/ })).toContainText("18,50")

    await search(page).fill("carla")
    await expect(page.getByRole("row")).toHaveCount(2)
    const row = page.getByRole("row", { name: /Carla Motorista/ })
    await expect(row).toContainText("50,00")

    // ---- Extrato ------------------------------------------------------------
    await page.getByRole("button", { name: "Ver extrato de Carla Motorista" }).click()
    await expect(drawer(page)).toBeVisible()
    await expect(page.getByTestId("wallet-balance")).toHaveText(/R\$\s*50,00/)
    await expect(drawer(page).getByText("Saldo inicial de demonstração")).toBeVisible()
    await expect(drawer(page).getByText(/fica registrado na auditoria/)).toBeVisible()

    // ---- Ajuste: preencher → REVISAR (nada enviado) → confirmar ---------------
    await drawer(page).getByRole("button", { name: /Ajustar saldo/ }).click()
    const modal = page.getByRole("dialog", { name: "Ajustar saldo" })
    await expect(modal).toBeVisible()
    await modal.getByLabel(/Valor \(R\$\)/).fill("50,00")
    await modal.getByLabel(/Motivo/).fill("Saldo de teste para iniciar recarga")
    await modal.getByRole("button", { name: /Revisar lançamento/ }).click()

    await expect(page.getByTestId("adjust-summary")).toHaveText(/Creditar R\$\s*50,00 para Carla Motorista/)
    await expect(page.getByTestId("adjust-balance-after")).toHaveText(/R\$\s*100,00/)
    // Antes de confirmar, NADA mudou: o saldo do extrato continua R$ 50,00.
    expect(money(await page.getByTestId("wallet-balance").textContent())).toBe("R$ 50,00")

    await modal.getByRole("button", { name: "Confirmar crédito" }).click()
    await expect(page.getByText(/Crédito de R\$\s*50,00 registrado/)).toBeVisible() // toast
    await expect(modal).toHaveCount(0)

    // Extrato refeito (invalidação): saldo novo + lançamento no topo, com sinal e motivo.
    await expect(page.getByTestId("wallet-balance")).toHaveText(/R\$\s*100,00/)
    const newest = drawer(page).getByRole("listitem").first()
    await expect(newest).toContainText("Crédito manual")
    await expect(newest).toContainText("Saldo de teste para iniciar recarga")
    expect(money(await newest.textContent())).toContain("+ R$ 50,00")

    // Fecha o extrato: a LISTA também foi invalidada e mostra o saldo novo.
    await page.keyboard.press("Escape")
    await expect(drawer(page)).toHaveCount(0)
    await expect(page.getByRole("row", { name: /Carla Motorista/ })).toContainText("100,00")
  })

  test("validações do modal e cancelamento: nada é enviado", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await page.goto("/admin/carteiras")
    await search(page).fill("carla")
    await page.getByRole("button", { name: "Ver extrato de Carla Motorista" }).click()
    await drawer(page).getByRole("button", { name: /Ajustar saldo/ }).click()
    const modal = page.getByRole("dialog", { name: "Ajustar saldo" })

    // vazio → erros
    await modal.getByRole("button", { name: /Revisar lançamento/ }).click()
    await expect(modal.getByText("Informe o valor.")).toBeVisible()
    await expect(modal.getByText(/mínimo de 5 caracteres/)).toBeVisible()

    // teto
    await modal.getByLabel(/Valor \(R\$\)/).fill("5.000,01")
    await modal.getByLabel(/Motivo/).fill("Motivo ok")
    await expect(modal.getByText(/O máximo por lançamento é/)).toBeVisible()

    // débito acima do saldo
    await modal.getByText("Débito", { exact: true }).click()
    await modal.getByLabel(/Valor \(R\$\)/).fill("60")
    await expect(modal.getByText(/não pode passar do saldo atual/)).toBeVisible()

    // Cancelar: fecha e o saldo segue R$ 50,00
    await modal.getByRole("button", { name: "Cancelar" }).click()
    await expect(modal).toHaveCount(0)
    await expect(page.getByTestId("wallet-balance")).toHaveText(/R\$\s*50,00/)
  })

  test("extrato longo pagina (35 lançamentos → 4 páginas)", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await page.goto("/admin/carteiras")
    await search(page).fill("patricia")
    await page.getByRole("button", { name: "Ver extrato de Patrícia Nunes" }).click()
    const d = page.getByRole("dialog", { name: /Patrícia Nunes/ })
    await expect(d.getByRole("listitem")).toHaveCount(10)
    await expect(d.getByText(/de\s*35\s*lançamentos/)).toBeVisible()
    await d.getByRole("button", { name: "Próxima página" }).click()
    await expect(d.getByText(/Página\s*2\s*de\s*4/)).toBeVisible()
    await expect(d.getByRole("listitem")).toHaveCount(10)
  })
})

test.describe("OPERATOR — só consulta", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("precisa buscar (≥ 3 letras), não vê e-mail e não tem 'Ajustar saldo'", async ({ page }) => {
    await login(page, "operador@innoelektron.com")
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Carteiras" }).click()
    await expect(page).toHaveURL(/\/admin\/carteiras$/)

    // Sem busca: nada é listado, com explicação.
    await expect(page.getByText("Busque um motorista")).toBeVisible()
    await expect(page.getByRole("row")).toHaveCount(0)

    // 2 letras: ainda não busca.
    await search(page).fill("ca")
    await expect(page.getByText(/Faltam 1 caractere/)).toBeVisible()
    await expect(page.getByRole("row")).toHaveCount(0)

    // 3 letras: lista, SEM e-mail (LGPD — o servidor omite a chave).
    await search(page).fill("car")
    await expect(page.getByRole("row", { name: /Carla Motorista/ })).toBeVisible()
    await expect(page.getByText(/@example\.com|@innoelektron\.com/)).toHaveCount(0)

    await page.getByRole("button", { name: "Ver extrato de Carla Motorista" }).click()
    await expect(drawer(page)).toBeVisible()
    await expect(page.getByTestId("wallet-balance")).toBeVisible()
    await expect(drawer(page).getByText(/Somente consulta/)).toBeVisible()
    await expect(page.getByRole("button", { name: /Ajustar saldo/ })).toHaveCount(0)
  })
})

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("sem overflow horizontal; extrato abre em tela cheia e o ajuste cabe", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await page.goto("/admin/carteiras")
    await search(page).fill("carla")
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    await page.getByRole("button", { name: "Ver extrato de Carla Motorista" }).click()
    await expect(drawer(page)).toBeVisible()
    // (arredonda: durante a animação de entrada o Chromium devolve frações de pixel)
    await expect.poll(async () => Math.round((await drawer(page).boundingBox())!.width)).toBeLessThanOrEqual(390)
    await drawer(page).getByRole("button", { name: /Ajustar saldo/ }).click()
    const modal = page.getByRole("dialog", { name: "Ajustar saldo" })
    await expect(modal).toBeVisible()
    // Espera a animação de entrada do Dialog terminar (durante ela o `transform` do keyframe substitui o de centralização).
    await expect
      .poll(async () => {
        const box = await modal.boundingBox()
        return box ? [Math.round(box.x) >= 0, Math.round(box.x + box.width) <= 390] : null
      })
      .toEqual([true, true])
  })
})
