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

function captureConsole(page: Page) {
  const lines: string[] = []
  page.on("console", (msg) => lines.push(msg.text()))
  page.on("pageerror", (err) => lines.push(String(err)))
  return lines
}

function capturePuts(page: Page) {
  const bodies: Array<Record<string, unknown>> = []
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/api/admin/payment-gateway")) bodies.push(JSON.parse(req.postData() ?? "{}"))
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
    await expect(page.getByTestId("source-banner-env")).toContainText("Ao salvar, passa a valer o que for salvo aqui")
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
    await summaryDialog.getByRole("button", { name: "Confirmar e salvar" }).click()
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
    await summaryDialog.getByRole("button", { name: "Confirmar e salvar" }).click()
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
    await summaryDialog.getByRole("button", { name: "Confirmar e salvar" }).click()
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

  test("segredo do webhook com menos de 8 caracteres: erro no campo e salvar bloqueado", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openGateway(page)
    await page.getByRole("button", { name: "Informar Segredo do header" }).click()
    await secretInput(page, "webhookHeaderSecret").fill("curto")
    await expect(page.getByText("O segredo precisa ter pelo menos 8 caracteres.")).toBeVisible()
    await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeDisabled()
    await secretInput(page, "webhookHeaderSecret").fill("longo-o-bastante")
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
    await page.getByRole("dialog", { name: "Confirmar alterações no gateway" }).getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()
    expect(puts).toEqual([{ pixEnabled: false }])
  })

  test("habilitar o cartão (pronto) salva sem pedir produção", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "gateway-pronto@innoelektron.com")
    await openGateway(page)
    await page.getByRole("switch", { name: "Habilitar Cartão" }).click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await page.getByRole("dialog", { name: "Confirmar alterações no gateway" }).getByRole("button", { name: "Confirmar e salvar" }).click()
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
    await page.getByRole("dialog", { name: "Confirmar alterações no gateway" }).getByRole("button", { name: "Confirmar e salvar" }).click()
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

    // 503: enviar um segredo
    await page.getByRole("button", { name: "Informar MerchantKey" }).click()
    await secretInput(page, "merchantKey").fill("SEGREDO-SEM-CHAVE-77")
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await page.getByRole("dialog", { name: "Confirmar alterações no gateway" }).getByRole("button", { name: "Confirmar e salvar" }).click()
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

    // Descarta o segredo; salvar SÓ o MerchantId (não é segredo) funciona
    await page.getByRole("button", { name: "Descartar" }).click()
    await expect(page.getByTestId("save-error")).toHaveCount(0)
    await page.getByLabel("MerchantId", { exact: true }).fill("mid-sem-segredo")
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await page.getByRole("dialog", { name: "Confirmar alterações no gateway" }).getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByText("Configuração do gateway salva.")).toBeVisible()

    // 409: ir para produção com o Pix habilitado e sem pré-requisitos
    await envOption(page, "Produção").click()
    const prodDialog = page.getByRole("dialog", { name: "Passar para produção?" })
    await prodDialog.getByLabel(/Para confirmar, digite PRODUÇÃO/).fill("Produção")
    await prodDialog.getByRole("button", { name: "Selecionar produção" }).click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await page.getByRole("dialog", { name: "Confirmar alterações no gateway" }).getByRole("button", { name: "Confirmar e salvar" }).click()
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
    await page.getByRole("dialog").getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "PAYMENT_SECRETS_KEY_MISSING")
    expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0, stray: [] })

    // diálogo de produção cabe + 409
    await page.getByRole("button", { name: "Descartar" }).click()
    await envOption(page, "Produção").click()
    await boxInsideViewport(page, "Passar para produção?")
    await page.getByRole("dialog").getByLabel(/Para confirmar/).fill("produção")
    await page.getByRole("dialog").getByRole("button", { name: "Selecionar produção" }).click()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Confirmar e salvar" }).click()
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
