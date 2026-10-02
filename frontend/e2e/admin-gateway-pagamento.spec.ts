import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → Gateway de pagamento (F5.5), contra os mocks MSW
 * (`src/mocks/paymentGatewayData.ts` + `handlers.ts`). NADA foi provado contra
 * o backend real — o estado do mock vive por conta de ADMIN e na memória da
 * PÁGINA (um `page.goto` entre passos zera tudo), então cada teste usa UMA
 * navegação real (login) e o resto é clique na SPA.
 *
 * Cenários por conta (ver o cabeçalho de `paymentGatewayData.ts`):
 *  admin@                      → env, nada configurado
 *  gateway-pronto@             → database, sandbox, tudo pronto, Pix habilitado
 *  gateway-producao@           → database, produção, Pix e cartão habilitados
 *  gateway-sem-chave@          → env, servidor sem PAYMENT_SECRETS_KEY, Pix habilitado sem estar pronto
 *
 * Segredos digitados usam marcadores únicos (SEGREDO-...) para provar que
 * NENHUM deles vaza para o DOM, o resumo, o console ou o localStorage.
 */

const PASSWORD = "senha1234"
const NAV = "Navegação do painel administrativo"

async function login(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

async function openGateway(page: Page) {
  await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Gateway de pagamento" }).click()
  await expect(page).toHaveURL(/\/admin\/gateway-pagamento$/)
  await expect(page.getByRole("heading", { name: "Gateway de pagamento", level: 1 })).toBeVisible()
}

/** Junta tudo o que um olho (ou um leitor de tela) alcança: texto visível, valor de todo input e localStorage. */
async function everythingTheUserCouldSee(page: Page): Promise<string> {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input,textarea")).map((el) => (el as HTMLInputElement).value)
    return [document.body.innerText, ...inputs, JSON.stringify({ ...localStorage }), location.href].join("\n")
  })
}

/** Clica na opção VISÍVEL (o card), como o usuário — o `<input type=radio>` é sr-only e pode ficar sob a barra de salvar. */
const envOption = (page: Page, name: "Sandbox" | "Produção") => page.getByTestId("section-environment").locator("label").filter({ hasText: name })

const secretInput = (page: Page, field: "merchantKey" | "sopClientSecret" | "webhookHeaderSecret") => page.getByTestId(`secret-${field}`).locator("input")

/** Preenche a senha atual (step-up, F5.7) no diálogo de salvar e confirma. */
async function submitSaveDialog(page: Page, password: string = PASSWORD) {
  const dialog = page.getByRole("dialog", { name: "Confirmar alterações no gateway" })
  await dialog.getByLabel("Sua senha atual").fill(password)
  await dialog.getByRole("button", { name: "Confirmar e salvar" }).click()
}

function captureConsole(page: Page) {
  const lines: string[] = []
  page.on("console", (msg) => lines.push(msg.text()))
  page.on("pageerror", (err) => lines.push(String(err)))
  return lines
}

/**
 * Bodies dos PUTs SEM a senha (os testes comparam só o diff do que mudou) — a senha vai para `passwords`,
 * em paralelo, para provar que TODO PUT a carregou (step-up).
 */
const passwordsByPuts = new WeakMap<object, unknown[]>()
/** As senhas que acompanharam cada PUT capturado por `capturePuts`, na mesma ordem. */
const putPasswords = (puts: object) => passwordsByPuts.get(puts) ?? []

function capturePuts(page: Page) {
  const bodies: Array<Record<string, unknown>> = []
  const passwords: unknown[] = []
  passwordsByPuts.set(bodies, passwords)
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/api/admin/payment-gateway")) {
      const { currentPassword, ...rest } = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>
      passwords.push(currentPassword)
      bodies.push(rest)
    }
  })
  return bodies
}

