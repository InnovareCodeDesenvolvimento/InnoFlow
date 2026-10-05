import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → Comunicação (N-7: e-mail SMTP + WhatsApp Evolution), contra os mocks MSW (`src/mocks/communicationData.ts` + `handlers.ts`).
 * NADA aqui foi provado contra o backend real. O estado do mock vive por conta de ADMIN e na memória da PÁGINA (um `page.goto` zera tudo), então cada teste usa UMA
 * navegação real (login) e o resto é clique na SPA.
 *
 * Contas (ver o cabeçalho de `communicationData.ts`):
 *  admin@                       -> env: e-mail do ambiente (funcionando), WhatsApp sem configuração
 *  comunicacao-pronta@          -> database: e-mail e WhatsApp ligados e funcionando
 *  comunicacao-vazia@           -> env, nada configurado
 *  comunicacao-sem-chave@       -> servidor sem PAYMENT_SECRETS_KEY
 *  comunicacao-ilegivel@        -> segredos salvos que não decifram
 *  comunicacao-indisponivel@    -> o GET responde 503
 *  comunicacao-rede-privada@    -> privateHostsAllowed
 *
 * Segredos digitados usam marcadores únicos (SEGREDO-...) para provar que NENHUM vaza para o DOM, o resumo, o console ou o localStorage.
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

async function openPage(page: Page) {
  await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Comunicação" }).click()
  await expect(page).toHaveURL(/\/admin\/comunicacao$/)
  await expect(page.getByRole("heading", { name: "Comunicação", level: 1 })).toBeVisible()
}

async function everythingTheUserCouldSee(page: Page): Promise<string> {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input,textarea")).map((el) => (el as HTMLInputElement).value)
    return [document.body.innerText, ...inputs, JSON.stringify({ ...localStorage }), location.href].join("\n")
  })
}

function captureConsole(page: Page) {
  const lines: string[] = []
  page.on("console", (msg) => lines.push(msg.text()))
  page.on("pageerror", (err) => lines.push(String(err)))
  return lines
}

/** Corpos dos PUTs SEM a senha atual (que vai para `putPasswords`, em paralelo, para provar que TODO PUT a carregou). */
const passwordsByPuts = new WeakMap<object, unknown[]>()
const putPasswords = (puts: object) => passwordsByPuts.get(puts) ?? []
function capturePuts(page: Page) {
  const bodies: Array<Record<string, unknown>> = []
  const passwords: unknown[] = []
  passwordsByPuts.set(bodies, passwords)
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/api/admin/communication-settings")) {
      const { currentPassword, ...rest } = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>
      passwords.push(currentPassword)
      bodies.push(rest)
    }
  })
  return bodies
}

/** Corpos dos testes (POST test-email / test-whatsapp). */
function captureTests(page: Page) {
  const bodies: Array<{ channel: string; body: Record<string, unknown> }> = []
  page.on("request", (req) => {
    const m = /communication-settings\/test-(email|whatsapp)$/.exec(req.url())
    if (req.method() === "POST" && m) bodies.push({ channel: m[1], body: JSON.parse(req.postData() ?? "{}") as Record<string, unknown> })
  })
  return bodies
}

const main = (page: Page) => page.locator("main")
const dialog = (page: Page) => page.getByRole("dialog", { name: "Confirmar alterações na comunicação" })
const saveButton = (page: Page) => page.getByRole("button", { name: "Salvar alterações" })

async function submitSaveDialog(page: Page, password: string = PASSWORD) {
  await dialog(page).getByLabel("Sua senha atual").fill(password)
  await dialog(page).getByRole("button", { name: "Confirmar e salvar" }).click()
}

