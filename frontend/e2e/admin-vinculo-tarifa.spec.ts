import { expect, test, type Page } from "@playwright/test"

/**
 * Vínculo de tarifa no admin (`/api/admin/tariff-assignments`), contra os mocks MSW — que espelham o contrato real
 * (`backend/src/api/routes/tariffAssignments.routes.ts`): 400 com `details` para escopo/alvo errado, 404 para alvo de outro operador,
 * DELETE = soft (`validTo = agora`, o vínculo vai para "encerrados").
 *
 * Mundo semeado (`src/mocks/data.ts`, operador A): cp_1 CP-VILA-NORTE-01 (tarifa do LOCAL + tomada #2 com tarifa própria), cp_3 CP-BARRA-FUNDA-01
 * (tarifa do CARREGADOR), cp_4 CP-OUTLET-CAMPINAS-01 e cp_5 CP-ANHANGUERA-01 SEM tarifa. Operador B (Posto Estrada Real) não tem vínculo nenhum.
 * O estado do mock vive NA PÁGINA: navegar com `page.goto` zera tudo — por isso cada teste faz login e usa só navegação interna depois.
 */

test.use({ viewport: { width: 1440, height: 900 } })

const OPERATOR = { email: "operador@innoelektron.com", password: "senha1234" }
const ADMIN = { email: "admin@innoelektron.com", password: "senha1234" }

async function login(page: Page, who: { email: string; password: string }) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(who.email)
  await page.getByLabel("Senha").fill(who.password)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

async function openChargePoints(page: Page) {
  await page.getByRole("navigation", { name: "Navegação do painel" }).getByRole("link", { name: "Pontos de recarga" }).click()
  await expect(page).toHaveURL(/\/admin\/charge-points/)
}

const rowOf = (page: Page, text: string) => page.getByRole("row").filter({ has: page.getByRole("cell", { name: text, exact: true }) })

