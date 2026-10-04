import { expect, test, type Page } from "@playwright/test"

/**
 * I-7 (decisão do dono, 04/10/2026): pagar com CARTÃO exige identidade verificada (login com Google) e some por um tempo depois de recusas em excesso.
 * Pix e carteira NÃO mudam. Contra o mock MSW (`mocks/meData.ts#cardEligibilityFor`): NADA aqui foi provado contra o backend real nem contra o Google real -
 * o botão é o "Continuar com o Google (mock)". O estado do mock vive na página: cada teste faz UM login e o resto é navegação interna.
 *
 * Contas (ver `mocks/data.ts`): `cartoes@` (elegível, 4 cartões), `so-senha@` (GOOGLE_LOGIN_REQUIRED, 2 cartões), `bloqueado-cartao@` (TEMPORARILY_BLOCKED, 1 cartão).
 * Override do servidor que muda de ideia depois do GET: `localStorage["mock:card-refusal"]`.
 */

const PASSWORD = "senha1234"
const CHARGE_POINT_URL = "/c/CP-VILA-NORTE-01/1"
const SO_SENHA = "so-senha@innoelektron.com"
const BLOQUEADO = "bloqueado-cartao@innoelektron.com"
const ELEGIVEL = "cartoes@innoelektron.com"