test.describe("acesso", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("ADMIN vê Comunicação no menu (grupo Rede) e abre a tela com as 3 seções (h2)", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await expect(page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Comunicação" })).toBeVisible()
    await openPage(page)
    await expect(page.locator("h1")).toHaveCount(1)
    await expect(page.getByTestId("section-email").getByRole("heading", { level: 2, name: "E-mail (SMTP)" })).toBeVisible()
    await expect(page.getByTestId("section-whatsapp").getByRole("heading", { level: 2, name: "WhatsApp (Evolution API)" })).toBeVisible()
    await expect(page.getByTestId("section-alerts").getByRole("heading", { level: 2, name: "Alertas" })).toBeVisible()
  })

  test("OPERATOR não vê o item no menu e a rota mostra \"Acesso restrito\"", async ({ page }) => {
    await login(page, "operador@innoelektron.com")
    await expect(page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Comunicação" })).toHaveCount(0)
    await page.goto("/admin/comunicacao")
    await expect(page.getByRole("heading", { level: 1, name: "Acesso restrito" })).toBeVisible()
  })
})

test.describe("leitura: origem env e origem database", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("origem env (admin@): banner, e-mail do ambiente funcionando, WhatsApp sem configuração, nenhum campo de senha aberto, salvar bloqueado", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("source-banner-env")).toContainText("Usando as variáveis do servidor")
    await expect(page.getByTestId("email-source")).toHaveText("Vem do servidor (env)")
    await expect(page.getByTestId("email-status")).toHaveText("Funcionando")
    await expect(page.getByTestId("whatsapp-source")).toHaveText("Não configurado")
    await expect(page.getByTestId("whatsapp-status")).toHaveText("Desligado")
    await expect(page.getByTestId("email-host")).toHaveValue("smtp.env.exemplo.com.br")
    await expect(page.getByTestId("secret-smtpPassword")).toContainText("Configurada")
    await expect(page.getByTestId("secret-evolutionApiKey")).toContainText("Não configurada")
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    await expect(saveButton(page)).toBeDisabled()
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
    await expect(page.getByTestId("save-bar-propagation")).toContainText("em até 1 minuto")
    await expect(page.getByTestId("alerts-globalMinSeverity")).toHaveText("Informativo")
    await expect(page.getByTestId("alerts-maxPerHour")).toHaveText("20")
  })

  test("origem database (pronta@): banner com data, estado dos dois canais, apikey com dica dos 4 últimos, segredos fora do DOM", async ({ page }) => {
    const consoleLines = captureConsole(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("source-banner-database")).toContainText("Configuração salva nesta tela")
    await expect(page.getByTestId("email-source")).toHaveText("Configurado no painel")
    await expect(page.getByTestId("email-status")).toHaveText("Funcionando")
    await expect(page.getByTestId("whatsapp-status")).toHaveText("Funcionando")
    await expect(page.getByTestId("secret-evolutionApiKey")).toContainText("Configurada")
    await expect(page.getByTestId("secret-evolutionApiKey-note")).toHaveText("…a1b2")
    await expect(page.getByTestId("email-recipients")).toHaveValue("dono@innoflow.example\nfinanceiro@innoflow.example")
    await expect(page.getByTestId("whatsapp-recipients")).toHaveValue("5511999999999")
    await expect(page.getByTestId("alerts-dedupeMinutes")).toHaveValue("45")
    await expect(page.getByTestId("email-minSeverity")).toHaveValue("IMPORTANTE")
    await expect(page.getByTestId("whatsapp-minSeverity")).toHaveValue("CRITICO")
    await expect(page.getByRole("switch", { name: "Ligar o e-mail" })).toHaveAttribute("aria-checked", "true")
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    expect(consoleLines.filter((l) => /smtp|apikey|senha/i.test(l) && /SEGREDO/.test(l))).toEqual([])
  })

  test("segredos ilegíveis (ilegivel@): alerta permanente, chips em perigo, canais com problema e avisos do servidor", async ({ page }) => {
    await login(page, "comunicacao-ilegivel@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("secrets-unreadable-alert")).toContainText("Segredos salvos ilegíveis")
    await expect(page.getByTestId("secret-smtpPassword-chip")).toHaveText("Configurada (ilegível)")
    await expect(page.getByTestId("secret-evolutionApiKey-chip")).toHaveText("Configurada (ilegível)")
    await expect(page.getByTestId("email-status")).toHaveText("Com problema")
    await expect(page.getByTestId("warnings-alert")).toContainText("não pode ser lida")
  })

  test("servidor sem chave de cifragem (sem-chave@): alerta; digitar segredo é erro de campo e bloqueia salvar", async ({ page }) => {
    await login(page, "comunicacao-sem-chave@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("secrets-key-missing-alert")).toContainText("PAYMENT_SECRETS_KEY")
    await page.getByRole("button", { name: "Informar Senha SMTP" }).click()
    await page.getByTestId("secret-smtpPassword").locator("input").fill("SEGREDO-SEM-CHAVE")
    await expect(page.getByTestId("secret-smtpPassword")).toContainText("não dá para guardar este segredo")
    await expect(saveButton(page)).toBeDisabled()
    await expect(page.getByTestId("save-bar-errors")).toBeVisible()
  })

  test("rede privada liberada pelo deploy (rede-privada@): nota informativa", async ({ page }) => {
    await login(page, "comunicacao-rede-privada@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("private-hosts-note")).toBeVisible()
  })

  test("GET 503 (indisponivel@): estado de erro com tentar de novo, sem formulário", async ({ page }) => {
    await login(page, "comunicacao-indisponivel@innoelektron.com")
    await openPage(page)
    await expect(page.getByText("O servidor não conseguiu ler a configuração de comunicação")).toBeVisible()
    await expect(page.getByRole("button", { name: /tentar/i })).toBeVisible()
    await expect(page.getByTestId("section-email")).toHaveCount(0)
  })
})

test.describe("salvar: e-mail", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("trocar o servidor EXIGE digitar a senha de novo; salvar manda só o diff, com step-up; senha errada fica no diálogo; nenhum segredo vaza", async ({ page }) => {
    const consoleLines = captureConsole(page)
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)

    await page.getByTestId("email-host").fill("smtp.novo.exemplo.com")
    await expect(page.getByTestId("secret-smtpPassword")).toContainText("digite a senha SMTP de novo")
    await expect(page.getByTestId("save-bar-status")).toContainText("1 alteração não salva")
    await expect(page.getByTestId("save-bar-errors")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()

    await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
    const secret = page.getByTestId("secret-smtpPassword").locator("input")
    await expect(secret).toHaveValue("") // nunca pré-preenchido
    await secret.fill("SEGREDO-SMTP-123")
    await expect(saveButton(page)).toBeEnabled()
    await expect(page.getByTestId("save-bar-status")).toContainText("2 alterações não salvas")

    await saveButton(page).click()
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByTestId("save-summary")).toContainText("smtp.innoflow.example")
    await expect(dialog(page).getByTestId("save-summary")).toContainText("smtp.novo.exemplo.com")
    await expect(dialog(page).getByTestId("save-summary")).toContainText("Será substituída")
    expect(await dialog(page).innerText()).not.toContain("SEGREDO-SMTP-123")

    // senha errada: o diálogo fica aberto com o erro, o rascunho continua
    await submitSaveDialog(page, "senha-errada")
    await expect(dialog(page).getByText("Senha incorreta.")).toBeVisible()
    await expect(dialog(page).getByLabel("Sua senha atual")).toHaveValue("")
    await expect(dialog(page).getByLabel("Sua senha atual")).toBeFocused()

    await submitSaveDialog(page)
    await expect(page.getByText("Configuração de comunicação salva.")).toBeVisible()
    await expect(dialog(page)).toBeHidden()
    expect(puts).toEqual([{ email: { host: "smtp.novo.exemplo.com", password: "SEGREDO-SMTP-123" } }, { email: { host: "smtp.novo.exemplo.com", password: "SEGREDO-SMTP-123" } }])
    expect(putPasswords(puts)).toEqual(["senha-errada", PASSWORD])

    // depois de salvar: rascunho zerado, host novo vindo do servidor, segredo morreu
    await expect(page.getByTestId("email-host")).toHaveValue("smtp.novo.exemplo.com")
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    const seen = await everythingTheUserCouldSee(page)
    expect(seen).not.toContain("SEGREDO-SMTP-123")
    expect(consoleLines.join("\n")).not.toContain("SEGREDO-SMTP-123")
    expect(consoleLines.join("\n")).not.toContain(PASSWORD)
  })

  test("destinatários e severidade: lista inteira substitui; resumo mostra só contagem (não os e-mails)", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await page.getByTestId("email-recipients").fill("novo@innoflow.example\noutro@innoflow.example, terceiro@innoflow.example")
    await page.getByTestId("email-minSeverity").selectOption("CRITICO")
    await saveButton(page).click()
    const summary = dialog(page).getByTestId("save-summary")
    await expect(summary).toContainText("2 destinatários")
    await expect(summary).toContainText("3 destinatários")
    expect(await summary.innerText()).not.toContain("novo@innoflow.example")
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração de comunicação salva.")).toBeVisible()
    expect(puts).toEqual([{ email: { recipients: ["novo@innoflow.example", "outro@innoflow.example", "terceiro@innoflow.example"], minSeverity: "CRITICO" } }])
  })

  test("campos inválidos: erro no campo e na barra, salvar bloqueado; descartar limpa tudo", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await page.getByTestId("email-host").fill("https://smtp.x.com")
    await page.getByTestId("email-port").fill("70000")
    await page.getByTestId("email-recipients").fill("isto-nao-e-email")
    await expect(main(page).getByText("Informe só o endereço")).toBeVisible()
    await expect(main(page).getByText("Porta de 1 a 65535")).toBeVisible()
    await expect(main(page).getByText("E-mail inválido")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()
    await page.getByRole("button", { name: "Descartar" }).click()
    await expect(page.getByTestId("email-host")).toHaveValue("smtp.innoflow.example")
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
  })

  test("apagar a senha salva: marca, desfaz, e envia `clearSecrets` (sem valor de segredo)", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await page.getByRole("button", { name: "Apagar a senha SMTP salva" }).click()
    await expect(page.getByTestId("secret-smtpPassword-chip")).toHaveText("Será apagada ao salvar")
    await expect(page.getByTestId("save-bar-status")).toContainText("1 alteração não salva")
    await page.getByTestId("secret-smtpPassword").getByRole("button", { name: "Desfazer" }).click()
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
    await page.getByRole("button", { name: "Apagar a senha SMTP salva" }).click()
    await saveButton(page).click()
    await expect(dialog(page).getByTestId("save-summary")).toContainText("Será apagada")
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração de comunicação salva.")).toBeVisible()
    expect(puts).toEqual([{ clearSecrets: ["smtpPassword"] }])
    await expect(page.getByTestId("secret-smtpPassword-chip")).toHaveText("Não configurada")
  })

  test("canal que vem do env: salvar outra coisa leva `enabled` explícito (a 1ª gravação não pode desligar o canal)", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "admin@innoelektron.com")
    await openPage(page)
    await page.getByTestId("email-fromName").fill("Novo nome")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração de comunicação salva.")).toBeVisible()
    expect(puts).toEqual([{ email: { fromName: "Novo nome", enabled: true } }])
    await expect(page.getByTestId("email-status")).toHaveText("Funcionando")
    await expect(page.getByTestId("source-banner-database")).toBeVisible()
  })

  test("janela de repetição: valor inválido bloqueia; válido vai; em branco volta ao padrão", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await page.getByTestId("alerts-dedupeMinutes").fill("2000")
    await expect(main(page).getByText("Informe de 1 a 1440 minutos.")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()
    await page.getByTestId("alerts-dedupeMinutes").fill("")
    await saveButton(page).click()
    await expect(dialog(page).getByTestId("save-summary")).toContainText("Padrão do servidor")
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração de comunicação salva.")).toBeVisible()
    expect(puts).toEqual([{ alerts: { dedupeMinutes: null } }])
  })
})

