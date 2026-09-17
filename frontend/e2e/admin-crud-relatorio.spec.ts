import { expect, test, type Page } from "@playwright/test"

/**
 * CRUD de Sites + relatório de Faturamento no painel admin, contra os mocks
 * MSW (`src/mocks/handlers.ts` + `reportsAggregate.ts`) — não existe backend
 * real neste ambiente de CI (ver
 * `.claude/agent-memory/iris/project_innoelektron_e2e_gap.md`).
 */

const ADMIN_EMAIL = "admin@innoelektron.com"
const ADMIN_PASSWORD = "senha1234"
// Mesmo valor de `OPERATOR_A_ID` em `src/mocks/data.ts` — o schema do
// formulário (`schemas/site.schema.ts`) não valida formato cuid (achado
// desta rodada, ver handoff), então qualquer texto não vazio seria aceito;
// usamos o id real só para o dado ficar coerente com o resto do mock.
const OPERATOR_A_ID = "operator_a_cuid000000000001"

test.use({ viewport: { width: 1440, height: 900 } })

async function loginAsAdmin(page: Page) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(ADMIN_EMAIL)
  await page.getByLabel("Senha").fill(ADMIN_PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

/** `from`/`to` YYYY-MM-DD no fuso local — mesma conta de `lib/period.ts`, reimplementada aqui de propósito (queremos provar o CONTRATO da URL contra um cálculo independente, não importar a implementação que estamos testando). */
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Linha da tabela que contém uma célula com este texto EXATO — não usa o nome acessível da `<tr>` (que concatena todas as células e os `aria-label` dos botões de ação, e por isso não dá pra casar com igualdade exata). */
function rowWithCell(page: Page, cellText: string) {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name: cellText, exact: true }) })
}

test.describe("Admin — CRUD de Sites", () => {
  test("cria, edita e desativa um site, refletindo na listagem", async ({ page }) => {
    await loginAsAdmin(page)
    await page.getByRole("link", { name: "Sites" }).click()
    await expect(page).toHaveURL(/\/admin\/sites/)

    const createdName = `Site E2E QA ${Date.now()}`
    const editedName = `${createdName} (editado)`

    // ---- Criar -----------------------------------------------------------
    await page.getByRole("button", { name: "Novo site" }).click()
    const createDialog = page.getByRole("dialog")
    await expect(createDialog.getByText("Novo site")).toBeVisible()

    await createDialog.getByLabel("ID do operador").fill(OPERATOR_A_ID)
    await createDialog.getByLabel("Nome").fill(createdName)
    await createDialog.getByLabel("Endereço").fill("Rua de Teste, 100")
    await createDialog.getByLabel("Cidade").fill("São Paulo")
    await createDialog.getByLabel("UF").fill("SP")
    await createDialog.getByLabel("CEP").fill("01000-000")
    await createDialog.getByLabel("Latitude").fill("-23.55")
    await createDialog.getByLabel("Longitude").fill("-46.63")
    await createDialog.getByRole("button", { name: "Criar site" }).click()

    await expect(page.getByText("Site criado.")).toBeVisible()
    await expect(createDialog).not.toBeVisible()

    let row = rowWithCell(page, createdName)
    await expect(row).toBeVisible()
    await expect(row.getByText("Ativo", { exact: true })).toBeVisible()

    // ---- Editar ------------------------------------------------------------
    await row.getByRole("button", { name: `Editar ${createdName}` }).click()
    const editDialog = page.getByRole("dialog")
    await expect(editDialog.getByText("Editar site")).toBeVisible()
    await editDialog.getByLabel("Nome").fill(editedName)
    await editDialog.getByRole("button", { name: "Salvar alterações" }).click()

    await expect(page.getByText("Site atualizado.")).toBeVisible()
    // O nome antigo (exato) não existe mais como célula — só o editado.
    await expect(page.getByRole("cell", { name: createdName, exact: true })).toHaveCount(0)
    row = rowWithCell(page, editedName)
    await expect(row).toBeVisible()

    // ---- Desativar ---------------------------------------------------------
    // O backend faz soft-delete (`active = false`) — o site NÃO some da
    // listagem (regra explícita do próprio `ConfirmDialog`: "não some do
    // histórico, mas deixa de aparecer para o motorista"). A asserção certa
    // é o badge virar "Inativo", não o desaparecimento da linha — testar
    // "sumiu da lista" aqui reprovaria um comportamento correto.
    await row.getByRole("button", { name: `Desativar ${editedName}` }).click()
    const confirmDialog = page.getByRole("dialog")
    await expect(confirmDialog.getByText(`Desativar "${editedName}"?`)).toBeVisible()
    await confirmDialog.getByRole("button", { name: "Desativar" }).click()

    await expect(page.getByText("Site desativado.")).toBeVisible()
    row = rowWithCell(page, editedName)
    await expect(row.getByText("Inativo", { exact: true })).toBeVisible()
    await expect(row.getByText("Ativo", { exact: true })).toHaveCount(0)
  })
})

