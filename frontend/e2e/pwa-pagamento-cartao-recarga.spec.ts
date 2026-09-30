import { expect, test, type Page } from "@playwright/test"

/**
 * Pagamento com cartão salvo na recarga (F5.4) — seletor na tela de iniciar
 * recarga, pré-autorização, status de captura no recibo e os erros novos.
 * Contra o mock MSW (`src/mocks/meData.ts`) — não existe backend real neste
 * ambiente (mesma limitação de `pwa-fluxo-recarga.spec.ts`).
 *
 * Motorista `cartoes@innoelektron.com` (`user_driver_cartoes`, ver
 * `mocks/data.ts`) nasce com 4 cartões PRÉ-SEMEADOS, um por gatilho de
 * `holderName` (`meData.ts`, `seedCardDemoDriver`): "Motorista Aprovado"
 * (padrão, aprova), "Motorista Recusa" → `CARD_AUTHORIZATION_DENIED`,
 * "Motorista Gateway" → `PAYMENT_GATEWAY_UNAVAILABLE`, "Motorista Parcial" →
 * captura só 60% do total (o resto vira dívida). Cadastrar pela UI (F5.3) e
 * DEPOIS navegar de verdade pra `/c/:id` não funcionaria aqui: `setupWorker`
 * do MSW delega a resolução dos handlers pro JS da PRÓPRIA página (não roda
 * "no servidor" dentro do Service Worker) — qualquer `page.goto`/reload
 * reimporta os módulos do zero e perde o estado em memória (achado
 * construindo este spec). Pré-semear no mock é a única forma determinística
 * de testar o seletor ponta a ponta com uma única navegação, mesmo padrão já
 * usado por `DEBT_DEMO_DRIVER_ID` (F5.1).
 *
 * Conector/tarifa: mesmo `CP-VILA-NORTE-01`/conector 1 de
 * `pwa-fluxo-recarga.spec.ts` (R$1,99/kWh + R$2,00 fixo, mínimo R$5,00) — a
 * sessão é parada poucos segundos depois de iniciada, então o TOTAL cobrado
 * é DETERMINISTICAMENTE R$5,00 (o piso), pelo mesmo motivo documentado lá.
 */

const DRIVER_EMAIL = "cartoes@innoelektron.com"
const DRIVER_PASSWORD = "senha1234"
const CHARGE_POINT_URL = "/c/CP-VILA-NORTE-01/1"
const SITE_NAME = "Shopping Vila Norte"
// estimatedMaxCostCents do mock = max(2000, pricePerKwh*60*100) = 1,99*60*100 = R$119,40
const AUTHORIZED_LABEL = "119,40"