test.describe("salvar: WhatsApp e regras do servidor", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("nada configurado: ligar sem estar completo -> 409 com pendências e rascunho mantido; completar e ligar funciona (a 1ª gravação sem `enabled` nasceria desligada)", async ({ page }) => {
    const consoleLines = captureConsole(page)
    const puts = capturePuts(page)
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("whatsapp-source")).toHaveText("Não configurado")

    await page.getByTestId("whatsapp-baseUrl").fill("https://evolution.exemplo.com.br")
    await page.getByTestId("whatsapp-instance").fill("innoflow")
    await page.getByRole("switch", { name: "Ligar o WhatsApp" }).click()
    await saveButton(page).click()
    await submitSaveDialog(page)

    // 409 CHANNEL_INCOMPLETE: nada foi gravado; faltam apikey e número
    const err = page.getByTestId("save-error")
    await expect(err).toBeVisible()
    await expect(err).toHaveAttribute("data-code", "CHANNEL_INCOMPLETE")
    await expect(err).toContainText("Não dá para ligar o canal de WhatsApp")
    await expect(err).toContainText("Nada foi salvo")
    await expect(page.getByTestId("save-error-problems")).toContainText("apikey")
    await expect(page.getByTestId("save-error-problems")).toContainText("número de destino")
    await expect(err).toContainText("O que você preencheu continua na tela.")
    await expect(page.getByTestId("whatsapp-baseUrl")).toHaveValue("https://evolution.exemplo.com.br")
    await expect(page.getByTestId("whatsapp-status")).toHaveText("Desligado")

    // completa
    await page.getByRole("button", { name: "Informar Apikey da Evolution" }).click()
    await page.getByTestId("secret-evolutionApiKey").locator("input").fill("SEGREDO-APIKEY-wxyz")
    await page.getByTestId("whatsapp-recipients").fill("+55 (11) 99999-8888")
    await saveButton(page).click()
    await expect(dialog(page).getByTestId("save-summary")).toContainText("Será substituída")
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração de comunicação salva.")).toBeVisible()

    expect(puts).toHaveLength(2)
    expect(puts[1]).toEqual({
      whatsapp: { enabled: true, baseUrl: "https://evolution.exemplo.com.br", instance: "innoflow", apiKey: "SEGREDO-APIKEY-wxyz", recipients: ["5511999998888"] },
    })
    await expect(page.getByTestId("whatsapp-status")).toHaveText("Funcionando")
    await expect(page.getByTestId("secret-evolutionApiKey-note")).toHaveText("…wxyz")
    await expect(page.getByTestId("whatsapp-recipients")).toHaveValue("5511999998888")
    const seen = await everythingTheUserCouldSee(page)
    expect(seen).not.toContain("SEGREDO-APIKEY-wxyz")
    expect(consoleLines.join("\n")).not.toContain("SEGREDO-APIKEY-wxyz")
  })

  test("1ª gravação sem tocar no interruptor nasce DESLIGADA", async ({ page }) => {
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openPage(page)
    await page.getByTestId("whatsapp-baseUrl").fill("https://evolution.exemplo.com.br")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração de comunicação salva.")).toBeVisible()
    await expect(page.getByTestId("whatsapp-source")).toHaveText("Configurado no painel")
    await expect(page.getByTestId("whatsapp-status")).toHaveText("Desligado")
  })

  test("destino de rede interna (SSRF): explicado em linguagem simples, aponta o campo, nada é gravado", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await page.getByTestId("email-host").fill("10.0.0.5")
    await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
    await page.getByTestId("secret-smtpPassword").locator("input").fill("SEGREDO-X")
    await saveButton(page).click()
    await submitSaveDialog(page)
    const err = page.getByTestId("save-error")
    await expect(err).toHaveAttribute("data-code", "DESTINATION_NOT_ALLOWED")
    await expect(err).toContainText("Endereço interno não é permitido em produção")
    await expect(err).toContainText("endereço público")
    await expect(page.getByTestId("section-email").getByText("Endereço interno não é permitido em produção").first()).toBeVisible()
    // editar o campo limpa o erro do servidor
    await page.getByTestId("email-host").fill("smtp.publico.exemplo.com")
    await expect(page.getByTestId("section-email").getByText("Endereço interno não é permitido em produção")).toHaveCount(0)
  })

  test("URL http:// da Evolution: HTTPS exigido em produção", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await page.getByTestId("whatsapp-baseUrl").fill("http://evolution.exemplo.com.br")
    await page.getByRole("button", { name: "Substituir Apikey da Evolution" }).click()
    await page.getByTestId("secret-evolutionApiKey").locator("input").fill("SEGREDO-Y")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByTestId("save-error")).toContainText("https://")
  })

  test("rede privada liberada pelo deploy: o mesmo endereço interno É aceito", async ({ page }) => {
    await login(page, "comunicacao-rede-privada@innoelektron.com")
    await openPage(page)
    await page.getByTestId("email-host").fill("10.0.0.5")
    await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
    await page.getByTestId("secret-smtpPassword").locator("input").fill("SEGREDO-X")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração de comunicação salva.")).toBeVisible()
  })

  test("erros do servidor por code: 429 do limite, 503 do banco, 500, step-up 503 e step-up 429 — rascunho mantido, mensagens nossas", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)

    const tryHost = async (host: string, password = PASSWORD) => {
      await page.getByTestId("email-host").fill(host)
      // depois de um erro o rascunho (inclusive o campo de senha aberto) continua: só abre o campo na 1ª vez
      const input = page.getByTestId("secret-smtpPassword").locator("input")
      if ((await input.count()) === 0) await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
      await input.fill("SEGREDO-Z")
      await saveButton(page).click()
      await submitSaveDialog(page, password)
    }

    await tryHost("limite.exemplo.com")
    await expect(page.getByTestId("save-error")).toContainText("Muitas alterações ou testes em pouco tempo")
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "RATE_LIMITED_COMMUNICATION_SETTINGS")
    await expect(page.getByTestId("save-error")).toContainText("O que você preencheu continua na tela.")

    await tryHost("indisponivel.exemplo.com")
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "COMMUNICATION_SETTINGS_UNAVAILABLE")
    await expect(page.getByTestId("save-error")).toContainText("não conseguiu ler a configuração")

    await tryHost("erro500.exemplo.com")
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "INTERNAL_ERROR")

    // a senha SMTP digitada continua no rascunho (campo aberto): só a senha ATUAL é pedida de novo
    await tryHost("smtp.ok.exemplo.com", "stepup-503")
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "STEPUP_UNAVAILABLE")
    await expect(page.getByTestId("save-error")).toContainText("Nada foi salvo")

    await tryHost("smtp.ok.exemplo.com", "stepup-429")
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "RATE_LIMITED_PAYMENT_GATEWAY")
    await expect(page.getByTestId("save-error")).toContainText("Muitas tentativas de senha")
    await expect(page.getByTestId("email-host")).toHaveValue("smtp.ok.exemplo.com")
  })

  test("503 SECRETS_KEY_MISSING e 400 de segredo obrigatório: mensagens próprias (provadas pelo mock via fetch, o cliente já barra os dois antes)", async ({ page }) => {
    await login(page, "comunicacao-sem-chave@innoelektron.com")
    const call = (body: unknown) =>
      page.evaluate(async (b) => {
        const token = localStorage.getItem("innoelektron_token")
        const res = await fetch("/api/admin/communication-settings", { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(b) })
        return { status: res.status, body: (await res.json()) as { code?: string } }
      }, body)
    const r = await call({ email: { password: "x" }, currentPassword: PASSWORD })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe("SECRETS_KEY_MISSING")
  })
})

