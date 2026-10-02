import { expect, test, type Page } from "@playwright/test"

/**
 * `PAYMENT_METHOD_DISABLED` com `details[0].reason === "GATEWAY_DISABLED"` (F5.5):
 * o ADMIN desligou o MEIO (cartão ou Pix) na configuração do gateway. Contra o
 * mock MSW (`src/mocks/meData.ts`, `isGatewayDisabledFor`) — NADA provado contra
 * o backend real.
 *
 * Motorista `gateway-off@innoelektron.com` (`user_driver_gateway_off`): nasce
 * com 1 cartão padrão salvo (o seletor aparece) e saldo R$ 50,00 (a carteira
 * continua funcionando). As 4 rotas afetadas respondem 409 com o detalhe novo.
 * Conta separada das demais de propósito: não mexe nos E2E de cartão/Pix.
 *
 * O estado do mock vive na página (um `page.goto` zera) — cada teste faz UM
 * login e o resto é clique na SPA.
 */

/**
 * Dois motivos, UMA experiência (F5.7): `GATEWAY_DISABLED` (o admin desligou o meio) e `SANDBOX_RESTRICTED` (servidor de
 * produção em sandbox, motorista fora da lista de testadores — `gateway-restrito@`, `user_driver_gateway_restrito`).
 * O motorista vê as MESMAS mensagens e nunca descobre que existe restrição por testador.
 */
const DRIVERS = [
  { reason: "GATEWAY_DISABLED", email: "gateway-off@innoelektron.com" },
  { reason: "SANDBOX_RESTRICTED", email: "gateway-restrito@innoelektron.com" },
] as const
/** Vazar o motivo da restrição ajudaria quem procura cobrança grátis com cartão de teste. */
const REVEALS_RESTRICTION = /testador|sandbox|restri[çc]|lista de/i
const PASSWORD = "senha1234"
const CHARGE_POINT_URL = "/c/CP-VILA-NORTE-01/1"

async function loginAsDriver(page: Page, email: string, redirect = "/app") {
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`)
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(new RegExp(redirect.replace(/\//g, "\\/")))
}

for (const driver of DRIVERS)
  for (const viewport of [
    { name: "mobile (390px)", width: 390, height: 844 },
    { name: "desktop (1440px)", width: 1440, height: 900 },
  ]) {
  test.describe(`meio de pagamento indisponível (${driver.reason}) — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("(a) iniciar recarga com cartão: avisa, volta para Carteira, esconde o seletor — e a carteira ainda inicia", async ({ page }) => {
      await loginAsDriver(page, driver.email, CHARGE_POINT_URL)

      // antes: cartão padrão pré-selecionado e a nota de pré-autorização
      await expect(page.getByRole("radio", { name: /Visa.*4242/ })).toBeChecked()
      await expect(page.getByText(/pré-autorização estimada/)).toBeVisible()

      await page.getByRole("button", { name: "Iniciar recarga" }).click()

      const notice = page.getByTestId("card-gateway-disabled")
      await expect(notice).toHaveText("Pagamento com cartão indisponível no momento. Use a carteira.")
      // NÃO é o sentido antigo: nada de "cartão desativado / escolha outro cartão"
      await expect(page.getByText(/foi desativado|Escolha outro cartão/)).toHaveCount(0)
      // seletor some; seleção efetiva é Carteira (sem nota de pré-autorização do cartão)
      await expect(page.getByRole("radiogroup")).toHaveCount(0)
      await expect(page.getByRole("radio")).toHaveCount(0)
      await expect(page.getByText(/pré-autorização estimada/)).toHaveCount(0)
      // o aviso fica (persistente) e o botão continua utilizável
      await expect(page.getByRole("button", { name: "Iniciar recarga" })).toBeEnabled()

      expect(await page.locator("body").innerText()).not.toMatch(REVEALS_RESTRICTION)

      // segunda tentativa vai pela carteira (sem payment CARD) e funciona
      await page.getByRole("button", { name: "Iniciar recarga" }).click()
      await expect(page).toHaveURL(/\/app\/sessao/)
    })

    test("(b) Adicionar cartão em Meus cartões: 'cadastro indisponível', sem abrir a aba isolada", async ({ page, context }) => {
      let popups = 0
      context.on("page", () => popups++)
      await loginAsDriver(page, driver.email)
      await page.goto("/app/carteira") // estado do mock é determinístico (semente), reiniciar não atrapalha
      await page.getByRole("link", { name: /Meus cartões/ }).click()
      await expect(page).toHaveURL(/\/app\/carteira\/cartoes/)

      await page.getByRole("button", { name: "Adicionar cartão" }).click()
      await expect(page.getByTestId("add-card-unavailable")).toHaveText("O cadastro de cartão está indisponível no momento.")
      expect(popups).toBe(0)
      // o botão volta ao normal (não fica girando) e o cartão salvo continua listado
      await expect(page.getByRole("button", { name: "Adicionar cartão" })).toBeEnabled()
      await expect(page.getByText(/4242/)).toBeVisible()
      expect(await page.locator("body").innerText()).not.toMatch(REVEALS_RESTRICTION)
    })

    test("(c) Adicionar saldo por Pix: 'Pix indisponível', sem botão de tentar de novo", async ({ page }) => {
      await loginAsDriver(page, driver.email)
      await page.goto("/app/carteira")
      await page.getByRole("link", { name: /Adicionar saldo/ }).click()
      await expect(page).toHaveURL(/\/app\/carteira\/adicionar/)

      await page.locator("label").filter({ hasText: /R\$\s*50,00/ }).click()
      await page.getByRole("button", { name: "Gerar código Pix" }).click()

      const panel = page.getByTestId("pix-unavailable")
      await expect(panel).toContainText("O Pix está indisponível no momento. Tente mais tarde.")
      // sem laço de tentativa: o formulário e qualquer "tentar/gerar" somem
      await expect(page.getByRole("button", { name: /Gerar código Pix|Tentar novamente|Gerar novo Pix/ })).toHaveCount(0)
      await expect(page.getByText(/Aguardando pagamento/)).toHaveCount(0)
      expect(await page.locator("body").innerText()).not.toMatch(REVEALS_RESTRICTION)

      await panel.getByRole("link", { name: "Voltar à carteira" }).click()
      await expect(page).toHaveURL(/\/app\/carteira$/)
    })
  })
}
