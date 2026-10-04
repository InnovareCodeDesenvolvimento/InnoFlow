import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → Gateway de pagamento → "Testar conexão" (C2.1), contra os mocks MSW (`paymentGatewayData.ts#testGatewayConnection`), que repetem o contrato e as
 * mensagens de `POST /api/admin/payment-gateway/test-connection`. NADA aqui foi provado contra a Cielo: o que se prova é como a tela trata CADA status
 * que o servidor pode devolver. Credencial errada vem 200 com o status por passo (não é erro de tela); só 429/503/403 viram o aviso vermelho do botão.
 * Cenários por conta: `gateway-pronto@` (tudo OK), `admin@` (nada configurado), `gateway-falhas@` (credenciais recusadas); o override
 * `localStorage["mock:gateway-test"]` faz o passo da credencial devolver o status pedido.
 */

test.use({ viewport: { width: 1440, height: 900 } })

const NAV = "Navegação do painel administrativo"

async function openGateway(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill("senha1234")
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Gateway de pagamento" }).click()
  await expect(page.getByRole("heading", { name: "Gateway de pagamento", level: 1 })).toBeVisible()
}

const section = (page: Page) => page.getByTestId("section-connection-test")
const stepOf = (page: Page, step: "MERCHANT_CREDENTIALS" | "SOP_OAUTH" | "SOP_ACCESS_TOKEN") => page.getByTestId(`test-step-${step}`)
const runTest = async (page: Page, name: RegExp = /Testar conexão|Testar de novo/) => {
  await section(page).getByRole("button", { name }).click()
  await expect(page.getByTestId("test-result").or(page.getByTestId("test-request-error"))).toBeVisible()
}
const setScenario = (page: Page, value: string) => page.evaluate((v) => localStorage.setItem("mock:gateway-test", v), value)

test.describe("tudo certo", () => {
  test("três passos OK, ambiente e horário no resumo, host de cada passo e nenhuma credencial exibida", async ({ page }) => {
    await openGateway(page, "gateway-pronto@innoelektron.com")
    await expect(page.getByTestId("test-result")).toHaveCount(0) // nada roda sozinho

    await runTest(page)
    await expect(page.getByTestId("test-verdict")).toContainText("Conexão funcionando")
    await expect(page.getByTestId("test-result")).toHaveAttribute("data-verdict", "ok")
    await expect(section(page)).toContainText("Ambiente: Sandbox")
    for (const step of ["MERCHANT_CREDENTIALS", "SOP_OAUTH", "SOP_ACCESS_TOKEN"] as const) {
      await expect(stepOf(page, step)).toHaveAttribute("data-status", "OK")
      await expect(stepOf(page, step).getByTestId("test-step-support")).toHaveCount(0)
    }
    await expect(stepOf(page, "MERCHANT_CREDENTIALS")).toContainText("apiquerysandbox.cieloecommerce.cielo.com.br")
    await expect(stepOf(page, "SOP_ACCESS_TOKEN")).toContainText("o cadastro de cartão deve funcionar")
    // Os 3 itens, sempre na ordem do contrato.
    await expect(section(page).getByRole("list", { name: "Resultado por passo" }).getByRole("listitem")).toHaveCount(3)
    await expect(section(page).getByRole("button", { name: "Testar de novo" })).toBeVisible()
  })

  test("avisa que o teste usa o SALVO quando há alteração não salva", async ({ page }) => {
    await openGateway(page, "gateway-pronto@innoelektron.com")
    await expect(page.getByTestId("test-unsaved-note")).toHaveCount(0)
    await page.getByLabel("MerchantId").fill("mid-novo-ainda-nao-salvo")
    await expect(page.getByTestId("test-unsaved-note")).toContainText("usa o que está SALVO")
  })
})

