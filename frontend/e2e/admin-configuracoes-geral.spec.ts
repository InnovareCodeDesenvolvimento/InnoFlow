import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → Configurações → aba Geral (dados da empresa e versões dos Termos/Privacidade), contra os mocks MSW (`src/mocks/companyData.ts` + `handlers.ts`).
 * NADA aqui foi provado contra o backend real; o formato é o de `docs/CONTRATO-EMPRESA-ADMIN.md`.
 * O estado do mock vive por conta de ADMIN e na memória da PÁGINA (um `page.goto` zera tudo): UMA navegação real (login) por teste e o resto é clique na SPA.
 *
 * Contas (mesmas de `communicationData.ts`): admin@ -> env; comunicacao-pronta@ -> painel; comunicacao-vazia@ -> env com `LEGAL_CNPJ` inválido; comunicacao-indisponivel@ -> GET 503.
 */

const PASSWORD = "senha1234"
const NAV = "Navegação do painel administrativo"
const CNPJ_ALFA = "12.ABC.345/01DE-35" // vetor do teste do backend (`cnpjAlfanumerico.test.ts`)

async function login(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

async function openGeral(page: Page) {
  await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Configurações" }).click()
  await expect(page).toHaveURL(/\/admin\/configuracoes\/geral$/)
  await expect(page.getByRole("heading", { name: "Configurações · Geral", level: 1 })).toBeVisible()
}

/** Corpos dos PUTs em `/api/admin/company-profile`. */
function capturePuts(page: Page) {
  const bodies: Array<Record<string, unknown>> = []
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/api/admin/company-profile")) bodies.push(JSON.parse(req.postData() ?? "{}") as Record<string, unknown>)
  })
  return bodies
}

const save = (page: Page) => page.getByTestId("save-button")
const field = (page: Page, name: string) => page.getByTestId(`company-${name}`)
const versionDialog = (page: Page) => page.getByRole("dialog", { name: "Mudar a versão dos documentos?" })

test.describe("leitura", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("origem env (admin@): banner das variáveis LEGAL_*, selo da origem, valores do servidor, versões do servidor, salvar bloqueado", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openGeral(page)
    await expect(page.getByTestId("company-source-env")).toContainText("Usando as variáveis do servidor")
    await expect(page.getByTestId("company-source")).toHaveText("Vem do servidor (variáveis LEGAL_*)")
    await expect(field(page, "legalName")).toHaveValue("InnoFlow Mobilidade Elétrica Ltda")
    await expect(field(page, "cnpj")).toHaveValue("11.222.333/0001-81")
    await expect(field(page, "tradeName")).toHaveValue("")
    await expect(field(page, "termsVersion")).toHaveValue("")
    await expect(page.getByText("Vigente agora: 2026-09-01 (do servidor). Em branco: 2026-09-01.").first()).toBeVisible()
    await expect(save(page)).toBeDisabled()
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
    await expect(page.getByTestId("company-version-note")).toHaveAttribute("data-active", "false")
  })

  test("origem painel (pronta@): selo \"Salvo no painel\", sem banner, versões do painel, data da última alteração", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openGeral(page)
    await expect(page.getByTestId("company-source")).toHaveText("Salvo no painel")
    await expect(page.getByTestId("company-source-env")).toHaveCount(0)
    await expect(field(page, "dpoEmail")).toHaveValue("dpo@innoflow.example")
    await expect(field(page, "termsVersion")).toHaveValue("2026-10-01")
    await expect(page.getByText("Vigente agora: 2026-10-01 (do painel). Em branco: 2026-09-01.").first()).toBeVisible()
    await expect(page.getByTestId("save-bar-propagation")).toContainText("Última alteração em")
  })

  test("variável do servidor com valor inválido (vazia@): alerta com o nome da variável", async ({ page }) => {
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openGeral(page)
    await expect(page.getByTestId("company-invalid-env")).toContainText("LEGAL_CNPJ")
  })

  test("GET 503 (indisponivel@): estado de erro com tentar de novo, sem formulário", async ({ page }) => {
    await login(page, "comunicacao-indisponivel@innoelektron.com")
    await openGeral(page)
    await expect(page.getByText("O servidor não conseguiu ler os dados da empresa")).toBeVisible()
    await expect(page.getByRole("button", { name: /tentar/i })).toBeVisible()
    await expect(page.getByTestId("section-company")).toHaveCount(0)
  })
})