test.describe("testes de canal", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("e-mail: sem alteração testa a config SALVA, mostra destino mascarado, e nada fica na mutation", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("email-test-unsaved-note")).toHaveCount(0)
    await page.getByRole("button", { name: "Enviar e-mail de teste" }).click()
    const result = page.getByTestId("email-test-result")
    await expect(result).toHaveAttribute("data-ok", "true")
    await expect(result).toContainText("Teste enviado com sucesso")
    await expect(result).toContainText("d***@innoflow.example")
    expect(tests).toEqual([{ channel: "email", body: { to: "dono@innoflow.example" } }])
    // o botão nunca grava nada: continua sem alteração pendente
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
  })

  test("e-mail: com valores digitados e não salvos manda `config` (valores efetivos) e a senha só se foi digitada", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await page.getByTestId("email-host").fill("smtp.teste.exemplo.com")
    await expect(page.getByTestId("email-test-unsaved-note")).toBeVisible()

    // sem a senha de novo: bloqueado no cliente, nada é enviado
    await page.getByRole("button", { name: "Enviar e-mail de teste" }).click()
    await expect(page.getByTestId("secret-smtpPassword")).toContainText("digite a senha SMTP de novo")
    expect(tests).toHaveLength(0)

    await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
    await page.getByTestId("secret-smtpPassword").locator("input").fill("SEGREDO-TESTE-123")
    await page.getByTestId("email-test-to").fill("outro@exemplo.com")
    await page.getByRole("button", { name: "Enviar e-mail de teste" }).click()
    await expect(page.getByTestId("email-test-result")).toHaveAttribute("data-ok", "true")
    expect(tests).toEqual([
      {
        channel: "email",
        body: {
          to: "outro@exemplo.com",
          config: { host: "smtp.teste.exemplo.com", port: 587, secure: false, user: "alertas@innoflow.example", fromName: "InnoFlow", fromAddress: "alertas@innoflow.example", password: "SEGREDO-TESTE-123" },
        },
      },
    ])
    // o teste não gravou: continua com 2 alterações pendentes e o segredo só no campo (nunca na tela como texto)
    await expect(page.getByTestId("save-bar-status")).toContainText("2 alterações não salvas")
    expect(await page.locator("main").innerText()).not.toContain("SEGREDO-TESTE-123")
  })

  const FALHAS: Array<[string, "email" | "whatsapp", string]> = [
    ["SMTP_AUTH_FAILED", "email", "recusou o usuário ou a senha"],
    ["SMTP_CONNECTION_FAILED", "email", "Não foi possível conectar ao servidor de e-mail"],
    ["TIMEOUT", "email", "demorou demais"],
    ["WHATSAPP_AUTH_FAILED", "whatsapp", "recusou a apikey"],
    ["WHATSAPP_INSTANCE_OR_URL_NOT_FOUND", "whatsapp", "não encontrada"],
    ["DESTINATION_BLOCKED", "whatsapp", "Endereço interno não é permitido"],
  ]
  for (const [code, channel, texto] of FALHAS) {
    test(`resultado de falha ${code}: texto por code (não o do servidor), sem segredo`, async ({ page }) => {
      await login(page, "comunicacao-pronta@innoelektron.com")
      await page.evaluate((c) => localStorage.setItem("mock:comunicacao-teste", c), code)
      await openPage(page)
      await page.getByRole("button", { name: channel === "email" ? "Enviar e-mail de teste" : "Enviar WhatsApp de teste" }).click()
      const result = page.getByTestId(`${channel}-test-result`)
      await expect(result).toHaveAttribute("data-ok", "false")
      await expect(result).toHaveAttribute("data-code", code)
      await expect(result).toContainText(texto)
      await expect(result).not.toContainText("mock:")
      await expect(result).toContainText(`Código: ${code}`)
    })
  }

  test("WhatsApp: ok com número mascarado; número com máscara digitado vai só com dígitos", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await page.getByTestId("whatsapp-test-to").fill("+55 (21) 98888-7777")
    await page.getByRole("button", { name: "Enviar WhatsApp de teste" }).click()
    await expect(page.getByTestId("whatsapp-test-result")).toContainText("5521*****7777")
    expect(tests).toEqual([{ channel: "whatsapp", body: { to: "5521988887777" } }])
  })

  test("destino de teste inválido e canal sem destinatário: erro no campo, nada enviado", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openPage(page)
    await page.getByRole("button", { name: "Enviar e-mail de teste" }).click()
    await expect(page.getByTestId("email-test").getByText(/Informe o e-mail que vai receber o teste/)).toBeVisible()
    await page.getByTestId("email-test-to").fill("nao-e-email")
    await page.getByRole("button", { name: "Enviar e-mail de teste" }).click()
    await expect(page.getByTestId("email-test").getByText("E-mail de destino inválido.")).toBeVisible()
    expect(tests).toHaveLength(0)
  })

  test("canal sem configuração, com destino: o servidor responde ok:false INVALID_CONFIGURATION (é resultado do teste, não erro da tela)", async ({ page }) => {
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openPage(page)
    await page.getByTestId("email-test-to").fill("dono@exemplo.com")
    await page.getByRole("button", { name: "Enviar e-mail de teste" }).click()
    await expect(page.getByTestId("email-test-result")).toHaveAttribute("data-code", "INVALID_CONFIGURATION")
    await expect(page.getByTestId("email-test-result")).toContainText("configuração está incompleta")
  })

  test("host interno no teste -> 400 DESTINATION_NOT_ALLOWED vira aviso de requisição; limite de 5 testes/min -> 429; 503 da rota", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openPage(page)
    await page.getByTestId("email-host").fill("localhost")
    await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
    await page.getByTestId("secret-smtpPassword").locator("input").fill("SEGREDO-L")
    await page.getByRole("button", { name: "Enviar e-mail de teste" }).click()
    const reqErr = page.getByTestId("email-test-request-error")
    await expect(reqErr).toContainText("Endereço interno não é permitido em produção")
    await expect(reqErr).toHaveAttribute("data-code", "DESTINATION_NOT_ALLOWED")
    await expect(page.getByTestId("section-email").getByText("Endereço interno não é permitido em produção").first()).toBeVisible()
    // (esse teste contou 1 chamada ao limite) mais 4 ok e a 6ª cai no 429
    await page.getByTestId("email-host").fill("smtp.innoflow.example")
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: /Enviar e-mail de teste|Testar de novo/ }).click()
      await expect(page.getByTestId("email-test-result")).toBeVisible()
    }
    await page.getByRole("button", { name: "Enviar WhatsApp de teste" }).click()
    await expect(page.getByTestId("whatsapp-test-request-error")).toContainText("Muitas alterações ou testes em pouco tempo")
    await expect(page.getByTestId("whatsapp-test-request-error")).toHaveAttribute("data-code", "RATE_LIMITED_COMMUNICATION_SETTINGS")
  })

  test("503 da rota de teste (config ilegível no servidor)", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await page.evaluate(() => localStorage.setItem("mock:comunicacao-teste", "HTTP_503"))
    await openPage(page)
    await page.getByRole("button", { name: "Enviar WhatsApp de teste" }).click()
    await expect(page.getByTestId("whatsapp-test-request-error")).toHaveAttribute("data-code", "COMMUNICATION_SETTINGS_UNAVAILABLE")
  })
})