async function login(page: Page, email: string, redirect = "/app") {
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`)
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(new RegExp(redirect.replace(/\//g, "\\/")))
}

const notice = (page: Page) => page.getByTestId("card-eligibility-notice")
const addCardButton = (page: Page) => page.getByRole("button", { name: "Adicionar cartão" })

for (const viewport of [
  { name: "mobile (375px)", width: 375, height: 812 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`Meus cartões — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("só senha: sem 'Adicionar cartão', card explica em linguagem simples com CTA do Google, cartões desabilitados com o motivo", async ({ page }) => {
      await login(page, SO_SENHA, "/app/carteira/cartoes")

      await expect(notice(page)).toHaveAttribute("data-reason", "GOOGLE_LOGIN_REQUIRED")
      await expect(notice(page)).toContainText("Para pagar com cartão, entre com sua conta Google")
      await expect(notice(page)).toContainText("É uma proteção contra fraude. Pix e carteira continuam disponíveis.")
      // O que o vínculo faz de verdade (o servidor zera a senha e exige o mesmo e-mail) está dito ANTES do clique.
      await expect(page.getByTestId("card-eligibility-link-note")).toContainText("mesmo e-mail")
      await expect(page.getByTestId("card-eligibility-link-note")).toContainText(SO_SENHA)
      await expect(page.getByTestId("card-eligibility-link-note")).toContainText("Sua senha continua valendo")
      await expect(notice(page).getByRole("button", { name: /Continuar com o Google/ })).toBeVisible()
      await expect(addCardButton(page)).toHaveCount(0)

      // Cartões já cadastrados: aparecem, mas desabilitados e com o motivo.
      const items = page.getByRole("listitem").filter({ hasText: "••••" })
      await expect(items).toHaveCount(2)
      for (const item of await items.all()) {
        await expect(item).toHaveAttribute("data-disabled", "true")
        await expect(item.getByText("Indisponível", { exact: true })).toBeVisible()
        await expect(item.getByTestId("card-disabled-reason")).toContainText("Entre com o Google")
      }
      // Sem "Tornar padrão" (não se escolhe cartão que não pode ser usado); remover continua possível.
      await page.getByRole("button", { name: /Mais opções — cartão Master/ }).click()
      await expect(page.getByRole("menuitem", { name: "Remover" })).toBeVisible()
      await expect(page.getByRole("menuitem", { name: "Tornar padrão" })).toHaveCount(0)
      await page.keyboard.press("Escape")

      // Sem rolagem horizontal.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    })

    test("só senha: vincular o Google libera o cartão (botão volta, cartões habilitados)", async ({ page }) => {
      await login(page, SO_SENHA, "/app/carteira/cartoes")
      const tokenBefore = await page.evaluate(() => localStorage.getItem("innoelektron_token"))
      const calls: string[] = []
      page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/auth/google") && calls.push(new URL(r.url()).pathname))
      await notice(page).getByRole("button", { name: /Continuar com o Google/ }).click()

      await expect(page.getByText("Pronto! Agora você pode pagar com cartão.")).toBeVisible()
      // Endpoint AUTENTICADO de vínculo - nunca o login público (que ignora quem está logado, zera a senha e pode trocar de conta).
      expect(calls).toEqual(["/api/auth/google/link"])
      // A sessão segue a mesma: mesmo token, mesma conta (o cabeçalho continua mostrando o nome), sem novo login.
      expect(await page.evaluate(() => localStorage.getItem("innoelektron_token"))).toBe(tokenBefore)
      await expect(page.getByText("Sofia")).toBeVisible()
      await expect(notice(page)).toHaveCount(0)
      await expect(addCardButton(page)).toBeVisible()
      await expect(page.getByText("Indisponível", { exact: true })).toHaveCount(0)
      await expect(page.getByTestId("card-disabled-reason")).toHaveCount(0)
    })

    test("bloqueado: 'indisponível até HH:MM' (horário do servidor), sem CTA de Google e sem 'Adicionar cartão'", async ({ page }) => {
      const eligibility = page.waitForResponse((r) => r.url().endsWith("/api/me/payment-methods") && r.request().method() === "GET")
      await login(page, BLOQUEADO, "/app/carteira/cartoes")
      const { cardEligibility } = (await (await eligibility).json()) as { cardEligibility: { reason: string; blockedUntil: string } }
      expect(cardEligibility.reason).toBe("TEMPORARILY_BLOCKED")
      const hhmm = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(cardEligibility.blockedUntil))

      await expect(notice(page)).toHaveAttribute("data-reason", "TEMPORARILY_BLOCKED")
      await expect(notice(page)).toContainText(new RegExp(`Pagamento com cartão indisponível até (\\d{2}/\\d{2} às )?${hhmm}`))
      await expect(notice(page)).toContainText("Pix e carteira continuam disponíveis")
      await expect(notice(page).getByRole("button")).toHaveCount(0) // não há o que fazer além de esperar
      await expect(addCardButton(page)).toHaveCount(0)
      await expect(page.getByTestId("card-disabled-reason")).toContainText("Volta a ficar disponível")
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    })

    test("elegível: nada muda (botão 'Adicionar cartão', sem aviso, cartões normais)", async ({ page }) => {
      await login(page, ELEGIVEL, "/app/carteira/cartoes")
      await expect(addCardButton(page)).toBeVisible()
      await expect(notice(page)).toHaveCount(0)
      await expect(page.getByTestId("card-disabled-reason")).toHaveCount(0)
      await expect(page.getByText("Indisponível", { exact: true })).toHaveCount(0)
    })
  })
}