test.describe("ADMIN — origem env, nada configurado: ver → configurar → habilitar Pix → produção", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("fluxo completo, com confirmação em cada passo e nenhum segredo à mostra", async ({ page }) => {
    const consoleLines = captureConsole(page)
    const puts = capturePuts(page)
    await login(page, "admin@innoelektron.com")
    await openGateway(page)

    // ---- VER: origem env + prontidão por meio ------------------------------------------------
    await expect(page.getByTestId("source-banner-env")).toContainText("Usando as variáveis do servidor")
    await expect(page.getByTestId("source-banner-env")).toContainText("Na primeira gravação, a configuração nasce com o ambiente atual")
    await expect(page.getByTestId("source-banner-env")).toContainText("salvar não desliga o que já funcionava")
    await expect(page.getByTestId("method-pix-readiness")).toHaveText("Faltam 3 itens")
    await expect(page.getByTestId("method-card-readiness")).toHaveText("Faltam 4 itens")
    await expect(page.getByTestId("method-pix-missing")).toContainText("MerchantId da Cielo")
    await expect(page.getByTestId("method-pix-missing")).toContainText("Segredo do header do webhook")
    // interruptores bloqueados enquanto não está pronto, com a razão dita
    await expect(page.getByRole("switch", { name: "Habilitar Pix" })).toBeDisabled()
    await expect(page.getByRole("switch", { name: "Habilitar Cartão" })).toBeDisabled()
    await expect(page.getByTestId("method-pix")).toContainText("Só pode ser habilitado quando todos os itens acima estiverem resolvidos e salvos")
    await expect(page.getByTestId("method-pix")).toContainText("apenas NOVAS recargas por Pix")
    await expect(page.getByTestId("method-card")).toContainText("NOVAS cobranças e NOVOS cadastros de cartão")
    // segredos: chip "Não configurada" e NENHUM input de senha na tela
    await expect(page.getByTestId("secret-merchantKey")).toContainText("Não configurada")
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    // sem alteração: salvar bloqueado
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeDisabled()
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")

    // ---- CONFIGURAR credenciais -----------------------------------------------------------------
    await page.getByLabel("MerchantId", { exact: true }).fill("mid-teste-001")
    await page.getByRole("button", { name: "Informar MerchantKey" }).click()
    const merchantKey = secretInput(page, "merchantKey")
    await expect(merchantKey).toHaveValue("") // nunca pré-preenchido
    await expect(merchantKey).toHaveAttribute("type", "password")
    await expect(merchantKey).toHaveAttribute("autocomplete", "new-password")
    await merchantKey.fill("SEGREDO-MK-123456")

    // Webhook: gerar segredo aleatório (visível só para copiar)
    await page.getByRole("button", { name: "Gerar segredo aleatório" }).click()
    const webhookSecret = secretInput(page, "webhookHeaderSecret")
    await expect(webhookSecret).toHaveAttribute("type", "text")
    const generated = await webhookSecret.inputValue()
    expect(generated.length).toBeGreaterThanOrEqual(32)
    expect(generated).toMatch(/^[A-Za-z0-9]+$/)
    await expect(page.getByTestId("webhook-secret-generated-note")).toContainText("antes de salvar")
    await expect(page.getByRole("button", { name: "Copiar segredo gerado" })).toBeVisible()
    // clicar de novo gera OUTRO
    await page.getByRole("button", { name: "Gerar segredo aleatório" }).click()
    expect(await webhookSecret.inputValue()).not.toBe(generated)
    const generated2 = await webhookSecret.inputValue()

    await expect(page.getByTestId("save-bar-status")).toHaveText("3 alterações não salvas")

    // ---- SALVAR: resumo antes de enviar ---------------------------------------------------------
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    const summaryDialog = page.getByRole("dialog", { name: "Confirmar alterações no gateway" })
    await expect(summaryDialog).toBeVisible()
    const summary = page.getByTestId("save-summary")
    await expect(summary).toContainText("MerchantId")
    await expect(summary).toContainText("mid-teste-001")
    expect(await summary.locator("text=Será substituída").count()).toBe(2)
    const dialogText = await summaryDialog.innerText()
    expect(dialogText).not.toContain("SEGREDO-MK-123456")
    expect(dialogText).not.toContain(generated2)
    expect(puts).toHaveLength(0) // nada enviado antes de confirmar

    // Cancelar mantém o rascunho e não envia
    await summaryDialog.getByRole("button", { name: "Cancelar" }).click()
    await expect(summaryDialog).toHaveCount(0)
    expect(puts).toHaveLength(0)
    await expect(merchantKey).toHaveValue("SEGREDO-MK-123456")

    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible() // toast
    await expect(summaryDialog).toHaveCount(0)

    // o PUT levou SÓ o que mudou
    expect(puts).toHaveLength(1)
    expect(Object.keys(puts[0]).sort()).toEqual(["merchantId", "merchantKey", "webhookHeaderSecret"])
    expect(puts[0].merchantId).toBe("mid-teste-001")

    // ---- Depois de salvo: tudo limpo, nada de segredo na tela -----------------------------------
    await expect(page.getByTestId("source-banner-database")).toContainText("Configuração salva nesta tela")
    await expect(page.getByTestId("secret-merchantKey")).toContainText("Configurada")
    await expect(page.getByTestId("secret-merchantKey")).not.toContainText("Não configurada")
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    await expect(secretInput(page, "webhookHeaderSecret")).toHaveCount(0)
    await expect(page.getByTestId("method-pix-readiness")).toHaveText("Pronto")
    await expect(page.getByTestId("method-card-readiness")).toHaveText("Faltam 2 itens") // MerchantId/MerchantKey vieram; faltam só os 2 do cadastro de cartão
    const seen = await everythingTheUserCouldSee(page)
    for (const secret of ["SEGREDO-MK-123456", generated, generated2]) expect(seen).not.toContain(secret)

    // ---- HABILITAR o Pix (agora liberado) --------------------------------------------------------
    const pixSwitch = page.getByRole("switch", { name: "Habilitar Pix" })
    await expect(pixSwitch).toBeEnabled()
    await expect(pixSwitch).toHaveAttribute("aria-checked", "false")
    await pixSwitch.click()
    await expect(pixSwitch).toHaveAttribute("aria-checked", "true")
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await expect(page.getByTestId("save-summary")).toContainText("Desabilitado")
    await expect(page.getByTestId("save-summary")).toContainText("Habilitado")
    await submitSaveDialog(page)
    await expect(summaryDialog).toHaveCount(0)
    expect(puts).toHaveLength(2)
    expect(puts[1]).toEqual({ pixEnabled: true })
    await expect(pixSwitch).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("method-pix")).toContainText("Habilitado")

    // ---- PRODUÇÃO: confirmação digitada ---------------------------------------------------------
    await envOption(page, "Produção").click()
    const prodDialog = page.getByRole("dialog", { name: "Passar para produção?" })
    await expect(prodDialog).toBeVisible()
    const confirmBtn = prodDialog.getByRole("button", { name: "Selecionar produção" })
    await expect(confirmBtn).toBeDisabled()
    await prodDialog.getByLabel(/Para confirmar, digite PRODUÇÃO/).fill("prod")
    await expect(confirmBtn).toBeDisabled()
    await prodDialog.getByLabel(/Para confirmar, digite PRODUÇÃO/).fill("producao") // sem acento, minúsculas
    await expect(confirmBtn).toBeEnabled()
    // Cancelar volta ao sandbox sem mexer em nada
    await prodDialog.getByRole("button", { name: "Cancelar" }).click()
    await expect(prodDialog).toHaveCount(0)
    await expect(page.getByRole("radio", { name: /Sandbox/ })).toBeChecked()
    await expect(page.getByTestId("environment-production-banner")).toHaveCount(0)
    expect(puts).toHaveLength(2)

    await envOption(page, "Produção").click()
    await prodDialog.getByLabel(/Para confirmar, digite PRODUÇÃO/).fill("PRODUÇÃO")
    await confirmBtn.click()
    await expect(prodDialog).toHaveCount(0)
    await expect(page.getByTestId("environment-production-banner")).toContainText("Produção selecionada — ainda não salva")
    expect(puts).toHaveLength(2) // selecionar não envia

    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await expect(page.getByTestId("save-summary")).toContainText("Sandbox (testes)")
    await expect(summaryDialog.getByText(/passa a cobrar de verdade/)).toBeVisible()
    await submitSaveDialog(page)
    await expect(summaryDialog).toHaveCount(0)
    expect(puts).toHaveLength(3)
    expect(puts[2]).toEqual({ environment: "production", confirmProduction: true })
    await expect(page.getByTestId("environment-production-banner")).toContainText("Ambiente de PRODUÇÃO ativo")
    await expect(page.getByRole("radio", { name: /Produção/ })).toBeChecked()

    // nenhuma linha de console carregou segredo
    expect(consoleLines.join("\n")).not.toMatch(/SEGREDO-MK|webhookHeaderSecret/)
    for (const secret of [generated, generated2]) expect(consoleLines.join("\n")).not.toContain(secret)
  })

  test("Descartar volta ao salvo; segredo digitado some junto", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openGateway(page)
    await page.getByLabel("MerchantId", { exact: true }).fill("outro-id")
    await page.getByRole("button", { name: "Informar MerchantKey" }).click()
    await secretInput(page, "merchantKey").fill("SEGREDO-DESCARTADO-9")
    await expect(page.getByTestId("save-bar-status")).toHaveText("2 alterações não salvas")
    await page.getByRole("button", { name: "Descartar" }).click()
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
    await expect(page.getByLabel("MerchantId", { exact: true })).toHaveValue("")
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    expect(await everythingTheUserCouldSee(page)).not.toContain("SEGREDO-DESCARTADO-9")
  })

  test("segredo do webhook com menos de 32 caracteres: erro no campo e salvar bloqueado (mínimo do servidor)", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openGateway(page)
    await page.getByRole("button", { name: "Informar Segredo do header" }).click()
    await secretInput(page, "webhookHeaderSecret").fill("curto")
    await expect(page.getByText("O segredo precisa ter pelo menos 32 caracteres.")).toBeVisible()
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeDisabled()
    await secretInput(page, "webhookHeaderSecret").fill("longo-o-bastante-ainda-curto-12") // 31
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeDisabled()
    await secretInput(page, "webhookHeaderSecret").fill("longo-o-bastante-agora-sim-32-ok") // 32
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeEnabled()
  })
})