/** Abre "Tarifas de <carregador>" pela linha da tabela. */
async function openTariffsOf(page: Page, ocppIdentity: string) {
  await rowOf(page, ocppIdentity).getByRole("button", { name: `Tarifas de ${ocppIdentity}` }).click()
  const dialog = page.getByRole("dialog", { name: `Tarifas de ${ocppIdentity}` })
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe("Admin — vínculo de tarifa por carregador", () => {
  test("carregador sem tarifa: aviso explícito, vincula e passa a valer (tabela e diálogo atualizam)", async ({ page }) => {
    await login(page, OPERATOR)
    await openChargePoints(page)

    // A tabela já denuncia quem está sem tarifa (cp_4 e cp_5) e quem tem (cp_3: "Expressa Rodovia").
    await expect(rowOf(page, "CP-OUTLET-CAMPINAS-01").getByText("Sem tarifa", { exact: true })).toBeVisible()
    await expect(rowOf(page, "CP-ANHANGUERA-01").getByText("Sem tarifa", { exact: true })).toBeVisible()
    await expect(rowOf(page, "CP-BARRA-FUNDA-01").getByText("Expressa Rodovia", { exact: true })).toBeVisible()
    await expect(page.getByTestId("cp-without-tariff-alert")).toContainText("2 carregadores sem tarifa")

    const dialog = await openTariffsOf(page, "CP-OUTLET-CAMPINAS-01")
    await expect(dialog.getByTestId("no-tariff-alert")).toContainText("Este carregador está sem tarifa")
    await expect(dialog.getByTestId("no-tariff-alert")).toContainText("o QR não inicia")
    await expect(dialog.getByTestId("effective-row")).toContainText("Sem tarifa — o QR não inicia")
    await expect(dialog.getByRole("heading", { name: "Nenhuma tarifa vinculada" }).or(dialog.getByText("Nenhuma tarifa vinculada"))).toBeVisible()

    // ---- Vincular ao CARREGADOR (escopo e alvo já vêm do contexto) ----------------------------
    await dialog.getByRole("button", { name: "Vincular tarifa" }).first().click()
    const form = page.getByRole("dialog", { name: "Vincular tarifa" })
    await expect(form.getByLabel("Onde vale")).toHaveValue("CHARGE_POINT")
    await expect(form.getByLabel("Carregador")).toHaveValue("cp_4")
    // Multi-tenant: só as tarifas do operador A — a do operador B nunca é oferecida.
    await expect(form.getByLabel("Tarifa").getByRole("option", { name: /Padrão DC/ })).toHaveCount(1)
    await expect(form.getByLabel("Tarifa").getByRole("option", { name: /Padrão Posto/ })).toHaveCount(0)
    await form.getByLabel("Tarifa").selectOption({ label: "Padrão DC — R$ 1,99/kWh" })
    await form.getByRole("button", { name: "Vincular tarifa" }).click()

    await expect(page.getByText("Tarifa vinculada.")).toBeVisible()
    await expect(form).not.toBeVisible()
    await expect(dialog.getByTestId("no-tariff-alert")).toHaveCount(0)
    await expect(dialog.getByTestId("effective-row")).toContainText("Padrão DC")
    const item = dialog.getByTestId("assignment-item")
    await expect(item).toHaveCount(1)
    await expect(item).toContainText("CP-OUTLET-CAMPINAS-01")
    await expect(item.getByText("Vale hoje", { exact: true })).toBeVisible()
    await expect(item.getByText("Vigente", { exact: true })).toBeVisible()

    // Fecha e confere a tabela: o carregador deixou de estar sem tarifa e o aviso da página baixou para 1.
    await dialog.getByRole("button", { name: "Fechar" }).click()
    await expect(rowOf(page, "CP-OUTLET-CAMPINAS-01").getByText("Padrão DC", { exact: true })).toBeVisible()
    await expect(page.getByTestId("cp-without-tariff-alert")).toContainText("1 carregador sem tarifa")
  })

  test("vincular a uma TOMADA: escopo mais específico vence e o carregador passa a 'varia por tomada'", async ({ page }) => {
    await login(page, OPERATOR)
    await openChargePoints(page)
    await expect(rowOf(page, "CP-BARRA-FUNDA-01").getByText("Expressa Rodovia", { exact: true })).toBeVisible()

    const dialog = await openTariffsOf(page, "CP-BARRA-FUNDA-01")
    await expect(dialog.getByTestId("effective-row")).toHaveCount(2)
    await expect(dialog.getByTestId("effective-row").nth(0)).toContainText("Expressa Rodovia")

    await dialog.getByRole("button", { name: "Vincular tarifa" }).first().click()
    const form = page.getByRole("dialog", { name: "Vincular tarifa" })
    await form.getByLabel("Onde vale").selectOption("CONNECTOR")
    // O alvo é a lista de tomadas DESTE carregador (contexto), com o tipo para o dono reconhecer.
    const tomada = form.getByLabel("Tomada")
    await expect(tomada.getByRole("option")).toHaveCount(3) // placeholder + 2 tomadas
    await tomada.selectOption({ label: "CP-BARRA-FUNDA-01 · tomada #2 (DC CCS2)" })
    await form.getByLabel("Tarifa").selectOption({ label: "Padrão DC — R$ 1,99/kWh" })
    await form.getByRole("button", { name: "Vincular tarifa" }).click()
    await expect(page.getByText("Tarifa vinculada.")).toBeVisible()

    await expect(dialog.getByTestId("effective-row").nth(0)).toContainText("Expressa Rodovia")
    await expect(dialog.getByTestId("effective-row").nth(1)).toContainText("Padrão DC")

    await dialog.getByRole("button", { name: "Fechar" }).click()
    await expect(rowOf(page, "CP-BARRA-FUNDA-01").getByText("Varia por tomada", { exact: true })).toBeVisible()
  })

  test("validação do escopo: sem escolher o alvo não envia, e a mensagem diz o que falta", async ({ page }) => {
    await login(page, OPERATOR)
    await openChargePoints(page)
    const dialog = await openTariffsOf(page, "CP-ANHANGUERA-01")

    await dialog.getByRole("button", { name: "Vincular tarifa" }).first().click()
    const form = page.getByRole("dialog", { name: "Vincular tarifa" })
    await form.getByLabel("Tarifa").selectOption({ label: "Padrão DC — R$ 1,99/kWh" })
    await form.getByLabel("Onde vale").selectOption("CONNECTOR") // troca o escopo: o alvo (carregador) deixa de valer
    await expect(form.getByLabel("Tomada")).toHaveValue("")
    await form.getByRole("button", { name: "Vincular tarifa" }).click()

    await expect(form.getByText("Selecione a tomada.")).toBeVisible()
    await expect(page.getByText("Tarifa vinculada.")).toHaveCount(0)
    await expect(form).toBeVisible()

    // Escopo "Todo o operador" não tem alvo: o campo some e o envio passa.
    await form.getByLabel("Onde vale").selectOption("OPERATOR")
    await expect(form.getByLabel("Tomada")).toHaveCount(0)
    await expect(form.getByLabel("Carregador")).toHaveCount(0)
    await expect(form.getByLabel("Local")).toHaveCount(0)

    // Data final antes da inicial: erro no campo, nada enviado.
    await form.getByLabel(/Vale a partir de/).fill("2030-02-10")
    await form.getByLabel(/Vale até/).fill("2030-02-01")
    await form.getByRole("button", { name: "Vincular tarifa" }).click()
    await expect(form.getByText("A data final não pode ser anterior à inicial.")).toBeVisible()
    await expect(page.getByText("Tarifa vinculada.")).toHaveCount(0)
  })

  test("remover pede confirmação, encerra o vínculo (soft) e a tarifa cai para a próxima que vale", async ({ page }) => {
    await login(page, OPERATOR)
    await openChargePoints(page)
    const dialog = await openTariffsOf(page, "CP-VILA-NORTE-01")

    // cp_1: tomada #1 = tarifa do LOCAL (Padrão DC); tomada #2 = vínculo próprio, prioridade 5 (Expressa Rodovia).
    await expect(dialog.getByTestId("effective-row").nth(0)).toContainText("Padrão DC")
    await expect(dialog.getByTestId("effective-row").nth(1)).toContainText("Expressa Rodovia")
    await expect(dialog.getByTestId("assignment-item")).toHaveCount(2)

    await dialog.getByRole("button", { name: /Remover vínculo: Expressa Rodovia em CP-VILA-NORTE-01 · tomada #2/ }).click()
    const confirm = page.getByRole("dialog", { name: /Remover "Expressa Rodovia"/ })
    await expect(confirm).toContainText("o QR deixa de iniciar recarga")
    // Cancelar não remove nada.
    await confirm.getByRole("button", { name: "Cancelar" }).click()
    await expect(dialog.getByTestId("assignment-item")).toHaveCount(2)

    await dialog.getByRole("button", { name: /Remover vínculo: Expressa Rodovia/ }).click()
    await page.getByRole("dialog", { name: /Remover "Expressa Rodovia"/ }).getByRole("button", { name: "Remover vínculo" }).click()
    await expect(page.getByText("Vínculo encerrado.")).toBeVisible()

    await expect(dialog.getByTestId("assignment-item")).toHaveCount(1)
    await expect(dialog.getByTestId("effective-row").nth(1)).toContainText("Padrão DC") // caiu para a tarifa do local
    // O vínculo não sumiu: está em "encerrados".
    await dialog.getByRole("button", { name: /Mostrar encerrados \(1\)/ }).click()
    await expect(dialog.getByTestId("assignment-item")).toHaveCount(2)
    await expect(dialog.getByText("Encerrado", { exact: true })).toBeVisible()
  })

  test("editar muda prioridade; escopo e alvo ficam só leitura", async ({ page }) => {
    await login(page, OPERATOR)
    await openChargePoints(page)
    const dialog = await openTariffsOf(page, "CP-BARRA-FUNDA-01")

    await dialog.getByRole("button", { name: /Editar vínculo: Expressa Rodovia em CP-BARRA-FUNDA-01$/ }).click()
    const form = page.getByRole("dialog", { name: "Editar vínculo de tarifa" })
    await expect(form.getByText("Para vincular a outro local, carregador ou tomada, crie um vínculo novo.")).toBeVisible()
    await expect(form.getByLabel("Onde vale")).toHaveCount(0)
    await form.getByLabel("Prioridade").fill("7")
    await form.getByRole("button", { name: "Salvar alterações" }).click()
    await expect(page.getByText("Vínculo atualizado.")).toBeVisible()
    await expect(dialog.getByTestId("assignment-item").first().locator("dd", { hasText: /^7$/ })).toBeVisible()
  })
})

test.describe("Admin — isolamento entre operadores e visão por tarifa", () => {
  test("OPERATOR não vê alvos de outro operador (locais, carregadores, tomadas)", async ({ page }) => {
    await login(page, OPERATOR)
    await page.getByRole("link", { name: "Tarifas" }).click()
    await expect(page.getByRole("cell", { name: "Padrão DC", exact: true })).toBeVisible()
    await expect(page.getByRole("cell", { name: "Padrão Posto", exact: true })).toHaveCount(0) // tarifa do operador B

    await page.getByRole("button", { name: "Onde Padrão DC vale" }).click()
    const usage = page.getByRole("dialog", { name: /Onde "Padrão DC" vale/ })
    await expect(usage).toBeVisible()
    await usage.getByRole("button", { name: "Vincular tarifa" }).first().click()
    const form = page.getByRole("dialog", { name: "Vincular tarifa" })

    const locais = form.getByLabel("Local")
    await expect(locais.getByRole("option", { name: /Shopping Vila Norte/ })).toHaveCount(1)
    await expect(locais.getByRole("option", { name: /Posto Estrada Real/ })).toHaveCount(0)

    await form.getByLabel("Onde vale").selectOption("CHARGE_POINT")
    await expect(form.getByLabel("Carregador").getByRole("option", { name: "CP-VILA-NORTE-01" })).toHaveCount(1)
    await expect(form.getByLabel("Carregador").getByRole("option", { name: "CP-ESTRADA-REAL-01" })).toHaveCount(0)

    await form.getByLabel("Onde vale").selectOption("CONNECTOR")
    await expect(form.getByLabel("Tomada").getByRole("option", { name: /CP-ESTRADA-REAL-01/ })).toHaveCount(0)
    await expect(form.getByLabel("Tomada").getByRole("option", { name: /CP-VILA-NORTE-01 · tomada #1/ })).toHaveCount(1)
  })

  test("ADMIN: a tarifa escolhida define o operador — só aparecem alvos DELE; tarifa sem vínculo é sinalizada", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("link", { name: "Tarifas" }).click()

    // "Padrão Posto" (operador B) não tem vínculo nenhum; "Padrão DC" tem 1 vigente (o do site_1; o do site_3 está encerrado).
    await expect(rowOf(page, "Padrão Posto").getByText("Sem vínculo", { exact: true })).toBeVisible()
    await expect(rowOf(page, "Padrão DC").getByText("1 vínculo", { exact: true })).toBeVisible()

    await page.getByRole("button", { name: "Onde Padrão Posto vale" }).click()
    const usage = page.getByRole("dialog", { name: /Onde "Padrão Posto" vale/ })
    await expect(usage).toContainText("não está vinculada a nada")
    await usage.getByRole("button", { name: "Vincular tarifa" }).first().click()
    const form = page.getByRole("dialog", { name: "Vincular tarifa" })

    await expect(form.getByLabel("Tarifa")).toBeDisabled() // veio fixa da tarifa em que o admin clicou
    await expect(form.getByLabel("Local").getByRole("option", { name: /Posto Estrada Real/ })).toHaveCount(1)
    await expect(form.getByLabel("Local").getByRole("option", { name: /Shopping Vila Norte/ })).toHaveCount(0)

    await form.getByLabel("Local").selectOption({ label: "Posto Estrada Real (Juiz de Fora/MG)" })
    await form.getByRole("button", { name: "Vincular tarifa" }).click()
    await expect(page.getByText("Tarifa vinculada.")).toBeVisible()
    await expect(usage.getByTestId("assignment-item")).toContainText("Posto Estrada Real")
    await usage.getByRole("button", { name: "Fechar" }).click()
    await expect(rowOf(page, "Padrão Posto").getByText("1 vínculo", { exact: true })).toBeVisible()
  })
})

test.describe("Admin — conectores e acessibilidade", () => {
  test("conectores: 'Sem tarifa' por tomada e atalho para a tela do carregador", async ({ page }) => {
    await login(page, OPERATOR)
    await page.getByRole("link", { name: "Conectores" }).click()
    await expect(page).toHaveURL(/\/admin\/connectors/)

    // Tomadas do cp_4 (conn_6) e do cp_5 (conn_7) não têm tarifa; as do cp_3 herdam a do carregador.
    const semTarifa = page.getByRole("cell", { name: "Sem tarifa", exact: true })
    await expect(semTarifa).toHaveCount(2)

    await page.getByRole("button", { name: "Tarifas do conector 1" }).first().click() // primeira linha: cp_1 #1
    await expect(page.getByRole("dialog", { name: /Tarifas de CP-VILA-NORTE-01/ })).toBeVisible()
  })

  test("o diálogo é navegável por teclado: abre, foca dentro, Esc fecha e devolve o foco ao botão", async ({ page }) => {
    await login(page, OPERATOR)
    await openChargePoints(page)
    const trigger = rowOf(page, "CP-ANHANGUERA-01").getByRole("button", { name: "Tarifas de CP-ANHANGUERA-01" })
    await trigger.focus()
    await page.keyboard.press("Enter")
    const dialog = page.getByRole("dialog", { name: "Tarifas de CP-ANHANGUERA-01" })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator(":focus")).toHaveCount(1)
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
  })
})