async function loginAsDriver(page: Page) {
  await page.goto(`/login?redirect=${encodeURIComponent(CHARGE_POINT_URL)}`)
  await page.getByLabel("E-mail").fill(DRIVER_EMAIL)
  await page.getByLabel("Senha").fill(DRIVER_PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/")))
}

/** Clica no RÓTULO VISÍVEL do radio, nunca no input `sr-only` — Playwright real, diferente de RTL, falha em cima do input escondido (ver `[[padrao-recarga-pix-f5]]`). */
async function selectPaymentOption(page: Page, text: string | RegExp) {
  await page.getByText(text).first().click()
}

function rowByLabel(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("..")
}

test.describe("pagamento com cartão salvo na recarga", () => {
  test("aprovado: cartão padrão pré-selecionado, pré-autoriza, sessão e recibo mostram a forma de pagamento e a captura resolve para 'Cobrado'", async ({ page }) => {
    await loginAsDriver(page)

    // Cartão padrão (Motorista Aprovado, Visa final 1234) pré-selecionado sozinho.
    const cardRadio = page.getByRole("radio", { name: /Visa.*1234/ })
    await expect(cardRadio).toBeChecked()
    await expect(page.getByText("Padrão")).toBeVisible()
    await expect(page.getByText(/pré-autorização estimada/)).toBeVisible()

    await page.getByRole("button", { name: "Iniciar recarga" }).click()

    // ---- Conectando: mostra o teto pré-autorizado no cartão --------------
    await expect(page).toHaveURL(/\/app\/sessao/)
    await expect(page.getByText(new RegExp(`Pré-autorizamos R\\$\\s*${AUTHORIZED_LABEL}.*Visa`))).toBeVisible()

    // ---- Sessão ativa: badge de pagamento mostra o cartão -----------------
    await expect(page.getByText("kWh")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Visa.*1234/)).toBeVisible()

    await page.getByRole("button", { name: "Parar recarga" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Parar a recarga agora?")).toBeVisible()
    await dialog.getByRole("button", { name: "Parar recarga" }).click()

    // ---- Recibo: status da captura começa "em processamento" -------------
    await expect(page).toHaveURL(/\/app\/sessoes\/.+/, { timeout: 20_000 })
    await expect(page.getByText("Recarga concluída")).toBeVisible()
    await expect(page.getByText(SITE_NAME)).toBeVisible()
    await expect(rowByLabel(page, "Total")).toContainText("5,00")
    await expect(page.getByText("Cobrança em processamento")).toBeVisible()

    // ---- Resolve sozinho (polling de 3s enquanto CAPTURE_PENDING) --------
    await expect(page.getByText("Cobrado", { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(rowByLabel(page, "Valor cobrado")).toContainText("5,00")
    // Captura integral — sem dívida residual.
    await expect(page.getByText(/ficaram em aberto/)).toHaveCount(0)
  })

  test("cartão recusado: mensagem clara, continua na landing, dá pra trocar pra carteira e tentar de novo", async ({ page }) => {
    await loginAsDriver(page)
    await selectPaymentOption(page, /Master.*4444/)
    await page.getByRole("button", { name: "Iniciar recarga" }).click()

    await expect(page.getByText("Seu cartão foi recusado. Tente outro cartão ou use a carteira.")).toBeVisible()
    await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/")))

    await selectPaymentOption(page, "Carteira")
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)
    await expect(page.getByText("Conectando ao carregador…")).toBeVisible()
  })

  test("gateway indisponível: mensagem clara, continua na landing", async ({ page }) => {
    await loginAsDriver(page)
    await selectPaymentOption(page, /Elo.*6516/)
    await page.getByRole("button", { name: "Iniciar recarga" }).click()

    await expect(page.getByText("Não foi possível processar o pagamento agora. Tente novamente ou use a carteira.")).toBeVisible()
    await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/")))
  })

  test("captura parcial: recibo mostra 'Cobrado' com valor menor que o total e avisa a dívida residual", async ({ page }) => {
    await loginAsDriver(page)
    await selectPaymentOption(page, /Amex.*0005/)
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)

    await expect(page.getByText("kWh")).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Parar recarga" }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Parar recarga" }).click()

    await expect(page).toHaveURL(/\/app\/sessoes\/.+/, { timeout: 20_000 })
    await expect(rowByLabel(page, "Total")).toContainText("5,00")

    await expect(page.getByText("Cobrado", { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(rowByLabel(page, "Valor cobrado")).toContainText("3,00") // 60% de R$5,00
    await expect(page.getByText(/R\$\s*2,00.*ficaram em aberto/)).toBeVisible() // os R$2,00 restantes
  })

  test("0 cartões: seletor não aparece, fluxo idêntico ao de sempre (Carteira)", async ({ page }) => {
    await page.goto(`/login?redirect=${encodeURIComponent(CHARGE_POINT_URL)}`)
    await page.getByLabel("E-mail").fill("motorista@innoelektron.com")
    await page.getByLabel("Senha").fill(DRIVER_PASSWORD)
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page).toHaveURL(new RegExp(CHARGE_POINT_URL.replace(/\//g, "\\/")))

    await expect(page.getByText("Forma de pagamento")).toHaveCount(0)
    await expect(page.getByRole("radio")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Iniciar recarga" })).toBeEnabled()
  })
})