test.describe("ADMIN — banco, sandbox, tudo pronto", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("mostra a data, os segredos como 'Configurada' (campo só abre ao substituir, vazio) e desligar manda só o interruptor", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "gateway-pronto@innoelektron.com")
    await openGateway(page)

    await expect(page.getByTestId("source-banner-database")).toContainText(/Última alteração em \d{2}\/\d{2}\/\d{4}/)
    await expect(page.getByTestId("method-pix-readiness")).toHaveText("Pronto")
    await expect(page.getByTestId("method-card-readiness")).toHaveText("Pronto")
    await expect(page.getByLabel("MerchantId", { exact: true })).toHaveValue("mid-sandbox-7f3a91")
    for (const field of ["merchantKey", "sopClientSecret", "webhookHeaderSecret"] as const) {
      await expect(page.getByTestId(`secret-${field}`)).toContainText("Configurada")
    }
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    await expect(page.getByRole("switch", { name: "Habilitar Pix" })).toHaveAttribute("aria-checked", "true")
    await expect(page.getByRole("switch", { name: "Habilitar Cartão" })).toHaveAttribute("aria-checked", "false")
    await expect(page.getByRole("switch", { name: "Habilitar Cartão" })).toBeEnabled()

    // Substituir abre um campo VAZIO, mascarado, sem autopreenchimento
    await page.getByRole("button", { name: "Substituir MerchantKey" }).click()
    await expect(secretInput(page, "merchantKey")).toHaveValue("")
    await expect(secretInput(page, "merchantKey")).toHaveAttribute("type", "password")
    await page.getByTestId("secret-merchantKey").getByRole("button", { name: "Cancelar" }).click()
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")

    // Teclado: Espaço no interruptor liga/desliga
    const pix = page.getByRole("switch", { name: "Habilitar Pix" })
    await pix.focus()
    await page.keyboard.press("Space")
    await expect(pix).toHaveAttribute("aria-checked", "false")
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
    expect(puts).toEqual([{ pixEnabled: false }])
  })

  test("habilitar o cartão (pronto) salva sem pedir produção", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "gateway-pronto@innoelektron.com")
    await openGateway(page)
    await page.getByRole("switch", { name: "Habilitar Cartão" }).click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
    expect(puts).toEqual([{ cardEnabled: true }])
  })
})

test.describe("ADMIN — já em produção", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("faixa de perigo persistente; voltar ao sandbox não pede digitação; produção de volta também não", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "gateway-producao@innoelektron.com")
    await openGateway(page)
    await expect(page.getByTestId("environment-production-banner")).toContainText("Ambiente de PRODUÇÃO ativo")
    await expect(page.getByRole("radio", { name: /Produção/ })).toBeChecked()

    await envOption(page, "Sandbox").click()
    await expect(page.getByTestId("environment-production-banner")).toHaveCount(0)
    await envOption(page, "Produção").click() // voltou ao estado salvo: sem diálogo
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")

    await envOption(page, "Sandbox").click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
    expect(puts).toEqual([{ environment: "sandbox" }]) // sem confirmProduction na direção segura
    await expect(page.getByTestId("environment-sandbox-note")).toBeVisible()
  })
})

