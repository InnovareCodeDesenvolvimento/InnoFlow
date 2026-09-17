import { expect, test, type Page } from "@playwright/test"

/**
 * Fluxo ponta a ponta do PWA do motorista, contra os mocks MSW
 * (`src/mocks/meData.ts` + `handlers.ts`) — não existe backend real neste
 * ambiente de CI (ver `.claude/agent-memory/iris/project_innoelektron_e2e_gap.md`).
 *
 * Conector escolhido: `CP-VILA-NORTE-01` / conector 1 (`conn_1`, AVAILABLE,
 * tarifa `tariff_1`: R$1,99/kWh + R$2,00 de taxa fixa + mínimo de R$5,00 por
 * sessão). A sessão é parada poucos segundos depois de iniciada — nesse
 * intervalo curto o custo de energia é de poucos centavos, sempre abaixo do
 * mínimo da sessão, então o TOTAL cobrado é DETERMINISTICAMENTE R$5,00 (o
 * piso), não importa quantos segundos exatos o teste levou para clicar em
 * "Parar recarga". É isso que permite asserções de valor exato aqui sem
 * cronometrar nada (só flakaria se o teste demorasse >10min para clicar).
 */

const DRIVER_EMAIL = "motorista@innoelektron.com"
const DRIVER_PASSWORD = "senha1234"
const CHARGE_POINT_URL = "/c/CP-VILA-NORTE-01/1"
const SITE_NAME = "Shopping Vila Norte"

async function loginAsDriver(page: Page) {
  await page.goto(`/login?redirect=${encodeURIComponent(CHARGE_POINT_URL)}`)
  await page.getByLabel("E-mail").fill(DRIVER_EMAIL)
  await page.getByLabel("Senha").fill(DRIVER_PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/")))
}

function bottomNav(page: Page) {
  return page.getByRole("navigation", { name: "Navegação do aplicativo" })
}

/**
 * Localiza a linha "rótulo · valor" (mesmo padrão markup do recibo/
 * carteira/landing: rótulo e valor em elementos irmãos dentro de um
 * container comum) a partir do texto EXATO do rótulo — assim a asserção do
 * valor não depende de qual outro "R$ ..." aparece em outro ponto da tela.
 */
function rowByLabel(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("..")
}

for (const viewport of [
  { name: "mobile (390px)", width: 390, height: 844 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`fluxo completo de recarga — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("login, inicia recarga, acompanha, para, confere recibo/carteira/histórico", async ({ page }) => {
      await loginAsDriver(page)

      // ---- Landing do charge point: saldo inicial visível ----------------
      await expect(rowByLabel(page, "Seu saldo")).toContainText("50,00")

      const startButton = page.getByRole("button", { name: "Iniciar recarga" })
      await expect(startButton).toBeEnabled()
      await startButton.click()

      // ---- /app/sessao: "conectando" enquanto o comando não é aceito -----
      await expect(page).toHaveURL(/\/app\/sessao/)
      await expect(page.getByText("Conectando ao carregador…")).toBeVisible()

      // ---- Sessão promovida a ativa (mock demora ~4s) — energia aparece --
      await expect(page.getByText("kWh")).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText(SITE_NAME)).toBeVisible()
      const stopButton = page.getByRole("button", { name: "Parar recarga" })
      await expect(stopButton).toBeVisible()

      // ---- Para a recarga, confirma no modal -----------------------------
      await stopButton.click()
      const dialog = page.getByRole("dialog")
      await expect(dialog.getByText("Parar a recarga agora?")).toBeVisible()
      await dialog.getByRole("button", { name: "Parar recarga" }).click()

      // ---- Recibo: navega sozinho quando a sessão finaliza no mock -------
      await expect(page).toHaveURL(/\/app\/sessoes\/.+/, { timeout: 20_000 })
      await expect(page.getByText("Recarga concluída")).toBeVisible()
      await expect(page.getByText(SITE_NAME)).toBeVisible()

      // Total cobrado = piso da tarifa (R$5,00) — ver comentário no topo.
      await expect(rowByLabel(page, "Total")).toContainText("5,00")
      // Cobrança mínima aplicada — prova que a regra de piso disparou de verdade.
      await expect(page.getByText("Ajuste de cobrança mínima")).toBeVisible()
      // Novo saldo debitado: 50,00 - 5,00 = 45,00.
      await expect(rowByLabel(page, "Novo saldo da carteira")).toContainText("45,00")

      // ---- Carteira: saldo novo + lançamento do débito no extrato --------
      await bottomNav(page).getByRole("link", { name: "Carteira" }).click()
      await expect(page).toHaveURL(/\/app\/carteira/)
      await expect(rowByLabel(page, "Saldo disponível")).toContainText("45,00")
      await expect(page.getByText(`Recarga em ${SITE_NAME}`)).toBeVisible()
      await expect(page.getByText(/-\s*R\$\s*5,00/)).toBeVisible()

      // ---- Histórico: a sessão recém-parada aparece na lista -------------
      await bottomNav(page).getByRole("link", { name: "Histórico" }).click()
      await expect(page).toHaveURL(/\/app\/sessoes$/)
      await expect(page.getByText("Histórico de recargas")).toBeVisible()
      const historyRow = page.getByRole("link").filter({ hasText: SITE_NAME }).first()
      await expect(historyRow).toBeVisible()
      await expect(historyRow.getByText("Encerrada")).toBeVisible()
      await expect(historyRow).toContainText("5,00")
    })
  })
}