test.describe("validação e salvar", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("CNPJ: espelha o servidor — numérico com ou sem pontuação e alfanumérico passam; dígito errado só acusa depois de completo ou ao sair do campo", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openGeral(page)
    const cnpj = field(page, "cnpj")
    await cnpj.fill("11.222.333/0001-8")
    await expect(page.getByText("CNPJ inválido")).toHaveCount(0) // ainda digitando
    await cnpj.fill("11.222.333/0001-82")
    await expect(page.getByText("CNPJ inválido: confira os números")).toBeVisible()
    await expect(save(page)).toBeDisabled()
    await expect(page.getByTestId("save-bar-errors")).toBeVisible()
    await cnpj.fill("11222333000181")
    await expect(page.getByText("CNPJ inválido")).toHaveCount(0)
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.") // mesmo CNPJ sem pontuação não é alteração
    await cnpj.fill(CNPJ_ALFA)
    await expect(page.getByText("CNPJ inválido")).toHaveCount(0)
    await expect(save(page)).toBeEnabled()
    await cnpj.fill("123")
    await cnpj.blur()
    await expect(page.getByText("CNPJ inválido")).toBeVisible()
  })

  test("outros campos inválidos: e-mail, telefone, site e versão acusam no campo e bloqueiam salvar; descartar volta ao salvo", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openGeral(page)
    await field(page, "supportEmail").fill("sem-arroba")
    await field(page, "supportPhone").fill("123")
    await field(page, "website").fill("localhost")
    await field(page, "termsVersion").fill("versão com espaço")
    await expect(page.getByText("E-mail inválido.")).toBeVisible()
    await expect(page.getByText("Telefone inválido")).toBeVisible()
    await expect(page.getByText("Endereço do site inválido")).toBeVisible()
    await expect(page.getByText("Versão inválida")).toBeVisible()
    await expect(save(page)).toBeDisabled()
    await page.getByRole("button", { name: "Descartar" }).click()
    await expect(field(page, "supportEmail")).toHaveValue("suporte@innoflow.example")
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
  })

  test("salvar manda só o diff, sem senha (não há segredo); esvaziar um campo manda null; a resposta normaliza (CNPJ formatado, e-mail em minúsculas)", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openGeral(page)
    await field(page, "tradeName").fill("Inno Flow")
    await field(page, "supportEmail").fill("")
    await field(page, "cnpj").fill(CNPJ_ALFA.replace(/[./-]/g, "").toLowerCase())
    await expect(page.getByTestId("save-bar-status")).toContainText("3 alterações não salvas")
    await expect(page.getByTestId("company-version-note")).toHaveAttribute("data-active", "false")
    await save(page).click()
    await expect(page.getByText("Dados da empresa salvos.")).toBeVisible()
    expect(puts).toEqual([{ tradeName: "Inno Flow", supportEmail: null, cnpj: "12abc34501de35" }])
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(field(page, "cnpj")).toHaveValue(CNPJ_ALFA)
    await expect(field(page, "supportEmail")).toHaveValue("")
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
  })

  test("1ª gravação com origem env passa a origem para o painel (selo e banner mudam)", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openGeral(page)
    await field(page, "tradeName").fill("InnoFlow")
    await save(page).click()
    await expect(page.getByText("Dados da empresa salvos.")).toBeVisible()
    await expect(page.getByTestId("company-source")).toHaveText("Salvo no painel")
    await expect(page.getByTestId("company-source-env")).toHaveCount(0)
  })

  test("erros do servidor por code: 429 e 500, com o rascunho mantido e a mensagem nossa", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openGeral(page)
    await field(page, "legalName").fill("Limite Ltda")
    await save(page).click()
    await expect(page.getByTestId("company-save-error")).toHaveAttribute("data-code", "RATE_LIMITED")
    await expect(page.getByTestId("company-save-error")).toContainText("Aguarde um minuto")
    await expect(page.getByTestId("company-save-error")).toContainText("O que você preencheu continua na tela.")
    await field(page, "legalName").fill("Erro 500 Ltda")
    await expect(page.getByTestId("company-save-error")).toHaveCount(0) // editar limpa o aviso
    await save(page).click()
    await expect(page.getByTestId("company-save-error")).toHaveAttribute("data-code", "INTERNAL_ERROR")
    await expect(field(page, "legalName")).toHaveValue("Erro 500 Ltda")
  })
})