test.describe("na página do carregador (QR) — Pix e carteira intactos", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("só senha: sem seletor de cartão, aviso com CTA, e dá para iniciar a recarga pela carteira", async ({ page }) => {
    await login(page, SO_SENHA, CHARGE_POINT_URL)

    await expect(notice(page)).toHaveAttribute("data-reason", "GOOGLE_LOGIN_REQUIRED")
    await expect(page.getByRole("radio", { name: /Visa|Master/ })).toHaveCount(0) // nada de "Pagar com cartão"
    await expect(page.getByRole("radiogroup", { name: "Forma de pagamento" })).toHaveCount(0)
    await expect(page.getByText("pré-autorização")).toHaveCount(0)

    const requests: string[] = []
    page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/me/sessions/start") && requests.push(r.postData() ?? ""))
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)
    expect(JSON.parse(requests[0]).payment).toEqual({ mode: "WALLET" })
  })

  test("bloqueado: mesmo caminho - aviso com o horário e recarga pela carteira funcionando", async ({ page }) => {
    await login(page, BLOQUEADO, CHARGE_POINT_URL)
    await expect(notice(page)).toContainText("Pagamento com cartão indisponível até")
    await expect(page.getByRole("radiogroup", { name: "Forma de pagamento" })).toHaveCount(0)
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)
  })

  test("elegível: o seletor de cartão continua aparecendo e o cartão padrão vem selecionado", async ({ page }) => {
    await login(page, ELEGIVEL, CHARGE_POINT_URL)
    await expect(notice(page)).toHaveCount(0)
    await expect(page.getByRole("radio", { name: /Visa.*1234/ })).toBeChecked()
  })

  test("Pix intacto: o caminho de adicionar saldo segue aberto para quem não pode usar cartão", async ({ page }) => {
    await login(page, SO_SENHA, "/app/carteira")
    await page.getByRole("link", { name: /Adicionar saldo/ }).click()
    await expect(page).toHaveURL(/\/app\/carteira\/adicionar/)
    await expect(page.getByRole("heading", { name: /Adicionar saldo/ })).toBeVisible()
  })

  test("o servidor recusa o cartão no início (bloqueio que começou depois do GET): 429 vira aviso com o horário, seletor some, carteira inicia", async ({ page }) => {
    await login(page, ELEGIVEL, CHARGE_POINT_URL)
    await expect(page.getByRole("radio", { name: /Visa.*1234/ })).toBeChecked() // o GET ainda dizia "elegível"

    await page.evaluate(() => localStorage.setItem("mock:card-refusal", "TEMPORARILY_BLOCKED"))
    await page.getByRole("button", { name: "Iniciar recarga" }).click()

    await expect(page.getByRole("alert").filter({ hasText: "Pagamento com cartão indisponível até" })).toBeVisible()
    await expect(notice(page)).toHaveAttribute("data-reason", "TEMPORARILY_BLOCKED")
    await expect(page.getByRole("radiogroup", { name: "Forma de pagamento" })).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/"))) // não navegou

    await page.getByRole("button", { name: "Iniciar recarga" }).click() // agora vai pela carteira
    await expect(page).toHaveURL(/\/app\/sessao/)
  })

  test("o servidor recusa por identidade (403) ao iniciar: aviso do Google em vez de erro genérico", async ({ page }) => {
    await login(page, ELEGIVEL, CHARGE_POINT_URL)
    await page.evaluate(() => localStorage.setItem("mock:card-refusal", "GOOGLE_LOGIN_REQUIRED"))
    await page.getByRole("button", { name: "Iniciar recarga" }).click()

    await expect(page.getByRole("alert").filter({ hasText: "entre com sua conta Google" })).toBeVisible()
    await expect(notice(page)).toHaveAttribute("data-reason", "GOOGLE_LOGIN_REQUIRED")
    await expect(page.getByRole("radiogroup", { name: "Forma de pagamento" })).toHaveCount(0)
  })
})

test.describe("cadastro de cartão recusado pelo servidor", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("403 ao pedir a sessão de tokenização: nenhuma aba abre e o card explicativo aparece no lugar do botão", async ({ page, context }) => {
    await login(page, ELEGIVEL, "/app/carteira/cartoes")
    await page.evaluate(() => localStorage.setItem("mock:card-refusal", "GOOGLE_LOGIN_REQUIRED"))
    let opened = 0
    context.on("page", () => opened++)

    await addCardButton(page).click()
    await expect(notice(page)).toHaveAttribute("data-reason", "GOOGLE_LOGIN_REQUIRED")
    await expect(addCardButton(page)).toHaveCount(0)
    expect(opened).toBe(0)
  })

  test("429 ao pedir a sessão: bloqueio com o horário", async ({ page }) => {
    await login(page, ELEGIVEL, "/app/carteira/cartoes")
    await page.evaluate(() => localStorage.setItem("mock:card-refusal", "TEMPORARILY_BLOCKED"))
    await addCardButton(page).click()
    await expect(notice(page)).toContainText("Pagamento com cartão indisponível até")
    await expect(addCardButton(page)).toHaveCount(0)
  })
})