test.describe("ADMIN — servidor sem PAYMENT_SECRETS_KEY / webhook sem token", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("explica o que é só do servidor; 503 ao enviar segredo; 409 ao ir para produção listando o que falta", async ({ page }) => {
    const puts = capturePuts(page)
    const consoleLines = captureConsole(page)
    await login(page, "gateway-sem-chave@innoelektron.com")
    await openGateway(page)

    // URL do webhook ausente: explica a variável que falta
    await expect(page.getByTestId("webhook-url-missing")).toContainText("CIELO_WEBHOOK_PATH_TOKEN")
    // prontidão com itens SÓ DO SERVIDOR separados dos da tela
    const missing = page.getByTestId("method-pix-missing")
    await expect(missing).toContainText("Preencha nesta tela")
    await expect(missing).toContainText("Só no servidor (EasyPanel)")
    await expect(missing).toContainText("CIELO_WEBHOOK_PATH_TOKEN")
    await expect(missing).toContainText("PAYMENT_SECRETS_KEY")
    await expect(missing).toContainText("openssl rand -base64 32")
    // Pix está habilitado mesmo sem estar pronto: DESLIGAR é permitido (não fica preso)
    const pix = page.getByRole("switch", { name: "Habilitar Pix" })
    await expect(pix).toHaveAttribute("aria-checked", "true")
    await expect(pix).toBeEnabled()
    // cartão desligado e sem pronto: não dá para ligar
    await expect(page.getByRole("switch", { name: "Habilitar Cartão" })).toBeDisabled()

    // 503: enviar um segredo (origem env: o par vai junto — MerchantId + MerchantKey)
    await page.getByLabel("MerchantId", { exact: true }).fill("mid-503")
    await page.getByRole("button", { name: "Informar MerchantKey" }).click()
    await secretInput(page, "merchantKey").fill("SEGREDO-SEM-CHAVE-77")
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await submitSaveDialog(page)
    const error = page.getByTestId("save-error")
    await expect(error).toBeVisible()
    await expect(error).toHaveAttribute("data-code", "PAYMENT_SECRETS_KEY_MISSING")
    await expect(error).toContainText("PAYMENT_SECRETS_KEY")
    await expect(error).toContainText("openssl rand -base64 32")
    expect(puts).toHaveLength(1)
    // o rascunho continua (o admin não perde o que digitou) e o valor não vazou para lugar nenhum além do próprio campo
    await expect(secretInput(page, "merchantKey")).toHaveValue("SEGREDO-SEM-CHAVE-77")
    expect(await page.locator("body").innerText()).not.toContain("SEGREDO-SEM-CHAVE-77")
    expect(consoleLines.join("\n")).not.toContain("SEGREDO-SEM-CHAVE-77")

    // Descarta o segredo. Origem env: o MerchantId sozinho NÃO é enviável (par com a MerchantKey) — a tela barra no cliente.
    await page.getByRole("button", { name: "Descartar" }).click()
    await expect(page.getByTestId("save-error")).toHaveCount(0)
    await page.getByLabel("MerchantId", { exact: true }).fill("mid-sem-segredo")
    await expect(page.getByText("Ao informar o MerchantId, informe também a MerchantKey nesta mesma alteração.")).toBeVisible()
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeDisabled()
    expect(puts).toHaveLength(1) // nada novo saiu
    await page.getByRole("button", { name: "Descartar" }).click()

    // 409: ir para produção com o Pix habilitado e sem pré-requisitos
    await envOption(page, "Produção").click()
    const prodDialog = page.getByRole("dialog", { name: "Passar para produção?" })
    await prodDialog.getByLabel(/Para confirmar, digite PRODUÇÃO/).fill("Produção")
    await prodDialog.getByRole("button", { name: "Selecionar produção" }).click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await submitSaveDialog(page)
    await expect(error).toHaveAttribute("data-code", "GATEWAY_NOT_READY")
    const notReady = page.getByTestId("save-error-missing")
    await expect(notReady).toContainText("MerchantKey da Cielo")
    await expect(notReady).toContainText("Segredo do header do webhook")
    await expect(notReady).toContainText("CIELO_WEBHOOK_PATH_TOKEN")
    expect(puts.at(-1)).toEqual({ environment: "production", confirmProduction: true })
    // continua em sandbox no servidor: o banner de produção é só rascunho
    await expect(page.getByTestId("environment-production-banner")).toContainText("ainda não salva")
  })
})

const confirmSave = async (page: Page) => {
  await page.getByRole("button", { name: "Salvar alterações" }).click()
  await submitSaveDialog(page)
}