test.describe("nada configurado e cada tipo de falha", () => {
  test("sem credencial salva: 'não há credencial para testar', nenhum passo vermelho", async ({ page }) => {
    await openGateway(page, "admin@innoelektron.com")
    await runTest(page)
    await expect(page.getByTestId("test-result")).toHaveAttribute("data-verdict", "nothing-configured")
    await expect(page.getByTestId("test-verdict")).toContainText("Não há credencial salva")
    for (const step of ["MERCHANT_CREDENTIALS", "SOP_OAUTH", "SOP_ACCESS_TOKEN"] as const) {
      await expect(stepOf(page, step)).toHaveAttribute("data-status", "NOT_CONFIGURED")
    }
    await expect(stepOf(page, "MERCHANT_CREDENTIALS")).toContainText("Preencha e salve a credencial")
  })

  test("credencial recusada: lembra que sandbox e produção são servidores separados; o passo dependente fica 'não testado'", async ({ page }) => {
    await openGateway(page, "gateway-falhas@innoelektron.com")
    await runTest(page)
    await expect(page.getByTestId("test-result")).toHaveAttribute("data-verdict", "failed")
    await expect(stepOf(page, "MERCHANT_CREDENTIALS")).toHaveAttribute("data-status", "CREDENTIAL_REJECTED")
    await expect(stepOf(page, "MERCHANT_CREDENTIALS").getByTestId("test-step-support")).toContainText("sandbox e produção são servidores separados")
    await expect(stepOf(page, "MERCHANT_CREDENTIALS").getByTestId("test-step-support")).toContainText("O ambiente salvo aqui é sandbox")
    await expect(stepOf(page, "SOP_OAUTH")).toHaveAttribute("data-status", "CREDENTIAL_REJECTED")
    await expect(stepOf(page, "SOP_ACCESS_TOKEN")).toHaveAttribute("data-status", "SKIPPED")
    await expect(stepOf(page, "SOP_ACCESS_TOKEN")).toContainText("Não testado")
  })

  test("IP fora da lista: texto de apoio manda conferir os IPs confiáveis ANTES de trocar a credencial", async ({ page }) => {
    await openGateway(page, "gateway-pronto@innoelektron.com")
    await setScenario(page, "IP_NOT_ALLOWED")
    await runTest(page)
    const merchant = stepOf(page, "MERCHANT_CREDENTIALS")
    await expect(merchant).toHaveAttribute("data-status", "IP_NOT_ALLOWED")
    await expect(merchant.getByTestId("test-step-support")).toContainText("a Cielo recusou o IP do servidor: confira a lista de IPs confiáveis do Site Cielo antes de trocar a credencial", { ignoreCase: true })
    await expect(merchant).toContainText("HTTP 403")
    // O cadastro de cartão é outro ramo e segue OK: o resultado é por passo, não "tudo ou nada".
    await expect(stepOf(page, "SOP_OAUTH")).toHaveAttribute("data-status", "OK")
  })

  for (const [status, label, support] of [
    ["UNAVAILABLE", "Indisponível", "instabilidade momentânea"],
    ["REQUEST_REFUSED", "Requisição recusada", "motivo que não parece credencial"],
    ["MISCONFIGURED", "Configuração incoerente", "Corrija o que a mensagem aponta"],
    ["RATE_LIMITED", "Muitas chamadas", "Aguarde um instante"],
  ] as const) {
    test(`status ${status}: rótulo, mensagem do servidor e orientação`, async ({ page }) => {
      await openGateway(page, "gateway-pronto@innoelektron.com")
      await setScenario(page, status)
      await runTest(page)
      const merchant = stepOf(page, "MERCHANT_CREDENTIALS")
      await expect(merchant).toHaveAttribute("data-status", status)
      await expect(merchant.getByTestId("test-step-status")).toHaveText(label)
      await expect(merchant.getByTestId("test-step-message")).not.toBeEmpty()
      await expect(merchant.getByTestId("test-step-support")).toContainText(support)
      await expect(page.getByTestId("test-result")).toHaveAttribute("data-verdict", "failed")
    })
  }

  test("falha só no cadastro de cartão: a autenticação recusada deixa o token 'não testado' e a credencial da Cielo segue OK", async ({ page }) => {
    await openGateway(page, "gateway-pronto@innoelektron.com")
    await setScenario(page, "OAUTH_CREDENTIAL_REJECTED")
    await runTest(page)
    await expect(stepOf(page, "MERCHANT_CREDENTIALS")).toHaveAttribute("data-status", "OK")
    await expect(stepOf(page, "SOP_OAUTH")).toHaveAttribute("data-status", "CREDENTIAL_REJECTED")
    await expect(stepOf(page, "SOP_OAUTH")).toContainText("invalid_client")
    await expect(stepOf(page, "SOP_ACCESS_TOKEN")).toHaveAttribute("data-status", "SKIPPED")
  })
})

test.describe("erros do próprio botão (HTTP)", () => {
  test("503: aviso vermelho em português e dá para tentar de novo", async ({ page }) => {
    await openGateway(page, "gateway-pronto@innoelektron.com")
    await setScenario(page, "HTTP_503")
    await runTest(page)
    await expect(page.getByTestId("test-request-error")).toContainText("Não foi possível ler a configuração do gateway agora")
    await expect(page.getByTestId("test-result")).toHaveCount(0)

    await page.evaluate(() => localStorage.removeItem("mock:gateway-test"))
    await runTest(page)
    await expect(page.getByTestId("test-request-error")).toHaveCount(0)
    await expect(page.getByTestId("test-result")).toHaveAttribute("data-verdict", "ok")
  })

  test("429 a partir da 7ª chamada no minuto: mensagem do limite (6/min), sem esconder o último resultado válido da tela anterior", async ({ page }) => {
    await openGateway(page, "gateway-pronto@innoelektron.com")
    for (let i = 0; i < 6; i++) await runTest(page)
    await expect(page.getByTestId("test-result")).toHaveAttribute("data-verdict", "ok")

    await section(page).getByRole("button", { name: "Testar de novo" }).click()
    await expect(page.getByTestId("test-request-error")).toContainText("limite de 6 por minuto")
  })
})

test.describe("acessibilidade e responsivo", () => {
  test("botão acessível por teclado, resultado em região aria-live e sem rolagem horizontal em 375px", async ({ page }) => {
    await openGateway(page, "gateway-falhas@innoelektron.com") // navega no desktop (o menu lateral só existe >= lg) e só depois estreita a janela
    await page.setViewportSize({ width: 375, height: 812 })
    const button = section(page).getByRole("button", { name: "Testar conexão" })
    await button.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("test-result")).toBeVisible()
    await expect(section(page).locator("[aria-live=polite]")).toContainText("Credencial da Cielo")
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth, card: (document.querySelector('[data-testid="section-connection-test"]') as HTMLElement).scrollWidth - (document.querySelector('[data-testid="section-connection-test"]') as HTMLElement).clientWidth }))
    expect(overflow).toEqual({ page: 0, card: 0 })
  })
})