test.describe("Admin — Relatório de Faturamento", () => {
  test("carrega dados do período e recarrega ao trocar o preset", async ({ page }) => {
    await loginAsAdmin(page)

    const initialResponsePromise = page.waitForResponse((resp) => resp.url().includes("/api/admin/reports/revenue"))
    await page.getByRole("link", { name: "Faturamento" }).click()
    await expect(page).toHaveURL(/\/admin\/faturamento/)

    const initialResponse = await initialResponsePromise
    const initialUrl = new URL(initialResponse.url())
    const initialBody = await initialResponse.json()

    // Preset default da tela é "Últimos 30 dias" (ver `FaturamentoPage`).
    expect(initialUrl.searchParams.get("from")).toBe(isoDaysAgo(29))
    expect(initialUrl.searchParams.get("to")).toBe(isoDaysAgo(0))
    await expect(page.getByRole("button", { name: "Últimos 30 dias" })).toHaveAttribute("aria-pressed", "true")

    // Dado sintético (`reportsData.ts`) gera sessões diárias nos últimos 45
    // dias em 5 sites de 2 operadores — 30 dias de histórico tem faturamento
    // garantidamente maior que zero.
    expect(initialBody.totals.revenueCents).toBeGreaterThan(0)
    const totalLocator = page.getByText(/Faturamento total:/)
    await expect(totalLocator).toBeVisible()
    const totalBefore = await totalLocator.textContent()

    // ---- Troca de preset: "Últimos 7 dias" ---------------------------------
    const sevenDayResponsePromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/admin/reports/revenue") && new URL(resp.url()).searchParams.get("from") === isoDaysAgo(6),
    )
    await page.getByRole("button", { name: "Últimos 7 dias" }).click()
    const sevenDayResponse = await sevenDayResponsePromise
    const sevenDayBody = await sevenDayResponse.json()

    // A query mudou de verdade (não é o mesmo período redesenhado) — prova
    // que trocar o preset realmente refaz a chamada com o novo filtro.
    expect(new URL(sevenDayResponse.url()).searchParams.get("from")).not.toBe(initialUrl.searchParams.get("from"))
    await expect(page.getByRole("button", { name: "Últimos 7 dias" })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByRole("button", { name: "Últimos 30 dias" })).toHaveAttribute("aria-pressed", "false")

    // 7 dias é subconjunto de 30 dias — faturamento não pode ser maior, e com
    // o volume de sessões geradas por dia (2 a 15 por site), praticamente
    // certo que seja estritamente menor (mesma semente determinística).
    expect(sevenDayBody.totals.revenueCents).toBeLessThanOrEqual(initialBody.totals.revenueCents)
    expect(sevenDayBody.totals.revenueCents).toBeGreaterThan(0)

    // O total exibido em tela também mudou (não ficou com o dado antigo em cache).
    await expect(totalLocator).not.toHaveText(totalBefore ?? "")
  })
})
