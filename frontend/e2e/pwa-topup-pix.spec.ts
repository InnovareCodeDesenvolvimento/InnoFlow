import { expect, test, type Page } from "@playwright/test"

/**
 * Recarga de saldo via Pix (F5.1) — `/app/carteira/adicionar`, contra o mock
 * MSW (`src/mocks/meData.ts`): a rota real (`POST/GET
 * /api/me/wallet/topups`) ainda NÃO existe no backend (ver
 * `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md`). O mock
 * "paga sozinho" 8s depois de criado — dá tempo de provar o estado
 * PENDING (QR/copia-e-cola/contador) antes de resolver para PAID.
 */

const DRIVER_EMAIL = "motorista@innoelektron.com"
const DEBT_DRIVER_EMAIL = "devedor@innoelektron.com"
const PASSWORD = "senha1234"

async function loginAsDriver(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/app/)
}

function rowByLabel(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("..")
}

/**
 * O `<input type="radio">` do chip é `sr-only` (o `<label>` visível o cobre
 * inteiro) — `.check()` falha por "elemento intercepta o clique", igual um
 * dedo de verdade nunca tocaria o input escondido. Clica no `<span>` visível
 * (o mesmo que o motorista toca), que aciona o radio por comportamento
 * nativo de `<label>`.
 */
function clickAmountChip(page: Page, amountRegex: RegExp) {
  return page.getByText(amountRegex).click()
}

for (const viewport of [
  { name: "mobile (390px)", width: 390, height: 844 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`recarga Pix sem dívida — ${viewport.name}`, () => {
    // `clipboard-write` sem permissão explícita faz `navigator.clipboard.writeText`
    // rejeitar no Chromium headless — sem isso o botão "Copiar código" nunca vira "Copiado".
    test.use({ viewport: { width: viewport.width, height: viewport.height }, permissions: ["clipboard-read", "clipboard-write"] })

    test("escolhe valor, gera QR, aguarda pagar e confere carteira", async ({ page }) => {
      await loginAsDriver(page, DRIVER_EMAIL)

      await page.goto("/app/carteira")
      await page.getByRole("link", { name: /Adicionar saldo/ }).click()
      await expect(page).toHaveURL(/\/app\/carteira\/adicionar/)
      await expect(page.getByRole("heading", { name: "Adicionar saldo" })).toBeVisible()

      // Sem dívida: nenhum aviso de quitação aparece.
      await expect(page.getByText(/quitam a dívida/)).toHaveCount(0)

      // Chip R$ 50,00 + gerar Pix.
      await clickAmountChip(page, /R\$\s*50,00/)
      await page.getByRole("button", { name: "Gerar código Pix" }).click()

      // ---- Pendente: QR, copia-e-cola, contador ---------------------------
      await expect(page.getByText("Aguardando pagamento")).toBeVisible()
      await expect(page.getByRole("img", { name: /QR code Pix/ })).toBeVisible()
      await expect(page.getByText(/Expira em/)).toBeVisible()

      await page.getByRole("button", { name: /Copiar código/ }).click()
      await expect(page.getByRole("button", { name: "Copiado" })).toBeVisible()

      // ---- Paga sozinho (mock resolve ~8s depois de criado) ---------------
      await expect(page.getByText("Saldo adicionado!")).toBeVisible({ timeout: 15_000 })
      await expect(rowByLabel(page, "Saldo livre creditado")).toContainText("50,00")
      await expect(page.getByText("Quitou dívida em aberto")).toHaveCount(0)
      await expect(rowByLabel(page, "Novo saldo disponível")).toContainText("100,00") // 50,00 inicial + 50,00 do Pix

      await page.getByRole("link", { name: "Ver carteira" }).click()
      await expect(page).toHaveURL(/\/app\/carteira$/)
      await expect(rowByLabel(page, "Saldo disponível")).toContainText("100,00")
      await expect(page.getByText("Recarga Pix")).toBeVisible()
    })
  })
}

test.describe("recarga Pix com dívida em aberto", () => {
  test("aviso de quitação aparece e o valor final reflete a dívida quitada", async ({ page }) => {
    await loginAsDriver(page, DEBT_DRIVER_EMAIL)

    await page.goto("/app/carteira")
    await expect(page.getByText(/Dívida em aberto/)).toContainText("38,50")

    await page.getByRole("link", { name: /Adicionar saldo/ }).click()
    await clickAmountChip(page, /R\$\s*20,00/)

    // Valor (R$ 20,00) MENOR que a dívida (R$ 38,50): tudo vira quitação, aviso mostra o valor total.
    await expect(page.getByText(/Os primeiros R\$\s*20,00 do seu crédito quitam a dívida/)).toBeVisible()
    await expect(page.getByText(/Saldo livre depois do pagamento: R\$\s*0,00/)).toBeVisible()

    await page.getByRole("button", { name: "Gerar código Pix" }).click()
    await expect(page.getByText("Saldo adicionado!")).toBeVisible({ timeout: 15_000 })
    await expect(rowByLabel(page, "Quitou dívida em aberto")).toContainText("20,00")
    await expect(rowByLabel(page, "Saldo livre creditado")).toContainText("0,00")
    await expect(rowByLabel(page, "Novo saldo disponível")).toContainText("0,00") // não sobrou saldo livre

    await page.getByRole("link", { name: "Ver carteira" }).click()
    await expect(page.getByText(/Dívida em aberto/)).toContainText("18,50") // 38,50 - 20,00
  })
})