test.describe("mobile (375)", () => {
  test.use({ viewport: { width: 375, height: 800 } })

  test("sem rolagem lateral, 1 h1, h2 nas seções e nenhum controle abaixo de 44 px; barra só gruda com alteração", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await page.goto("/admin/comunicacao")
    await expect(page.getByRole("heading", { name: "Comunicação", level: 1 })).toBeVisible()
    const medir = () =>
      page.evaluate(() => {
        const m = document.querySelector("main")!
        const small: string[] = []
        for (const el of m.querySelectorAll<HTMLElement>("button, a[href], input:not(.sr-only), select, textarea, [role=switch]")) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          let h = r.height
          if (el.getAttribute("role") === "switch") {
            el.scrollIntoView({ block: "center" })
            const rr = el.getBoundingClientRect()
            const cx = rr.left + rr.width / 2
            h = document.elementFromPoint(cx, rr.top - 10) === el && document.elementFromPoint(cx, rr.bottom + 10) === el ? 44 : rr.height
          }
          if (h < 43.5) small.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" h=${Math.round(h)}`)
        }
        return {
          small,
          overflow: { main: m.scrollWidth - m.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth },
          h1: m.querySelectorAll("h1").length,
          headings: [...m.querySelectorAll("h1, h2")].map((h) => `${h.tagName}:${h.textContent!.trim()}`),
          barPosition: getComputedStyle(document.querySelector('[data-testid="save-bar"]')!).position,
        }
      })
    const idle = await medir()
    expect(idle.overflow).toEqual({ main: 0, doc: 0 })
    expect(idle.h1).toBe(1)
    expect(idle.headings).toEqual(["H1:Comunicação", "H2:E-mail (SMTP)", "H2:WhatsApp (Evolution API)", "H2:Alertas"])
    expect(idle.small, `controles < 44 px: ${idle.small.join(" | ")}`).toEqual([])
    expect(idle.barPosition).toBe("static")
    await page.getByTestId("email-fromName").fill("Outro nome")
    expect((await medir()).barPosition).toBe("sticky")
  })
})
