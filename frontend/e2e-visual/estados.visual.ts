import { expect, test, type Page } from "@playwright/test"
import path from "node:path"
import { PASTA_AUTH, PERSONAS, T0 } from "./constantes"
import { aguardarEstavel, fotografar, prepararPagina } from "./estabilizar"

/**
 * Estados que não são "abrir uma URL": sessão ao vivo, recibo de recarga concluída, diálogos do admin e o formulário do cartão.
 *
 * RELÓGIO: o mock calcula a energia da sessão por `Date.now() - startedAt` (7 kW constantes). Com o relógio fixo em T0 e SALTOS
 * explícitos (`setFixedTime`), a energia, o custo e a duração mostrados são exatos e repetíveis — nada de "esperei 5 segundos".
 * Os timers (polling, SSE) continuam reais, então a tela reflete cada salto no próximo ciclo de polling.
 * ESTADO: o mock mora na PÁGINA e zera a cada `goto` — por isso o fluxo inteiro (iniciar → ao vivo → parar → recibo) é UMA página só.
 */
const SALTO_AO_VIVO_MS = 125_000 // 2 min 05 s de recarga => 243 Wh => 0,24 kWh
const SALTO_FIM_MS = 10_000 // depois do Stop, > 4 s para o mock fechar a sessão

async function foto(page: Page, nome: string, opts: { crescerAteODocumento?: boolean; spinnerEhConteudo?: boolean } = {}) {
  await aguardarEstavel(page, { spinnerEhConteudo: opts.spinnerEhConteudo })
  expect(await fotografar(page, opts)).toMatchSnapshot(`${nome}.jpg`)
}

test.describe("fluxo de recarga (uma página só) — conectando, ao vivo, parar, recibo", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.driver.arquivo}.json`) })

  test("pwa-sessao-conectando, pwa-sessao-ao-vivo, pwa-sessao-parar-dialogo e pwa-recibo-concluida", async ({ page }) => {
    await prepararPagina(page)
    await page.goto("/c/CP-VILA-NORTE-01/1", { waitUntil: "load" })
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)

    // 1) Conectando (t = 0: o mock só promove a sessão 4 s depois, e o relógio está parado).
    await expect(page.getByText("Conectando ao carregador…")).toBeVisible()
    await foto(page, "pwa-sessao-conectando", { crescerAteODocumento: true, spinnerEhConteudo: true })

    // 2) Ao vivo: salta o relógio para 2 min 05 s depois do início.
    await page.clock.setFixedTime(new Date(T0.getTime() + SALTO_AO_VIVO_MS))
    await expect(page.getByText("Parar recarga").first()).toBeVisible({ timeout: 30_000 })
    // Prova de que a tela ESTÁ no instante certo (e não em um polling antigo): a energia exata do salto.
    await expect(page.getByText(/0,24/).first()).toBeVisible({ timeout: 30_000 })
    await foto(page, "pwa-sessao-ao-vivo", { crescerAteODocumento: true })

    // 3) Diálogo de confirmação de parada.
    await page.getByRole("button", { name: "Parar recarga" }).first().click()
    await expect(page.getByRole("dialog").getByText("Parar a recarga agora?")).toBeVisible()
    await foto(page, "pwa-sessao-parar-dialogo")

    // 4) Confirma e fecha a sessão: salta mais 10 s (o mock finaliza > 4 s depois do Stop) e o app navega sozinho para o recibo.
    await page.getByRole("dialog").getByRole("button", { name: "Parar recarga" }).click()
    await page.clock.setFixedTime(new Date(T0.getTime() + SALTO_AO_VIVO_MS + SALTO_FIM_MS))
    await expect(page).toHaveURL(/\/app\/sessoes\/.+/, { timeout: 30_000 })
    await expect(page.getByText("Recarga concluída")).toBeVisible()
    await foto(page, "pwa-recibo-concluida", { crescerAteODocumento: true })
  })
})

test.describe("diálogos do admin", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.admin.arquivo}.json`) })

  test("adm-dialogo-novo-site (formulário em Dialog)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto("/admin/sites", { waitUntil: "load" })
    await aguardarEstavel(page)
    await page.getByRole("button", { name: "Novo site" }).first().click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await foto(page, "adm-dialogo-novo-site")
  })

  test("adm-dialogo-detalhe-sessao (Dialog de leitura sobre tabela)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto("/admin/sessoes", { waitUntil: "load" })
    await aguardarEstavel(page)
    await page.locator("tbody tr").first().click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await foto(page, "adm-dialogo-detalhe-sessao")
  })
})

test.describe("documento isolado do cartão", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.driver.arquivo}.json`) })

  test("pub-cartao-isolado-formulario (aberto pelo app, handshake completo)", async ({ page, context }) => {
    await prepararPagina(page)
    await page.goto("/app/carteira/cartoes", { waitUntil: "load" })
    await aguardarEstavel(page)
    const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).first().click()])
    await popup.waitForLoadState("load")
    await expect(popup.getByRole("heading", { name: "Cadastrar cartão" })).toBeVisible()
    await foto(popup, "pub-cartao-isolado-formulario")
  })
})