test.describe("vincular o Google - erros do servidor (POST /api/auth/google/link)", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  const googleButton = (page: Page) => notice(page).getByRole("button", { name: /Continuar com o Google/ })
  const failure = (page: Page) => notice(page).getByRole("alert")

  test("e-mail diferente (403 GOOGLE_EMAIL_MISMATCH): diz qual e-mail usar, não vincula e não troca de conta", async ({ page }) => {
    await login(page, SO_SENHA, "/app/carteira/cartoes")
    await page.evaluate(() => localStorage.setItem("mock:google-other-email", "1"))
    const tokenBefore = await page.evaluate(() => localStorage.getItem("innoelektron_token"))
    await googleButton(page).click()

    await expect(failure(page)).toContainText(`Use a conta Google com o mesmo e-mail desta conta (${SO_SENHA}).`)
    await expect(notice(page)).toHaveAttribute("data-reason", "GOOGLE_LOGIN_REQUIRED")
    await expect(addCardButton(page)).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem("innoelektron_token"))).toBe(tokenBefore)
    await expect(page.getByText("Sofia")).toBeVisible() // continua na MESMA conta
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })

  test("já vinculado (409 GOOGLE_ALREADY_LINKED)", async ({ page }) => {
    await login(page, SO_SENHA, "/app/carteira/cartoes")
    await page.evaluate(() => localStorage.setItem("mock:google-link-error", "GOOGLE_ALREADY_LINKED"))
    await googleButton(page).click()
    await expect(failure(page)).toContainText("já está vinculada a outra conta, ou a sua conta já tem um Google vinculado")
    await expect(addCardButton(page)).toHaveCount(0)
  })

  test("limite de tentativas (429): mensagem de espera e a sessão segue valendo (não desloga)", async ({ page }) => {
    await login(page, SO_SENHA, "/app/carteira/cartoes")
    await page.evaluate(() => localStorage.setItem("mock:google-rate-limited", "1"))
    await googleButton(page).click()
    await expect(failure(page)).toContainText(/tentativas|Aguarde|instantes/i)
    await expect(page).toHaveURL(/\/app\/carteira\/cartoes/)
    await expect(notice(page)).toBeVisible()
  })

  for (const [code, text] of [
    ["INVALID_GOOGLE_TOKEN", "Não foi possível validar a conta Google"],
    ["GOOGLE_EMAIL_NOT_VERIFIED", "ainda não foi verificado"],
    ["GOOGLE_NOT_CONFIGURED", "login com o Google está indisponível"],
    ["GOOGLE_LOGIN_NOT_ALLOWED", "não pode ser vinculada ao Google"],
  ] as const) {
    test(`${code}: mensagem própria, sem deslogar (mesmo o 401 do token inválido)`, async ({ page }) => {
      await login(page, SO_SENHA, "/app/carteira/cartoes")
      await page.evaluate((c) => localStorage.setItem("mock:google-link-error", c), code)
      await googleButton(page).click()
      await expect(failure(page)).toContainText(text)
      await expect(page).toHaveURL(/\/app\/carteira\/cartoes/)
    })
  }

  test("depois de falhar dá para tentar de novo e vincular", async ({ page }) => {
    await login(page, SO_SENHA, "/app/carteira/cartoes")
    await page.evaluate(() => localStorage.setItem("mock:google-other-email", "1"))
    await googleButton(page).click()
    await expect(failure(page)).toBeVisible()
    await page.evaluate(() => localStorage.removeItem("mock:google-other-email"))
    await googleButton(page).click()
    await expect(page.getByText("Pronto! Agora você pode pagar com cartão.")).toBeVisible()
    await expect(addCardButton(page)).toBeVisible()
  })

  test("na página do carregador: vincular libera o seletor de cartão sem sair da tela", async ({ page }) => {
    await login(page, SO_SENHA, CHARGE_POINT_URL)
    await expect(page.getByRole("radiogroup", { name: "Forma de pagamento" })).toHaveCount(0)
    await googleButton(page).click()
    await expect(page.getByText("Pronto! Agora você pode pagar com cartão.")).toBeVisible()
    await expect(notice(page)).toHaveCount(0)
    await expect(page.getByRole("radio", { name: /Visa.*1234/ })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/")))
  })
})