test.describe("mudar a versão dos documentos", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("o aviso fica ativo; salvar abre a confirmação com o número de motoristas; voltar não grava; confirmar reenvia o MESMO corpo com `confirmVersionChange`", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openGeral(page)
    await field(page, "termsVersion").fill("2026-11-01")
    await expect(page.getByTestId("company-version-note")).toHaveAttribute("data-active", "true")
    await expect(page.getByTestId("company-version-note")).toContainText("todos os motoristas terão de aceitar de novo")
    await save(page).click()

    // 409 do servidor (nada gravado) -> confirmação explícita
    const dialog = versionDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("Todos os 42 motoristas")
    await expect(dialog.getByTestId("version-change-summary")).toContainText("Termos de Uso")
    await expect(dialog.getByTestId("version-change-summary")).toContainText("2026-10-01")
    await expect(dialog.getByTestId("version-change-summary")).toContainText("2026-11-01")
    await expect(dialog.getByTestId("version-change-summary")).not.toContainText("Política de Privacidade")
    await expect(dialog.getByTestId("version-change-confirm")).toBeDisabled()

    await dialog.getByRole("button", { name: "Voltar" }).click()
    await expect(dialog).toBeHidden()
    expect(puts).toEqual([{ termsVersion: "2026-11-01" }])
    await expect(field(page, "termsVersion")).toHaveValue("2026-11-01") // rascunho mantido
    await expect(page.getByText("Vigente agora: 2026-10-01 (do painel).").first()).toBeVisible() // nada foi gravado

    await save(page).click()
    await expect(dialog).toBeVisible()
    await dialog.getByLabel("Entendo que todos os motoristas terão de aceitar os documentos de novo.").check()
    await expect(dialog.getByTestId("version-change-confirm")).toBeEnabled()
    await dialog.getByTestId("version-change-confirm").click()
    await expect(page.getByText("Dados da empresa salvos.")).toBeVisible()
    await expect(dialog).toBeHidden()
    expect(puts).toEqual([{ termsVersion: "2026-11-01" }, { termsVersion: "2026-11-01" }, { termsVersion: "2026-11-01", confirmVersionChange: true }])
    await expect(page.getByText("Vigente agora: 2026-11-01 (do painel).").first()).toBeVisible()
    await expect(page.getByTestId("company-version-note")).toHaveAttribute("data-active", "false")
  })

  test("mudar outros campos junto com a versão: nada é gravado enquanto não confirmar; limpar a versão volta à do servidor (e também pede confirmação)", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openGeral(page)
    await field(page, "tradeName").fill("Novo fantasia")
    await field(page, "termsVersion").fill("")
    await expect(page.getByTestId("company-version-note")).toHaveAttribute("data-active", "true")
    await save(page).click()
    await expect(versionDialog(page)).toContainText("2026-10-01")
    await expect(versionDialog(page).getByTestId("version-change-summary")).toContainText("2026-09-01")
    await versionDialog(page).getByRole("button", { name: "Voltar" }).click()
    // o 409 não gravou nem o nome fantasia
    await page.getByRole("button", { name: "Descartar" }).click()
    await expect(field(page, "tradeName")).toHaveValue("InnoFlow")
    expect(puts).toEqual([{ tradeName: "Novo fantasia", termsVersion: null }])
  })

  test("a mesma versão que já vale não pede confirmação", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "admin@innoelektron.com")
    await openGeral(page)
    await field(page, "termsVersion").fill("2026-09-01") // = a do servidor, que já vale
    await expect(page.getByTestId("company-version-note")).toHaveAttribute("data-active", "false")
    await save(page).click()
    await expect(page.getByText("Dados da empresa salvos.")).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(puts).toEqual([{ termsVersion: "2026-09-01" }])
  })

  test("a confirmação é um diálogo de verdade: foco entra, Esc fecha sem gravar, foco volta ao Salvar", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openGeral(page)
    await field(page, "privacyVersion").fill("2026-12-01")
    await save(page).click()
    await expect(versionDialog(page)).toBeVisible()
    await expect(versionDialog(page).getByTestId("version-change-summary")).toContainText("Política de Privacidade")
    await page.keyboard.press("Escape")
    await expect(versionDialog(page)).toBeHidden()
    expect(puts).toHaveLength(1)
    await expect(save(page)).toBeFocused()
  })
})

test.describe("mobile (375): confirmação de versão", () => {
  test.use({ viewport: { width: 375, height: 700 } })

  test("o diálogo cabe na tela, sem rolagem lateral, com botões de 44 px", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await page.goto("/admin/configuracoes/geral") // abaixo de `lg` o menu é um drawer: vai direto pela URL
    await expect(page.getByRole("heading", { name: "Configurações · Geral", level: 1 })).toBeVisible()
    await field(page, "termsVersion").fill("2026-11-01")
    await save(page).click()
    const dialog = versionDialog(page)
    await expect(dialog).toBeVisible()
    await page.waitForTimeout(700) // a entrada do diálogo anima (escala/translação): mede com ele parado
    const m = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')!.getBoundingClientRect()
      const buttons = [...document.querySelectorAll('[role="dialog"] button:not([aria-label="Fechar"])')].map((b) => Math.round(b.getBoundingClientRect().height))
      return { left: d.left, right: d.right, vw: window.innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, buttons }
    })
    expect(m.left).toBeGreaterThanOrEqual(0)
    expect(m.right).toBeLessThanOrEqual(m.vw)
    expect(m.overflow).toBe(0)
    for (const h of m.buttons) expect(h).toBeGreaterThanOrEqual(40)
  })
})
