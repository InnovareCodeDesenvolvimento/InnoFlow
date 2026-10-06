import { expect, test, type Page } from "@playwright/test"

/**
 * `/login` LIMPO: a URL do login nunca mostra `?redirect=...`. O destino de retorno fica em `sessionStorage` (`innoflow:return-to`, validade de 30 min,
 * `lib/authRedirect.ts`). Contra os mocks MSW. A barra de endereço é lida do navegador (`page.url()`), não deduzida do código.
 */

const KEY = "innoflow:return-to"
const TOKEN_KEY = "innoelektron_token"
const CHARGE_POINT_URL = "/c/CP-VILA-NORTE-01/1"
const MOCK_GOOGLE = /Continuar com o Google \(mock\)/

/** Pathname + search REAIS da barra de endereço. */
const bar = (page: Page) => {
  const u = new URL(page.url())
  return `${u.pathname}${u.search}`
}

async function entrar(page: Page, email = "motorista@innoelektron.com") {
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill("senha1234")
  await page.getByRole("button", { name: "Entrar" }).click()
}

test.describe("login sem ?redirect=", () => {
  test("(a) rota protegida do motorista sem sessão: a barra mostra /login exato e, depois de entrar, volta para a rota original", async ({ page }) => {
    await page.goto("/app/carteira")
    await expect(page).toHaveURL(/\/login$/)
    expect(bar(page)).toBe("/login")
    expect(page.url()).not.toContain("redirect")
    await entrar(page)
    await expect(page).toHaveURL(/\/app\/carteira$/)
    expect(await page.evaluate((k) => sessionStorage.getItem(k), KEY)).toBeNull() // uso único
  })

  test("(a) painel do administrador: /admin/dashboard sem sessão -> /login exato -> volta para /admin/dashboard", async ({ page }) => {
    await page.goto("/admin/dashboard")
    await expect(page).toHaveURL(/\/login$/)
    expect(bar(page)).toBe("/login")
    await entrar(page, "admin@innoelektron.com")
    await expect(page).toHaveURL(/\/admin\/dashboard$/)
  })

  test("(b) fluxo do QR: /c/CP-01/1 deslogado -> Entrar para carregar -> /login exato -> volta para o carregador", async ({ page }) => {
    await page.goto(CHARGE_POINT_URL)
    await page.getByRole("link", { name: "Entrar para carregar" }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect(bar(page)).toBe("/login")
    await entrar(page)
    await expect(page).toHaveURL(new RegExp(`${CHARGE_POINT_URL.replace(/\//g, "\\/")}$`))
    await expect(page.getByText("Seu saldo")).toBeVisible()
  })

  test("(b) QR de quem ainda não tem conta: /login e /cadastro limpos; criada a conta, volta ao carregador", async ({ page }) => {
    await page.goto(CHARGE_POINT_URL)
    await page.getByRole("link", { name: "Entrar para carregar" }).click()
    await page.getByRole("link", { name: "Cadastre-se" }).click()
    await expect(page).toHaveURL(/\/cadastro$/)
    expect(bar(page)).toBe("/cadastro")
    await page.getByRole("button", { name: MOCK_GOOGLE }).click()
    await expect(page).toHaveURL(new RegExp(`${CHARGE_POINT_URL.replace(/\//g, "\\/")}$`))
  })

  test("(c) link antigo /login?redirect=/x é absorvido UMA vez, some da barra e o destino vale depois do login", async ({ page }) => {
    await page.goto(`/login?redirect=${encodeURIComponent("/app/carteira")}`)
    await expect(page).toHaveURL(/\/login$/)
    expect(bar(page)).toBe("/login")
    await entrar(page)
    await expect(page).toHaveURL(/\/app\/carteira$/)
  })

  test("(c) link antigo /cadastro?redirect=/x também some da barra", async ({ page }) => {
    await page.goto(`/cadastro?redirect=${encodeURIComponent(CHARGE_POINT_URL)}`)
    await expect(page).toHaveURL(/\/cadastro$/)
    expect(bar(page)).toBe("/cadastro")
    await page.getByRole("button", { name: MOCK_GOOGLE }).click()
    await expect(page).toHaveURL(new RegExp(`${CHARGE_POINT_URL.replace(/\//g, "\\/")}$`))
  })

  for (const hostil of ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)"]) {
    test(`(d) valor hostil ${JSON.stringify(hostil)} é descartado: barra limpa e login cai em /app`, async ({ page }) => {
      await page.goto(`/login?redirect=${encodeURIComponent(hostil)}`)
      await expect(page).toHaveURL(/\/login$/)
      expect(await page.evaluate((k) => sessionStorage.getItem(k), KEY)).toBeNull()
      await entrar(page)
      await expect(page).toHaveURL(/localhost:\d+\/app$/)
    })
  }

  test("(e) destino com mais de 30 min é ignorado: o login cai na casa do papel", async ({ page }) => {
    await page.goto("/login")
    await page.evaluate((k) => sessionStorage.setItem(k, JSON.stringify({ path: "/app/carteira", at: Date.now() - 31 * 60 * 1000 })), KEY)
    await entrar(page)
    await expect(page).toHaveURL(/\/app$/)
  })

  test("(f) sessionStorage bloqueado: /login segue limpo e o login funciona (casa do papel)", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", {
        get() {
          throw new DOMException("bloqueado", "SecurityError")
        },
      })
    })
    await page.goto("/app/carteira")
    await expect(page).toHaveURL(/\/login$/)
    expect(bar(page)).toBe("/login")
    await entrar(page)
    await expect(page).toHaveURL(/\/app$/)
  })

  test("(g) 401 no meio do uso (hard redirect do interceptor): a barra vai para /login exato e, ao entrar de novo, volta para onde o 401 pegou", async ({ page }) => {
    await page.goto("/login")
    await entrar(page)
    await expect(page).toHaveURL(/\/app$/)
    // Sessão que expira no servidor: o token some e a próxima chamada da API volta 401 (o mock não reconhece quem não manda token). Quem ganha a corrida entre a
    // consulta periódica da Home e o clique no menu decide a página onde o 401 pega (/app ou /app/carteira); o que se prova é que o login devolve EXATAMENTE a ela.
    await page.evaluate((k) => {
      localStorage.removeItem(k)
      const link = Array.from(document.querySelectorAll("a")).find((a) => a.getAttribute("href") === "/app/carteira")
      link?.click()
    }, TOKEN_KEY)
    await expect(page).toHaveURL(/\/login$/)
    expect(bar(page)).toBe("/login")
    expect(page.url()).not.toContain("redirect")
    const guardado = JSON.parse((await page.evaluate((k) => sessionStorage.getItem(k), KEY)) as string) as { path: string }
    expect(["/app", "/app/carteira"]).toContain(guardado.path)
    await entrar(page)
    await expect(page).toHaveURL(new RegExp(`${guardado.path}$`))
  })
})