test.describe("PARES de credenciais: id + segredo no mesmo salvar (regra do servidor real)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("origem env: um lado só é barrado no cliente, com a mensagem no campo que falta; os dois juntos salvam", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "admin@innoelektron.com")
    await openGateway(page)

    // MerchantId sozinho => erro na MerchantKey (que ainda nem está aberta para edição)
    await page.getByLabel("MerchantId", { exact: true }).fill("mid-par-1")
    const keyField = page.getByTestId("secret-merchantKey")
    await expect(keyField.getByRole("alert")).toHaveText("Ao informar o MerchantId, informe também a MerchantKey nesta mesma alteração.")
    await expect(page.getByTestId("save-bar-errors")).toContainText("corrija os campos marcados")
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeDisabled()

    // abrir o campo (ainda vazio) mantém o erro, agora dentro do input; digitar a chave resolve
    await page.getByRole("button", { name: "Informar MerchantKey" }).click()
    await expect(keyField.getByRole("alert")).toHaveText(/informe também a MerchantKey/)
    await expect(secretInput(page, "merchantKey")).toHaveAttribute("aria-invalid", "true")
    await secretInput(page, "merchantKey").fill("SEGREDO-PAR-1")
    await expect(page.getByTestId("save-bar-errors")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeEnabled()

    // some o id e fica só a chave => o erro vai para o MerchantId
    await page.getByLabel("MerchantId", { exact: true }).fill("")
    await expect(page.getByText("Ao informar a MerchantKey, informe também o MerchantId nesta mesma alteração.")).toBeVisible()
    await expect(page.getByLabel("MerchantId", { exact: true })).toHaveAttribute("aria-invalid", "true")
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeDisabled()

    // par do cartão: Client ID sozinho
    await page.getByLabel("MerchantId", { exact: true }).fill("mid-par-1")
    await page.getByLabel("Client ID do cadastro de cartão").fill("sop-par-1")
    await expect(page.getByTestId("secret-sopClientSecret").getByRole("alert")).toHaveText(
      "Ao informar o Client ID do cadastro de cartão, informe também o Client Secret do cadastro de cartão nesta mesma alteração.",
    )
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeDisabled()
    await page.getByLabel("Client ID do cadastro de cartão").fill("")
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeEnabled()

    await confirmSave(page)
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
    expect(puts).toHaveLength(1)
    expect(Object.keys(puts[0]).sort()).toEqual(["merchantId", "merchantKey"])
  })

  test("origem banco com segredo salvo: trocar só o MerchantId é permitido (nenhuma barreira)", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "gateway-pronto@innoelektron.com")
    await openGateway(page)
    await page.getByLabel("MerchantId", { exact: true }).fill("mid-so-id-9")
    await expect(page.getByTestId("save-bar-errors")).toHaveCount(0)
    await expect(page.locator("[data-testid=section-credentials] [role=alert]")).toHaveCount(0)
    await confirmSave(page)
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
    expect(puts).toEqual([{ merchantId: "mid-so-id-9" }])
  })

  test("o MOCK espelha o servidor: PUT com um lado só (origem env) => 409 GATEWAY_NOT_READY, details = array de STRINGS", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    const result = await page.evaluate(async () => {
      const token = localStorage.getItem("innoelektron_token")
      const call = async (body: unknown) => {
        const res = await fetch("/api/admin/payment-gateway", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        })
        return { status: res.status, body: await res.json() }
      }
      return {
        idOnly: await call({ merchantId: "x", currentPassword: "senha1234" }),
        keyOnly: await call({ merchantKey: "x-segredo", currentPassword: "senha1234" }),
        two: await call({ sopClientId: "s", merchantId: "m", currentPassword: "senha1234" }),
      }
    })
    expect(result.idOnly.status).toBe(409)
    expect(result.idOnly.body.code).toBe("GATEWAY_NOT_READY")
    expect(result.idOnly.body.details).toEqual(["MERCHANT_KEY"])
    expect(result.keyOnly.body.details).toEqual(["MERCHANT_ID"])
    expect(result.two.body.details).toEqual(["MERCHANT_KEY", "SOP_CLIENT_SECRET"]) // ordem estável do contrato
  })
})

test.describe("erros novos do servidor: 429 / 503 / 500 preservam o rascunho; GET 503 mostra o aviso", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("PUT 429, 503 (configuração ilegível) e 500 (auditoria falhou): mensagem certa, rascunho intacto, e dá para salvar depois", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "gateway-falhas@innoelektron.com")
    await openGateway(page)
    const merchantId = page.getByLabel("MerchantId", { exact: true })
    const error = page.getByTestId("save-error")

    await merchantId.fill("ERRO-429")
    await confirmSave(page)
    await expect(error).toHaveAttribute("data-code", "RATE_LIMITED_PAYMENT_GATEWAY")
    await expect(error).toContainText("Muitas alterações em pouco tempo. Aguarde um minuto e tente de novo.")
    await expect(error).toContainText("O que você preencheu continua na tela.")
    await expect(merchantId).toHaveValue("ERRO-429")
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeEnabled()

    await merchantId.fill("ERRO-503")
    await confirmSave(page)
    await expect(error).toHaveAttribute("data-code", "PAYMENT_GATEWAY_UNAVAILABLE")
    await expect(error).toContainText("não conseguiu ler a configuração")
    await expect(error).toContainText("PAYMENT_SECRETS_KEY foi trocada")
    await expect(error).toContainText("Nada foi alterado")
    await expect(error.locator("[data-testid=save-error-missing]")).toHaveCount(0) // não vira lista de pendências
    await expect(merchantId).toHaveValue("ERRO-503")

    await merchantId.fill("ERRO-500")
    await confirmSave(page)
    await expect(error).toHaveAttribute("data-code", "INTERNAL_ERROR")
    await expect(error).toContainText("Não foi possível salvar e nada foi alterado. Tente novamente.")
    await expect(merchantId).toHaveValue("ERRO-500")
    expect(puts).toHaveLength(3)

    // corrigido o valor, o mesmo rascunho salva e o alerta some
    await merchantId.fill("mid-ok-77")
    await confirmSave(page)
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
    await expect(error).toHaveCount(0)
    expect(puts).toHaveLength(4)
  })

  test("GET 503 (configuração ilegível): estado de erro explica a causa, com 'Tentar novamente'", async ({ page }) => {
    await login(page, "gateway-ilegivel@innoelektron.com")
    await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Gateway de pagamento" }).click()
    await expect(page.getByText(/não conseguiu ler a configuração do gateway/)).toBeVisible()
    await expect(page.getByText(/PAYMENT_SECRETS_KEY foi trocada/)).toBeVisible()
    await expect(page.getByRole("button", { name: /Tentar novamente/ })).toBeVisible()
  })
})

