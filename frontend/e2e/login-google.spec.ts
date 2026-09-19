import { expect, test } from "@playwright/test"

/**
 * "Continuar com o Google" no Login e no Cadastro, contra os mocks MSW
 * (`src/mocks/handlers.ts`). O script real do Google não roda em `localhost`
 * com Client ID fake, então em modo mock a tela mostra um botão "Google
 * (mock)" no lugar do oficial (`GoogleAuthSection`, só com `VITE_USE_MOCKS`) —
 * o que este spec prova é o FLUXO (config → botão → `POST /api/auth/google` →
 * sessão → redirecionamento), não o iframe do Google.
 *
 * `mock:google-disabled` (localStorage) faz `GET /api/public/config` devolver
 * `googleClientId: null` — a feature "nasce desligada" até o dono configurar
 * o Client ID no backend, e a tela não pode ficar com botão quebrado.
 */

const MOCK_GOOGLE_BUTTON = /Continuar com o Google \(mock\)/
const DIVIDER = "ou continue com e-mail"
const CHARGE_POINT_URL = "/c/CP-VILA-NORTE-01/1"

test.describe("login com Google desligado (config sem Client ID)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mock:google-disabled", "1"))
  })

  for (const path of ["/login", "/cadastro"]) {
    test(`${path}: sem botão, sem divisor — só o formulário normal`, async ({ page }) => {
      await page.goto(path)
      await expect(page.getByLabel("E-mail")).toBeVisible()
      await expect(page.getByRole("button", { name: /Google/ })).toHaveCount(0)
      await expect(page.getByText(DIVIDER)).toHaveCount(0)
    })
  }
})

test.describe("login com Google ligado (config com Client ID)", () => {
  test("login: botão + divisor no topo do card; entra e cai na home do motorista", async ({ page }) => {
    await page.goto("/login")
    await expect(page.getByText(DIVIDER)).toBeVisible()
    await page.getByRole("button", { name: MOCK_GOOGLE_BUTTON }).click()
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("navigation", { name: "Navegação do aplicativo" })).toBeVisible()
  })

  test("cadastro: botão do Google cria/entra direto, sem pedir senha", async ({ page }) => {
    await page.goto("/cadastro")
    await expect(page.getByRole("button", { name: MOCK_GOOGLE_BUTTON })).toBeVisible()
    await page.getByRole("button", { name: MOCK_GOOGLE_BUTTON }).click()
    await expect(page).toHaveURL(/\/app$/)
  })

  test("fluxo do QR: escaneia → login → Google → volta pro carregador", async ({ page }) => {
    await page.goto(`/login?redirect=${encodeURIComponent(CHARGE_POINT_URL)}`)
    await page.getByRole("button", { name: MOCK_GOOGLE_BUTTON }).click()
    await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/")))
    await expect(page.getByText("Seu saldo")).toBeVisible()
  })

  test("o ?redirect= sobrevive à ida e volta Login ↔ Cadastro (QR de quem ainda não tem conta)", async ({ page }) => {
    await page.goto(`/login?redirect=${encodeURIComponent(CHARGE_POINT_URL)}`)
    await page.getByRole("link", { name: "Cadastre-se" }).click()
    await expect(page).toHaveURL(/\/cadastro\?redirect=/)
    await page.getByRole("button", { name: MOCK_GOOGLE_BUTTON }).click()
    await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/")))
  })

  test("conta de operação/administração: erro claro em português, sem sair da tela", async ({ page }) => {
    await page.goto("/login")
    await page.getByRole("button", { name: "Simular conta de operação (mock)" }).click()
    await expect(page.getByRole("alert")).toContainText("operação/administração")
    await expect(page.getByRole("alert")).toContainText("e-mail e senha")
    await expect(page).toHaveURL(/\/login$/)
    // O formulário normal continua funcionando depois do erro.
    await expect(page.getByLabel("E-mail")).toBeVisible()
  })

  test("erro no Cadastro (401 do token) não dá hard-redirect pro login", async ({ page }) => {
    await page.goto("/cadastro")
    await page.getByRole("button", { name: "Simular conta de operação (mock)" }).click()
    await expect(page.getByRole("alert")).toContainText("não pode entrar com o Google")
    await expect(page).toHaveURL(/\/cadastro$/)
  })
})

for (const viewport of [
  { name: "320px", width: 320, height: 640 },
  { name: "390px", width: 390, height: 844 },
  { name: "1440px", width: 1440, height: 900 },
]) {
  test(`sem overflow horizontal no login e no cadastro — ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    for (const path of ["/login", "/cadastro"]) {
      await page.goto(path)
      await expect(page.getByRole("button", { name: MOCK_GOOGLE_BUTTON })).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `${path} em ${viewport.name}`).toBeLessThanOrEqual(0)
    }
  })
}
