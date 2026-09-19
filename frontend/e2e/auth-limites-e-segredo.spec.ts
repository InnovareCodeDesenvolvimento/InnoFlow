import { expect, test, type Page } from "@playwright/test"

/**
 * Dois contratos que o backend endureceu (Órion, 19/09/2026), contra os mocks
 * MSW (`src/mocks/handlers.ts`) — nada aqui foi provado contra o backend real:
 *
 *  1. Login/Google respondem 429 em dois sabores — `RATE_LIMITED_ACCOUNT` (por
 *     conta) e `RATE_LIMITED_AUTH` (por IP) — e a tela mostra texto distinto
 *     para cada, sem deslogar e sem confirmar se o e-mail existe.
 *  2. `basicAuthSecret` do carregador: 16 a 40 caracteres (era 8).
 */

const ACCOUNT_MSG = /Muitas tentativas para esta conta\. Aguarde alguns minutos/
const IP_MSG = /Muitas tentativas em pouco tempo a partir desta conexão\. Aguarde alguns minutos/

async function tryLogin(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill("qualquer-senha-123")
  await page.getByRole("button", { name: "Entrar" }).click()
}

test.describe("login — 429 por conta x por IP", () => {
  test("por CONTA: mensagem própria, fica no /login e não confirma se o e-mail existe", async ({ page }) => {
    await tryLogin(page, "conta-bloqueada@example.com")
    const alert = page.getByRole("alert")
    await expect(alert).toContainText("Muitas tentativas para esta conta")
    await expect(alert).toContainText("Aguarde alguns minutos")
    await expect(alert).not.toContainText(/senha|e-mail|existe|cadastrad/i)
    await expect(page).toHaveURL(/\/login$/)
  })

  test("por IP: mensagem genérica, DIFERENTE da por conta", async ({ page }) => {
    await tryLogin(page, "ip-bloqueado@example.com")
    await expect(page.getByRole("alert")).toHaveText(IP_MSG)
    await expect(page.getByRole("alert")).not.toHaveText(ACCOUNT_MSG)
    await expect(page).toHaveURL(/\/login$/)
  })

  test("senha errada segue com a mensagem de credenciais (429 não mexeu nesse caminho)", async ({ page }) => {
    await tryLogin(page, "admin@innoelektron.com")
    await expect(page.getByRole("alert")).toContainText("E-mail ou senha inválidos")
  })

  test("o 429 não limpa uma sessão já aberta: token segue no storage depois do erro", async ({ page }) => {
    await page.goto("/login")
    await page.evaluate(() => localStorage.setItem("innoelektron_token", "token-ja-logado"))
    await page.getByLabel("E-mail").fill("conta-bloqueada@example.com")
    await page.getByLabel("Senha").fill("qualquer-senha-123")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByRole("alert")).toContainText("Muitas tentativas para esta conta")
    expect(await page.evaluate(() => localStorage.getItem("innoelektron_token"))).toBe("token-ja-logado")
  })
})

test.describe("Google — 429 por IP", () => {
  for (const path of ["/login", "/cadastro"]) {
    test(`${path}: mensagem de limite, sem sair da tela`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("mock:google-rate-limited", "1"))
      await page.goto(path)
      await page.getByRole("button", { name: /Continuar com o Google \(mock\)/ }).click()
      await expect(page.getByRole("alert")).toHaveText(IP_MSG)
      await expect(page).toHaveURL(new RegExp(`${path}$`))
    })
  }
})

test.describe("Admin — segredo Basic Auth do carregador (16 a 40)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  async function openNewChargePoint(page: Page) {
    await page.goto("/login")
    await page.getByLabel("E-mail").fill("admin@innoelektron.com")
    await page.getByLabel("Senha").fill("senha1234")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)
    await page.getByRole("navigation", { name: "Navegação do painel" }).getByRole("link", { name: "Pontos de recarga" }).click()
    await page.getByRole("button", { name: "Novo ponto de recarga" }).first().click()
    return page.getByRole("dialog")
  }

  test("criação: 8 caracteres (o mínimo antigo) é recusado no campo, sem chamar a API; 16 passa", async ({ page }) => {
    const dialog = await openNewChargePoint(page)
    const posts: string[] = []
    page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/admin/charge-points") && posts.push(r.url()))

    await expect(dialog.getByText(/De 16 a 40 caracteres/)).toBeVisible()
    await dialog.getByLabel("Site").selectOption({ index: 1 })
    await dialog.getByLabel("Identidade OCPP").fill(`CP-E2E-${Date.now()}`)

    const secret = dialog.getByLabel(/Segredo Basic Auth/)
    await secret.fill("12345678")
    await dialog.getByRole("button", { name: "Criar ponto de recarga" }).click()
    await expect(dialog.getByRole("alert")).toContainText("no mínimo 16 caracteres")
    await expect(secret).toHaveAttribute("aria-invalid", "true")
    expect(posts).toHaveLength(0)

    await secret.fill("s".repeat(16))
    await dialog.getByRole("button", { name: "Criar ponto de recarga" }).click()
    await expect(page.getByText("Ponto de recarga criado.")).toBeVisible()
    expect(posts).toHaveLength(1)
  })

  test("criação: 41 caracteres é recusado; vazio pede o segredo NO campo (não só toast)", async ({ page }) => {
    const dialog = await openNewChargePoint(page)
    await dialog.getByLabel("Site").selectOption({ index: 1 })
    await dialog.getByLabel("Identidade OCPP").fill("CP-E2E-LIMITE")
    const secret = dialog.getByLabel(/Segredo Basic Auth/)

    await dialog.getByRole("button", { name: "Criar ponto de recarga" }).click()
    await expect(dialog.getByRole("alert")).toContainText("Informe o segredo")
    await expect(secret).toBeFocused()

    await secret.fill("s".repeat(41))
    await dialog.getByRole("button", { name: "Criar ponto de recarga" }).click()
    await expect(dialog.getByRole("alert")).toContainText("no máximo 40 caracteres")
  })

  test("edição: em branco mantém o segredo (salva); preenchido com menos de 16 é recusado", async ({ page }) => {
    await openNewChargePoint(page)
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: /^Editar / }).first().click()
    const dialog = page.getByRole("dialog")
    const secret = dialog.getByLabel(/Novo segredo Basic Auth/)
    await expect(dialog.getByText(/Deixe em branco para manter o segredo atual\. Se trocar: de 16 a 40 caracteres/)).toBeVisible()

    await secret.fill("curto123")
    await dialog.getByRole("button", { name: "Salvar alterações" }).click()
    await expect(dialog.getByRole("alert")).toContainText("no mínimo 16 caracteres")

    await secret.fill("")
    await dialog.getByRole("button", { name: "Salvar alterações" }).click()
    await expect(page.getByText("Ponto de recarga atualizado.")).toBeVisible()
  })
})