test.describe("OPERATOR — sem acesso", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("não vê o item de menu; abrindo a URL recebe 'Acesso restrito' e nenhuma chamada ao gateway sai", async ({ page }) => {
    const gatewayCalls: string[] = []
    page.on("request", (req) => {
      if (req.url().includes("/api/admin/payment-gateway")) gatewayCalls.push(`${req.method()} ${req.url()}`)
    })
    await login(page, "operador@innoelektron.com")
    const nav = page.getByRole("navigation", { name: NAV })
    await expect(nav.getByRole("link", { name: "Pagamentos" })).toBeVisible() // o resto do Financeiro segue lá
    await expect(nav.getByRole("link", { name: "Gateway de pagamento" })).toHaveCount(0)

    await page.goto("/admin/gateway-pagamento")
    await expect(page.getByText("Acesso restrito")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Gateway de pagamento" })).toHaveCount(0)
    expect(gatewayCalls).toEqual([])
  })

  test("ADMIN vê o item no grupo Financeiro, junto de Pagamentos", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    const nav = page.getByRole("navigation", { name: NAV })
    await expect(nav.getByRole("link", { name: "Gateway de pagamento" })).toBeVisible()
  })
})

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  /** O shell do admin é `h-screen overflow-hidden` e só o <main> rola: overflow horizontal tem de ser medido no `main`, não só no documento. */
  async function horizontalOverflow(page: Page) {
    return page.evaluate(() => {
      const main = document.querySelector("main")!
      const stray = Array.from(main.querySelectorAll("*"))
        .filter((el) => {
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return r.width > 0 && style.position !== "fixed" && (r.right > window.innerWidth + 0.5 || r.left < -0.5) && !el.closest("[role=dialog]")
        })
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}[${(el.getAttribute("data-testid") || el.className || "").toString().slice(0, 50)}] right=${Math.round(el.getBoundingClientRect().right)}`)
      return {
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        main: main.scrollWidth - main.clientWidth,
        stray,
      }
    })
  }

  async function boxInsideViewport(page: Page, name: string | RegExp) {
    const dlg = page.getByRole("dialog", { name })
    await expect(dlg).toBeVisible()
    await expect
      .poll(async () => {
        const box = await dlg.boundingBox()
        return box ? [Math.round(box.x) >= 0, Math.round(box.x + box.width) <= 390] : null
      })
      .toEqual([true, true])
  }

  test("sem overflow horizontal em nenhum estado (env, segredo gerado, erro 503/409, diálogos)", async ({ page }) => {
    await login(page, "gateway-sem-chave@innoelektron.com")
    await page.goto("/admin/gateway-pagamento")
    await expect(page.getByRole("heading", { name: "Gateway de pagamento", level: 1 })).toBeVisible()
    expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0, stray: [] })

    // segredo gerado (longo, monoespaçado) + copiar
    await page.getByRole("button", { name: "Informar Segredo do header" }).click()
    await page.getByRole("button", { name: "Gerar segredo aleatório" }).click()
    await expect(page.getByTestId("webhook-secret-generated-note")).toBeVisible()
    expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0, stray: [] })

    // diálogo de resumo cabe
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await boxInsideViewport(page, "Confirmar alterações no gateway")
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click()

    // 503 (lista com variáveis do servidor)
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await submitSaveDialog(page)
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "PAYMENT_SECRETS_KEY_MISSING")
    expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0, stray: [] })

    // diálogo de produção cabe + 409
    await page.getByRole("button", { name: "Descartar" }).click()
    await envOption(page, "Produção").click()
    await boxInsideViewport(page, "Passar para produção?")
    await page.getByRole("dialog").getByLabel(/Para confirmar/).fill("produção")
    await page.getByRole("dialog").getByRole("button", { name: "Selecionar produção" }).click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await submitSaveDialog(page)
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "GATEWAY_NOT_READY")
    expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0, stray: [] })
  })

  test("estados 'pronto' e 'produção' também cabem", async ({ page }) => {
    await login(page, "gateway-producao@innoelektron.com")
    await page.goto("/admin/gateway-pagamento")
    await expect(page.getByTestId("environment-production-banner")).toBeVisible()
    expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0, stray: [] })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// F5.7 — step-up de senha, segredos ilegíveis, sandbox restrito, pagamentos em andamento
// (NADA provado contra o backend real: mocks MSW espelhando o bloco "F5.5" ampliado de `types/api.ts`)
// ---------------------------------------------------------------------------------------------------------------------

const SENHA_ERRADA = "SENHA-ERRADA-Zq9"

test.describe("step-up: senha atual obrigatória em TODO salvar", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("campo obrigatório e mascarado; errada => 'Senha incorreta.' no diálogo, sem deslogar e com o rascunho; certa salva; senha/segredo não vazam", async ({ page }) => {
    const consoleLines = captureConsole(page)
    const puts = capturePuts(page)
    await login(page, "gateway-pronto@innoelektron.com")
    await openGateway(page)

    // rascunho com um segredo e um interruptor
    await page.getByRole("button", { name: "Substituir MerchantKey" }).click()
    await secretInput(page, "merchantKey").fill("SEGREDO-MK-STEPUP-1")
    await page.getByRole("switch", { name: "Habilitar Cartão" }).click()

    await page.getByRole("button", { name: "Salvar alterações" }).click()
    const dialog = page.getByRole("dialog", { name: "Confirmar alterações no gateway" })
    const password = dialog.getByLabel("Sua senha atual")
    const confirm = dialog.getByRole("button", { name: "Confirmar e salvar" })

    // obrigatório, mascarado, e o gerenciador de senhas entende que é a senha ATUAL (não 'nova')
    await expect(password).toBeVisible()
    await expect(password).toHaveAttribute("type", "password")
    await expect(password).toHaveAttribute("autocomplete", "current-password")
    await expect(password).toHaveAttribute("required", "")
    await expect(confirm).toBeDisabled()
    expect(puts).toHaveLength(0)

    // com senha, habilita; apagou, desabilita de novo
    await password.fill("x")
    await expect(confirm).toBeEnabled()
    await password.fill("")
    await expect(confirm).toBeDisabled()

    // ---- senha ERRADA --------------------------------------------------------------------------------------------
    await password.fill(SENHA_ERRADA)
    await confirm.click()
    await expect(dialog.getByText("Senha incorreta.")).toBeVisible()
    await expect(dialog.getByRole("alert").filter({ hasText: "Senha incorreta." })).toBeVisible()
    await expect(password).toBeFocused() // pronto para digitar de novo
    await expect(password).toHaveValue("") // a senha errada não fica no campo
    await expect(password).toHaveAttribute("aria-invalid", "true")
    await expect(confirm).toBeDisabled() // campo vazio de novo
    // NÃO deslogou (403, não 401): mesma rota, sessão viva, rascunho intacto
    await expect(page).toHaveURL(/\/admin\/gateway-pagamento$/)
    expect(await page.evaluate(() => localStorage.getItem("innoelektron_token"))).toBeTruthy()
    await expect(page.getByTestId("save-error")).toHaveCount(0) // o erro vive no diálogo, não vira alerta da página
    expect(puts).toHaveLength(1)
    expect(putPasswords(puts)).toEqual([SENHA_ERRADA])
    expect(await dialog.innerText()).not.toContain(SENHA_ERRADA)

    // o rascunho continua por trás: cancelar mostra segredo e interruptor como estavam
    await dialog.getByRole("button", { name: "Cancelar" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(secretInput(page, "merchantKey")).toHaveValue("SEGREDO-MK-STEPUP-1")
    await expect(page.getByRole("switch", { name: "Habilitar Cartão" })).toHaveAttribute("aria-checked", "true")
    // reabrir o diálogo: nada do erro nem da senha anterior
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await expect(dialog.getByText("Senha incorreta.")).toHaveCount(0)
    await expect(password).toHaveValue("")

    // ---- senha CERTA (Enter envia) -------------------------------------------------------------------------------
    await password.fill(PASSWORD)
    await password.press("Enter")
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
    await expect(dialog).toHaveCount(0)
    expect(puts).toHaveLength(2)
    expect(putPasswords(puts)).toEqual([SENHA_ERRADA, PASSWORD])
    expect(puts[1]).toEqual({ merchantKey: "SEGREDO-MK-STEPUP-1", cardEnabled: true })

    // ---- depois de salvo: nenhuma senha nem segredo no DOM, no localStorage, na URL ou no console -------------------
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    const seen = await everythingTheUserCouldSee(page)
    for (const secret of [PASSWORD, SENHA_ERRADA, "SEGREDO-MK-STEPUP-1"]) expect(seen).not.toContain(secret)
    expect(page.url()).not.toMatch(/senha|SEGREDO/i)
    const consoleText = consoleLines.join("\n")
    for (const secret of [PASSWORD, SENHA_ERRADA, "SEGREDO-MK-STEPUP-1", "currentPassword"]) expect(consoleText).not.toContain(secret)
    // também depois de reabrir o diálogo: o campo nasce vazio
    await page.getByRole("switch", { name: "Habilitar Cartão" }).click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await expect(password).toHaveValue("")
  })

  test("Esc/Cancelar fecham sem enviar e sem lembrar a senha digitada pela metade", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "gateway-pronto@innoelektron.com")
    await openGateway(page)
    await page.getByRole("switch", { name: "Habilitar Cartão" }).click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    const dialog = page.getByRole("dialog", { name: "Confirmar alterações no gateway" })
    await dialog.getByLabel("Sua senha atual").fill("meio-digitada")
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    expect(puts).toHaveLength(0)
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await expect(dialog.getByLabel("Sua senha atual")).toHaveValue("")
  })

  test("o mock exige a senha: PUT sem currentPassword => 400 VALIDATION_ERROR; senha errada => 403 INVALID_CURRENT_PASSWORD e NADA é gravado", async ({ page }) => {
    await login(page, "gateway-pronto@innoelektron.com")
    const result = await page.evaluate(async () => {
      const token = localStorage.getItem("innoelektron_token")
      const call = async (method: string, body?: unknown) => {
        const res = await fetch("/api/admin/payment-gateway", {
          method,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: res.status, body: await res.json() }
      }
      return {
        semSenha: await call("PUT", { cardEnabled: true }),
        errada: await call("PUT", { cardEnabled: true, currentPassword: "nao-e-esta" }),
        depois: await call("GET"),
      }
    })
    expect(result.semSenha.status).toBe(400)
    expect(result.semSenha.body.code).toBe("VALIDATION_ERROR")
    expect(result.errada.status).toBe(403)
    expect(result.errada.body.code).toBe("INVALID_CURRENT_PASSWORD")
    expect(result.depois.body.cardEnabled).toBe(false) // nenhum dos dois gravou
  })
})

/** No celular o menu é uma gaveta: abre a rota direto (o estado do mock é determinístico por conta, então reiniciar não atrapalha). */
async function openGatewayAt(page: Page, width: number) {
  if (width >= 1024) return openGateway(page)
  await page.goto("/admin/gateway-pagamento")
  await expect(page.getByRole("heading", { name: "Gateway de pagamento", level: 1 })).toBeVisible()
}

for (const viewport of [
  { name: "390px", width: 390, height: 844 },
  { name: "1440px", width: 1440, height: 900 },
]) {
  test.describe(`estado do servidor visível na tela (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("segredos ilegíveis: alerta persistente, chips 'Configurada (ilegível)', e reenviar os 3 segredos restabelece", async ({ page }) => {
      const puts = capturePuts(page)
      await login(page, "gateway-ilegivel-segredos@innoelektron.com")
      await openGatewayAt(page, viewport.width)

      const alert = page.getByTestId("secrets-unreadable-alert")
      await expect(alert).toBeVisible()
      await expect(alert).toHaveAttribute("role", "alert")
      await expect(alert).toContainText("O servidor não consegue decifrar os segredos salvos")
      await expect(alert).toContainText("PAYMENT_SECRETS_KEY")
      await expect(alert).toContainText("indisponível (503)")
      await expect(alert).toContainText("Reenvie os 3 segredos — MerchantKey, Client Secret do cadastro de cartão e segredo do webhook")
      // sem sandbox restrito aqui
      await expect(page.getByTestId("sandbox-restricted-banner")).toHaveCount(0)

      for (const field of ["merchantKey", "sopClientSecret", "webhookHeaderSecret"] as const) {
        await expect(page.getByTestId(`secret-${field}-chip`)).toHaveText("Configurada (ilegível)")
      }
      // nenhum chip verde "Configurada" sobrou
      await expect(page.getByTestId("section-credentials").getByText("Configurada", { exact: true })).toHaveCount(0)

      // o alerta continua com um rascunho que NÃO resolve (só mexer num interruptor)
      await page.getByRole("switch", { name: "Habilitar Cartão" }).click()
      await expect(alert).toBeVisible()
      await page.getByRole("button", { name: "Descartar" }).click()

      // reenviar os 3 segredos (MerchantKey e Client Secret digitados, webhook gerado) restabelece
      await page.getByRole("button", { name: "Substituir MerchantKey" }).click()
      await secretInput(page, "merchantKey").fill("nova-merchant-key-1")
      await page.getByRole("button", { name: "Substituir Client Secret do cadastro de cartão" }).click()
      await secretInput(page, "sopClientSecret").fill("novo-client-secret-1")
      await page.getByRole("button", { name: "Substituir Segredo do header" }).click()
      await page.getByRole("button", { name: "Gerar segredo aleatório" }).click()
      await confirmSave(page)
      await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
      expect(Object.keys(puts[0]).sort()).toEqual(["merchantKey", "sopClientSecret", "webhookHeaderSecret"])
      await expect(alert).toHaveCount(0)
      for (const field of ["merchantKey", "sopClientSecret", "webhookHeaderSecret"] as const) {
        await expect(page.getByTestId(`secret-${field}-chip`)).toHaveText("Configurada")
      }
    })

    test("estados saudáveis NÃO mostram o alerta de ilegível nem a faixa de sandbox (pronto)", async ({ page }) => {
      await login(page, "gateway-pronto@innoelektron.com")
      await openGatewayAt(page, viewport.width)
      await expect(page.getByTestId("secret-merchantKey-chip")).toHaveText("Configurada")
      await expect(page.getByTestId("secrets-unreadable-alert")).toHaveCount(0)
      await expect(page.getByTestId("sandbox-restricted-banner")).toHaveCount(0)
    })

    test("origem env (secretsDecryptable null): nada de alerta de ilegível; segredos 'Não configurada'", async ({ page }) => {
      await login(page, "admin@innoelektron.com")
      await openGatewayAt(page, viewport.width)
      await expect(page.getByTestId("secrets-unreadable-alert")).toHaveCount(0)
      await expect(page.getByTestId("secret-merchantKey-chip")).toHaveText("Não configurada")
    })

    test("sandbox em servidor de produção: faixa permanente de aviso, sem overflow", async ({ page }) => {
      await login(page, "gateway-sandbox-publico@innoelektron.com")
      await openGatewayAt(page, viewport.width)

      const banner = page.getByTestId("sandbox-restricted-banner")
      await expect(banner).toBeVisible()
      await expect(banner).toContainText("Ambiente SANDBOX em servidor de produção")
      await expect(banner).toContainText("PAYMENT_SANDBOX_TESTER_EMAILS")
      await expect(banner).toContainText("EasyPanel")
      await expect(banner).toContainText("Os outros motoristas veem")
      await expect(banner).toContainText("indisponível no momento")
      await expect(page.getByTestId("secrets-unreadable-alert")).toHaveCount(0)

      // permanente: continua com rascunho
      await page.getByRole("switch", { name: "Habilitar Cartão" }).click()
      await expect(banner).toBeVisible()

      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main") as HTMLElement
        return { document: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main.scrollWidth - main.clientWidth }
      })
      expect(overflow).toEqual({ document: 0, main: 0 })
    })

    test("ir para produção com pagamentos em andamento: 409 com N; rascunho mantido; só trocar de interruptor ainda salva", async ({ page }) => {
      const puts = capturePuts(page)
      await login(page, "gateway-em-andamento@innoelektron.com")
      await openGatewayAt(page, viewport.width)
      await envOption(page, "Produção").click()
      const prodDialog = page.getByRole("dialog", { name: "Passar para produção?" })
      await prodDialog.getByLabel(/Para confirmar, digite PRODUÇÃO/).fill("PRODUÇÃO")
      await prodDialog.getByRole("button", { name: "Selecionar produção" }).click()
      await confirmSave(page)

      const error = page.getByTestId("save-error")
      await expect(error).toHaveAttribute("data-code", "GATEWAY_HAS_INFLIGHT_PAYMENTS")
      await expect(error).toContainText("Há 3 pagamentos em andamento neste ambiente. Aguarde liquidarem para trocar o ambiente.")
      await expect(error).toContainText("O que você preencheu continua na tela.")
      await expect(page.getByTestId("environment-production-banner")).toContainText("ainda não salva")
      expect(puts).toEqual([{ environment: "production", confirmProduction: true }])
      expect(putPasswords(puts)).toEqual([PASSWORD])

      // continua em sandbox no servidor: descartar e mexer só num interruptor (não é troca de ambiente) funciona
      await page.getByRole("button", { name: "Descartar" }).click()
      await page.getByRole("switch", { name: "Habilitar Cartão" }).click()
      await confirmSave(page)
      await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
    })
  })
}

test.describe("diálogo de salvar com senha (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("cabe na tela com o campo de senha e o erro; botões acessíveis", async ({ page }) => {
    await login(page, "gateway-pronto@innoelektron.com")
    await page.goto("/admin/gateway-pagamento")
    await page.getByRole("switch", { name: "Habilitar Cartão" }).click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    const dialog = page.getByRole("dialog", { name: "Confirmar alterações no gateway" })
    await dialog.getByLabel("Sua senha atual").fill(SENHA_ERRADA)
    await dialog.getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(dialog.getByText("Senha incorreta.")).toBeVisible()
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox()
        return box ? [Math.round(box.x) >= 0, Math.round(box.x + box.width) <= 390, Math.round(box.y + box.height) <= 844] : null
      })
      .toEqual([true, true, true])
    await expect(dialog.getByRole("button", { name: "Confirmar e salvar" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Cancelar" })).toBeVisible()
  })
})
