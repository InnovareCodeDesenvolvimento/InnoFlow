import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → Configurações → abas E-mail, WhatsApp e Alertas (antes a tela única "Comunicação", N-7), contra os mocks MSW (`src/mocks/communicationData.ts` + `handlers.ts`).
 * NADA aqui foi provado contra o backend real. O estado do mock vive por conta de ADMIN e na memória da PÁGINA (um `page.goto` zera tudo), então cada teste usa UMA navegação
 * real (login) e o resto é clique na SPA. A aba Geral (dados da empresa) tem o spec próprio `admin-configuracoes-geral.spec.ts`.
 *
 * Contas (ver o cabeçalho de `communicationData.ts`):
 *  admin@                       -> env: e-mail do ambiente (funcionando), WhatsApp sem configuração
 *  comunicacao-pronta@          -> database: e-mail e WhatsApp ligados e funcionando
 *  comunicacao-vazia@           -> env, nada configurado
 *  comunicacao-sem-chave@       -> chave de segredos do servidor inválida/indisponível (override PAYMENT_SECRETS_KEY inválido)
 *  comunicacao-ilegivel@        -> segredos salvos que não decifram
 *  comunicacao-indisponivel@    -> o GET responde 503
 *  comunicacao-rede-privada@    -> privateHostsAllowed
 *
 * Segredos digitados usam marcadores únicos (SEGREDO-...) para provar que NENHUM vaza para o DOM, o resumo, o console ou o localStorage.
 */

const PASSWORD = "senha1234"
const NAV = "Navegação do painel administrativo"
const TABS_NAV = "Assuntos das configurações"
const TAB_LABEL = { geral: "Geral", email: "E-mail", whatsapp: "WhatsApp", alertas: "Alertas" } as const
type Tab = keyof typeof TAB_LABEL
const TOAST = "Configuração salva."

async function login(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

/** Abre a aba pelo MENU e pela barra de abas (cliques na SPA: o estado do mock sobrevive). */
async function openTab(page: Page, tab: Tab) {
  if (!page.url().includes("/admin/configuracoes")) {
    await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Configurações" }).click()
    await expect(page).toHaveURL(/\/admin\/configuracoes\/geral$/)
  }
  await page.getByRole("navigation", { name: TABS_NAV }).getByRole("link", { name: TAB_LABEL[tab], exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/configuracoes/${tab}$`))
  await expect(page.getByRole("heading", { name: `Configurações · ${TAB_LABEL[tab]}`, level: 1 })).toBeVisible()
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

/** Corpos dos testes (POST test-email / test-whatsapp / test-smtp-connection). */
function captureTests(page: Page) {
  const bodies: Array<{ channel: string; body: Record<string, unknown> }> = []
  page.on("request", (req) => {
    const m = /communication-settings\/test-(email|whatsapp|smtp-connection)$/.exec(req.url())
    if (req.method() === "POST" && m) bodies.push({ channel: m[1], body: JSON.parse(req.postData() ?? "{}") as Record<string, unknown> })
  })
  return bodies
}

/** Seletores consultados em `GET .../domain-check`. */
function captureDomainChecks(page: Page) {
  const selectors: Array<string | null> = []
  page.on("request", (req) => {
    if (req.method() === "GET" && req.url().includes("/communication-settings/domain-check")) selectors.push(new URL(req.url()).searchParams.get("selector"))
  })
  return selectors
}

const main = (page: Page) => page.locator("main")
const dialog = (page: Page) => page.getByRole("dialog", { name: "Confirmar alterações na comunicação" })
const saveButton = (page: Page) => page.getByTestId("save-button")
const connectionButton = (page: Page) => page.getByRole("button", { name: "Testar conexão" })
const emailTestButton = (page: Page) => page.getByRole("button", { name: "Enviar e-mail de teste", exact: true })

async function submitSaveDialog(page: Page, password: string = PASSWORD) {
  await dialog(page).getByLabel("Sua senha atual").fill(password)
  await dialog(page).getByRole("button", { name: "Confirmar e salvar" }).click()
}

test.describe("acesso e rotas", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("ADMIN vê Configurações no menu (grupo Rede); /admin/configuracoes abre a Geral; as abas são subrotas com 1 h1", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    const menu = page.getByRole("navigation", { name: NAV })
    await expect(menu.getByRole("link", { name: "Configurações" })).toBeVisible()
    await expect(menu.getByRole("link", { name: "Comunicação" })).toHaveCount(0)
    await openTab(page, "email")
    await expect(page.locator("h1")).toHaveCount(1)
    await expect(page.getByRole("link", { name: "E-mail", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(page.getByTestId("section-email").getByRole("heading", { level: 2, name: "E-mail transacional (SMTP)" })).toBeVisible()
    await expect(page.getByTestId("section-domain-check").getByRole("heading", { level: 2, name: /Verificação do domínio do remetente/ })).toBeVisible()
    await openTab(page, "whatsapp")
    await expect(page.getByTestId("section-whatsapp").getByRole("heading", { level: 2, name: "WhatsApp (Evolution API)" })).toBeVisible()
    await openTab(page, "alertas")
    await expect(page.getByTestId("section-alerts").getByRole("heading", { level: 2, name: "Avisos ao dono" })).toBeVisible()
  })

  test("a rota antiga /admin/comunicacao redireciona para a aba E-mail preservando a query; a raiz e uma aba que não existe abrem a Geral", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await page.goto("/admin/comunicacao?origem=favorito")
    await expect(page).toHaveURL(/\/admin\/configuracoes\/email\?origem=favorito$/)
    await expect(page.getByRole("heading", { name: "Configurações · E-mail", level: 1 })).toBeVisible()
    await page.goto("/admin/configuracoes")
    await expect(page).toHaveURL(/\/admin\/configuracoes\/geral$/)
    await page.goto("/admin/configuracoes/xyz")
    await expect(page).toHaveURL(/\/admin\/configuracoes\/geral$/)
  })

  test("OPERATOR não vê o item no menu e as rotas mostram \"Acesso restrito\"", async ({ page }) => {
    await login(page, "operador@innoelektron.com")
    await expect(page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Configurações" })).toHaveCount(0)
    await page.goto("/admin/configuracoes/email")
    await expect(page.getByRole("heading", { level: 1, name: "Acesso restrito" })).toBeVisible()
    await page.goto("/admin/comunicacao")
    await expect(page.getByRole("heading", { level: 1, name: "Acesso restrito" })).toBeVisible()
  })

  test("trocar de aba com alteração não salva pede confirmação: continuar editando mantém o rascunho; sair sem salvar o descarta", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    await page.getByTestId("email-port").fill("2525")
    const tabs = page.getByRole("navigation", { name: TABS_NAV })
    await tabs.getByRole("link", { name: "WhatsApp", exact: true }).click()
    const leave = page.getByRole("dialog", { name: "Você tem alterações não salvas" })
    await expect(leave).toBeVisible()
    await leave.getByRole("button", { name: "Continuar editando" }).click()
    await expect(leave).toBeHidden()
    await expect(page).toHaveURL(/\/admin\/configuracoes\/email$/)
    await expect(page.getByTestId("email-port")).toHaveValue("2525")
    await tabs.getByRole("link", { name: "WhatsApp", exact: true }).click()
    await leave.getByRole("button", { name: "Sair sem salvar" }).click()
    await expect(page).toHaveURL(/\/admin\/configuracoes\/whatsapp$/)
    await expect(page.getByTestId("section-whatsapp")).toBeVisible() // a aba nova carregou (a antiga só some depois do chunk)
    await tabs.getByRole("link", { name: "E-mail", exact: true }).click() // sem alteração: navega direto, sem aviso
    await expect(page).toHaveURL(/\/admin\/configuracoes\/email$/)
    await expect(page.getByTestId("email-port")).toHaveValue("587")
  })
})

test.describe("leitura: origem env e origem database", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("origem env (admin@): banner, e-mail do ambiente funcionando, WhatsApp sem configuração, nenhum campo de senha aberto, salvar bloqueado", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openTab(page, "email")
    await expect(page.getByTestId("source-banner-env")).toContainText("Usando as variáveis do servidor")
    await expect(page.getByTestId("email-source")).toHaveText("Vem do servidor (env)")
    await expect(page.getByTestId("email-status")).toHaveText("Funcionando")
    await expect(page.getByTestId("email-host")).toHaveValue("smtp.env.exemplo.com.br")
    await expect(page.getByTestId("email-from")).toHaveValue("InnoFlow <alertas@exemplo.com.br>")
    await expect(page.getByTestId("secret-smtpPassword")).toContainText("Configurada")
    await expect(page.getByTestId("secret-smtpPassword")).toContainText("Senha configurada. Deixe em branco para manter.")
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    await expect(saveButton(page)).toBeDisabled()
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
    await expect(page.getByTestId("save-bar-propagation")).toContainText("em até 1 minuto")
    await openTab(page, "whatsapp")
    await expect(page.getByTestId("whatsapp-source")).toHaveText("Não configurado")
    await expect(page.getByTestId("whatsapp-status")).toHaveText("Desligado")
    await expect(page.getByTestId("secret-evolutionApiKey")).toContainText("Não configurada")
    await openTab(page, "alertas")
    await expect(page.getByTestId("alerts-globalMinSeverity")).toHaveText("Informativo")
    await expect(page.getByTestId("alerts-maxPerHour")).toHaveText("20")
  })

  test("origem database (pronta@): selo do painel, estado dos dois canais, apikey com dica dos 4 últimos, destinatários e janela nas abas certas, segredos fora do DOM", async ({ page }) => {
    const consoleLines = captureConsole(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    await expect(page.getByTestId("source-banner-env")).toHaveCount(0)
    await expect(page.getByTestId("email-source")).toHaveText("Configurado no painel")
    await expect(page.getByTestId("email-status")).toHaveText("Funcionando")
    await expect(page.getByRole("switch", { name: "Ligar o e-mail" })).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("save-bar-propagation")).toContainText("Última alteração em")
    await openTab(page, "whatsapp")
    await expect(page.getByTestId("whatsapp-status")).toHaveText("Funcionando")
    await expect(page.getByTestId("secret-evolutionApiKey")).toContainText("Configurada")
    await expect(page.getByTestId("secret-evolutionApiKey-note")).toHaveText("…a1b2")
    await expect(page.getByTestId("whatsapp-recipients")).toHaveValue("5511999999999")
    await openTab(page, "alertas")
    await expect(page.getByTestId("email-recipients")).toHaveValue("dono@innoflow.example\nfinanceiro@innoflow.example")
    await expect(page.getByTestId("whatsapp-recipients-summary")).toContainText("1 número cadastrado")
    await expect(page.getByTestId("alerts-dedupeMinutes")).toHaveValue("45")
    await expect(page.getByTestId("email-minSeverity")).toHaveValue("IMPORTANTE")
    await expect(page.getByTestId("whatsapp-minSeverity")).toHaveValue("CRITICO")
    await expect(page.locator("input[type=password]")).toHaveCount(0)
    expect(consoleLines.filter((l) => /smtp|apikey|senha/i.test(l) && /SEGREDO/.test(l))).toEqual([])
  })

  test("segredos ilegíveis (ilegivel@): alerta permanente, chips em perigo, canais com problema e avisos do servidor", async ({ page }) => {
    await login(page, "comunicacao-ilegivel@innoelektron.com")
    await openTab(page, "email")
    await expect(page.getByTestId("secrets-unreadable-alert")).toContainText("Segredos salvos ilegíveis")
    await expect(page.getByTestId("secret-smtpPassword-chip")).toHaveText("Configurada (ilegível)")
    await expect(page.getByTestId("email-status")).toHaveText("Com problema")
    await expect(page.getByTestId("warnings-alert")).toContainText("não pode ser lida")
    await openTab(page, "whatsapp")
    await expect(page.getByTestId("secret-evolutionApiKey-chip")).toHaveText("Configurada (ilegível)")
  })

  test("chave de segredos do servidor indisponível (sem-chave@): alerta (sem mandar criar variável); digitar segredo é erro de campo e bloqueia salvar", async ({ page }) => {
    await login(page, "comunicacao-sem-chave@innoelektron.com")
    await openTab(page, "email")
    const keyAlert = page.getByTestId("secrets-key-missing-alert")
    await expect(keyAlert).toContainText("Chave de segredos do servidor indisponível")
    await expect(keyAlert).toContainText("administrador do servidor")
    await expect(keyAlert).toContainText("JWT_SECRET")
    await expect(keyAlert).not.toContainText("openssl")
    await page.getByRole("button", { name: "Informar Senha SMTP" }).click()
    await page.getByTestId("secret-smtpPassword").locator("input").fill("SEGREDO-SEM-CHAVE")
    await expect(page.getByTestId("secret-smtpPassword")).toContainText("não dá para guardar este segredo")
    await expect(saveButton(page)).toBeDisabled()
    await expect(page.getByTestId("save-bar-errors")).toBeVisible()
  })

  test("rede privada liberada pelo deploy (rede-privada@): nota informativa", async ({ page }) => {
    await login(page, "comunicacao-rede-privada@innoelektron.com")
    await openTab(page, "email")
    await expect(page.getByTestId("private-hosts-note")).toBeVisible()
  })

  test("GET 503 (indisponivel@): estado de erro com tentar de novo, sem formulário, em cada aba de comunicação", async ({ page }) => {
    await login(page, "comunicacao-indisponivel@innoelektron.com")
    await openTab(page, "email")
    await expect(page.getByText("O servidor não conseguiu ler a configuração de comunicação")).toBeVisible()
    await expect(page.getByRole("button", { name: /tentar/i })).toBeVisible()
    await expect(page.getByTestId("section-email")).toHaveCount(0)
    await openTab(page, "whatsapp")
    await expect(page.getByText("O servidor não conseguiu ler a configuração de comunicação")).toBeVisible()
    await expect(page.getByTestId("section-whatsapp")).toHaveCount(0)
  })
})

test.describe("salvar: e-mail", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("trocar o servidor EXIGE digitar a senha de novo; salvar manda só o diff, com step-up; senha errada fica no diálogo; nenhum segredo vaza", async ({ page }) => {
    const consoleLines = captureConsole(page)
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")

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
    await expect(page.getByText(TOAST)).toBeVisible()
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

  test("remetente é UM campo (nome <e-mail> ou só o e-mail): o PUT leva fromName/fromAddress só do que mudou; só o e-mail usa o nome InnoFlow; inválido bloqueia", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    const from = page.getByTestId("email-from")
    await expect(from).toHaveValue("InnoFlow <alertas@innoflow.example>")
    await expect(page.getByText("Se puser só o e-mail, o nome InnoFlow entra no lugar.")).toBeVisible()

    await from.fill("isto nao e um remetente")
    await expect(main(page).getByText("Remetente inválido")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()

    await from.fill("Financeiro InnoFlow <financeiro@innoflow.example>")
    await saveButton(page).click()
    await expect(dialog(page).getByTestId("save-summary")).toContainText("Financeiro InnoFlow")
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
    expect(puts).toEqual([{ email: { fromName: "Financeiro InnoFlow", fromAddress: "financeiro@innoflow.example" } }])
    await expect(from).toHaveValue("Financeiro InnoFlow <financeiro@innoflow.example>")

    await from.fill("aviso@innoflow.example")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST).first()).toBeVisible()
    expect(puts[1]).toEqual({ email: { fromName: "InnoFlow", fromAddress: "aviso@innoflow.example" } })
    await expect(from).toHaveValue("InnoFlow <aviso@innoflow.example>")
  })

  test("conexão segura: marcar e desmarcar vai como `secure`; o interruptor desliga o canal sem apagar a configuração", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    await page.getByRole("checkbox", { name: "Conexão segura (TLS/SSL)" }).check()
    await page.getByRole("switch", { name: "Ligar o e-mail" }).click()
    await saveButton(page).click()
    await expect(dialog(page).getByTestId("save-summary")).toContainText("TLS direto")
    await expect(dialog(page).getByTestId("save-summary")).toContainText("Desligado")
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
    expect(puts).toEqual([{ email: { secure: true, enabled: false } }])
    await expect(page.getByTestId("email-status")).toHaveText("Desligado")
    await expect(page.getByTestId("email-host")).toHaveValue("smtp.innoflow.example")
  })

  test("destinatários e severidade (aba Alertas): lista inteira substitui; resumo mostra só contagem (não os e-mails)", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "alertas")
    await page.getByTestId("email-recipients").fill("novo@innoflow.example\noutro@innoflow.example, terceiro@innoflow.example")
    await page.getByTestId("email-minSeverity").selectOption("CRITICO")
    await saveButton(page).click()
    const summary = dialog(page).getByTestId("save-summary")
    await expect(summary).toContainText("2 destinatários")
    await expect(summary).toContainText("3 destinatários")
    expect(await summary.innerText()).not.toContain("novo@innoflow.example")
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
    expect(puts).toEqual([{ email: { recipients: ["novo@innoflow.example", "outro@innoflow.example", "terceiro@innoflow.example"], minSeverity: "CRITICO" } }])
  })

  test("campos inválidos: erro no campo e na barra, salvar bloqueado; descartar limpa tudo (e-mail e alertas)", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    await page.getByTestId("email-host").fill("https://smtp.x.com")
    await page.getByTestId("email-port").fill("70000")
    await expect(main(page).getByText("Informe só o endereço")).toBeVisible()
    await expect(main(page).getByText("Porta de 1 a 65535")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()
    await page.getByRole("button", { name: "Descartar" }).click()
    await expect(page.getByTestId("email-host")).toHaveValue("smtp.innoflow.example")
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")

    await openTab(page, "alertas")
    await page.getByTestId("email-recipients").fill("isto-nao-e-email")
    await expect(main(page).getByText("E-mail inválido")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()
  })

  test("apagar a senha salva: marca, desfaz, e envia `clearSecrets` (sem valor de segredo)", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    await page.getByRole("button", { name: "Apagar a senha SMTP salva" }).click()
    await expect(page.getByTestId("secret-smtpPassword-chip")).toHaveText("Será apagada ao salvar")
    await expect(page.getByTestId("save-bar-status")).toContainText("1 alteração não salva")
    await page.getByTestId("secret-smtpPassword").getByRole("button", { name: "Desfazer" }).click()
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
    await page.getByRole("button", { name: "Apagar a senha SMTP salva" }).click()
    await saveButton(page).click()
    await expect(dialog(page).getByTestId("save-summary")).toContainText("Será apagada")
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
    expect(puts).toEqual([{ clearSecrets: ["smtpPassword"] }])
    await expect(page.getByTestId("secret-smtpPassword-chip")).toHaveText("Não configurada")
  })

  test("canal que vem do env: salvar outra coisa leva `enabled` explícito (a 1ª gravação não pode desligar o canal)", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "admin@innoelektron.com")
    await openTab(page, "email")
    await page.getByTestId("email-from").fill("Novo nome <alertas@exemplo.com.br>")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
    expect(puts).toEqual([{ email: { fromName: "Novo nome", enabled: true } }])
    await expect(page.getByTestId("email-status")).toHaveText("Funcionando")
    await expect(page.getByTestId("email-source")).toHaveText("Configurado no painel")
    await expect(page.getByTestId("source-banner-env")).toHaveCount(0)
  })

  test("janela de repetição (aba Alertas): valor inválido bloqueia; válido vai; em branco volta ao padrão", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "alertas")
    await page.getByTestId("alerts-dedupeMinutes").fill("2000")
    await expect(main(page).getByText("Informe de 1 a 1440 minutos.")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()
    await page.getByTestId("alerts-dedupeMinutes").fill("")
    await saveButton(page).click()
    await expect(dialog(page).getByTestId("save-summary")).toContainText("Padrão do servidor")
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
    expect(puts).toEqual([{ alerts: { dedupeMinutes: null } }])
  })
})

test.describe("salvar: WhatsApp e regras do servidor", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("nada configurado: ligar sem estar completo -> 409 com pendências e rascunho mantido; completar e ligar funciona (a 1ª gravação sem `enabled` nasceria desligada)", async ({ page }) => {
    const consoleLines = captureConsole(page)
    const puts = capturePuts(page)
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openTab(page, "whatsapp")
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
    await expect(page.getByText(TOAST)).toBeVisible()

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

  test("e-mail NÃO exige destinatário de alerta para ligar (L1.6): liga com servidor + remetente e o servidor avisa em `warnings`", async ({ page }) => {
    const puts = capturePuts(page)
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openTab(page, "email")
    await page.getByTestId("email-host").fill("smtp.exemplo.com.br")
    await page.getByTestId("email-from").fill("avisos@exemplo.com.br")
    await page.getByRole("switch", { name: "Ligar o e-mail" }).click()
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
    expect(puts).toEqual([{ email: { enabled: true, host: "smtp.exemplo.com.br", fromName: "InnoFlow", fromAddress: "avisos@exemplo.com.br" } }])
    await expect(page.getByTestId("email-status")).toHaveText("Funcionando")
    await expect(page.getByTestId("warnings-alert")).toContainText("sem destinatário de alerta")
  })

  test("1ª gravação sem tocar no interruptor nasce DESLIGADA", async ({ page }) => {
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openTab(page, "whatsapp")
    await page.getByTestId("whatsapp-baseUrl").fill("https://evolution.exemplo.com.br")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
    await expect(page.getByTestId("whatsapp-source")).toHaveText("Configurado no painel")
    await expect(page.getByTestId("whatsapp-status")).toHaveText("Desligado")
  })

  test("destino de rede interna (SSRF): explicado em linguagem simples, aponta o campo, nada é gravado", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
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
    await openTab(page, "whatsapp")
    await page.getByTestId("whatsapp-baseUrl").fill("http://evolution.exemplo.com.br")
    await page.getByRole("button", { name: "Substituir Apikey da Evolution" }).click()
    await page.getByTestId("secret-evolutionApiKey").locator("input").fill("SEGREDO-Y")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByTestId("save-error")).toContainText("https://")
  })

  test("rede privada liberada pelo deploy: o mesmo endereço interno É aceito", async ({ page }) => {
    await login(page, "comunicacao-rede-privada@innoelektron.com")
    await openTab(page, "email")
    await page.getByTestId("email-host").fill("10.0.0.5")
    await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
    await page.getByTestId("secret-smtpPassword").locator("input").fill("SEGREDO-X")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
  })

  test("erros do servidor por code: 429 do limite, 503 do banco, 500, step-up 503 e step-up 429 — rascunho mantido, mensagens nossas", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")

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

  test("503 SECRETS_KEY_MISSING: mensagem própria (provada pelo mock via fetch, o cliente já barra antes)", async ({ page }) => {
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

test.describe("testar conexão (SMTP) e e-mail de teste", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("Testar conexão sem alteração testa a config SALVA: pedido vazio, 3 etapas ok e nada fica na tela como segredo", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    await connectionButton(page).click()
    const result = page.getByTestId("smtp-connection-result")
    await expect(result).toHaveAttribute("data-ok", "true")
    await expect(result).toHaveAttribute("data-stage", "OK")
    await expect(result).toContainText("Conexão funcionando.")
    for (const stage of ["CONNECT", "TLS", "AUTH"]) await expect(result.locator(`li[data-stage=${stage}]`)).toHaveAttribute("data-state", "ok")
    expect(tests).toEqual([{ channel: "smtp-connection", body: {} }])
    // testar nunca grava: continua sem alteração pendente
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
  })

  test("com valores digitados e não salvos manda `config` (valores efetivos) e a senha só se foi digitada; sem a senha de novo o cliente bloqueia", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    await page.getByTestId("email-host").fill("smtp.teste.exemplo.com")
    await connectionButton(page).click()
    await expect(page.getByTestId("secret-smtpPassword")).toContainText("digite a senha SMTP de novo")
    expect(tests).toHaveLength(0)

    await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
    await page.getByTestId("secret-smtpPassword").locator("input").fill("SEGREDO-TESTE-123")
    await connectionButton(page).click()
    await expect(page.getByTestId("smtp-connection-result")).toHaveAttribute("data-ok", "true")
    expect(tests).toEqual([{ channel: "smtp-connection", body: { config: { host: "smtp.teste.exemplo.com", port: 587, secure: false, user: "alertas@innoflow.example", password: "SEGREDO-TESTE-123" } } }])
    // o teste não gravou: continua com 2 alterações pendentes e o segredo só no campo (nunca na tela como texto)
    await expect(page.getByTestId("save-bar-status")).toContainText("2 alterações não salvas")
    expect(await main(page).innerText()).not.toContain("SEGREDO-TESTE-123")
  })

  const ESTAGIOS: Array<[string, string, string, string]> = [
    ["falha-conexao.exemplo.com", "CONNECT", "SMTP_CONNECTION_FAILED", "Não foi possível conectar ao servidor de e-mail"],
    ["lento.exemplo.com", "CONNECT", "TIMEOUT", "demorou demais"],
    ["falha-tls.exemplo.com", "TLS", "SMTP_TLS_REQUIRED", "exige conexão segura"],
    ["falha-auth.exemplo.com", "AUTH", "SMTP_AUTH_FAILED", "recusou o usuário ou a senha"],
  ]
  for (const [host, stage, code, texto] of ESTAGIOS) {
    test(`estágio ${stage} (${code}): para na etapa certa, texto por code (não o do servidor), etapas seguintes "não testado"`, async ({ page }) => {
      await login(page, "comunicacao-pronta@innoelektron.com")
      await openTab(page, "email")
      await page.getByTestId("email-host").fill(host)
      await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
      await page.getByTestId("secret-smtpPassword").locator("input").fill("SEGREDO-ESTAGIO")
      await connectionButton(page).click()
      const result = page.getByTestId("smtp-connection-result")
      await expect(result).toHaveAttribute("data-ok", "false")
      await expect(result).toHaveAttribute("data-stage", stage)
      await expect(result).toHaveAttribute("data-code", code)
      await expect(result).toContainText(texto)
      await expect(result).not.toContainText("mock:")
      await expect(result).toContainText(`Código: ${code}`)
      const order = ["CONNECT", "TLS", "AUTH"]
      for (const [i, s] of order.entries()) {
        const expected = i < order.indexOf(stage) ? "ok" : i === order.indexOf(stage) ? "failed" : "skipped"
        await expect(result.locator(`li[data-stage=${s}]`)).toHaveAttribute("data-state", expected)
      }
      expect(await main(page).innerText()).not.toContain("SEGREDO-ESTAGIO")
    })
  }

  test("sem servidor/porta salvos: erro no campo, nada enviado; host interno é RESULTADO do teste (DESTINATION_BLOCKED, etapa Conexão), não erro da rota", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openTab(page, "email")
    await connectionButton(page).click()
    await expect(main(page).getByText("Informe o servidor SMTP para testar")).toBeVisible()
    await expect(main(page).getByText("Informe a porta para testar")).toBeVisible()
    expect(tests).toHaveLength(0)

    await page.getByTestId("email-host").fill("localhost")
    await page.getByTestId("email-port").fill("25")
    await connectionButton(page).click()
    const result = page.getByTestId("smtp-connection-result")
    await expect(result).toHaveAttribute("data-ok", "false")
    await expect(result).toHaveAttribute("data-stage", "CONNECT")
    await expect(result).toHaveAttribute("data-code", "DESTINATION_BLOCKED")
    await expect(result).toContainText("Endereço interno não é permitido")
    await expect(page.getByTestId("smtp-connection-request-error")).toHaveCount(0)
  })

  test("sem usuário/senha o servidor é usado sem login: o resultado diz que o login não foi testado (AUTH \"não testado\")", async ({ page }) => {
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openTab(page, "email")
    await page.getByTestId("email-host").fill("smtp.exemplo.com.br")
    await page.getByTestId("email-port").fill("587")
    await connectionButton(page).click()
    const result = page.getByTestId("smtp-connection-result")
    await expect(result).toHaveAttribute("data-ok", "true")
    await expect(result).toContainText("o login não foi testado")
    await expect(result.locator("li[data-stage=AUTH]")).toHaveAttribute("data-state", "skipped")
    await expect(result.locator("li[data-stage=TLS]")).toHaveAttribute("data-state", "ok")
  })

  test("Enviar e-mail de teste usa o SMTP SALVO (sem `config`), mostra destino mascarado e avisa quando há alteração não salva", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    await expect(page.getByTestId("email-test-unsaved-note")).toHaveCount(0)
    await emailTestButton(page).click()
    const result = page.getByTestId("email-test-result")
    await expect(result).toHaveAttribute("data-ok", "true")
    await expect(result).toContainText("Teste enviado com sucesso")
    await expect(result).toContainText("d***@innoflow.example")
    expect(tests).toEqual([{ channel: "email", body: { to: "dono@innoflow.example" } }])

    await page.getByTestId("email-host").fill("smtp.digitado.exemplo.com")
    await expect(page.getByTestId("email-test-unsaved-note")).toContainText("usa o SMTP salvo")
    await page.getByTestId("email-test-to").fill("outro@exemplo.com")
    await emailTestButton(page).click()
    await expect(page.getByTestId("email-test-result")).toHaveAttribute("data-ok", "true")
    expect(tests[1]).toEqual({ channel: "email", body: { to: "outro@exemplo.com" } }) // nada digitado trafega
    await expect(page.getByTestId("save-bar-status")).toContainText("1 alteração não salva")
  })

  test("o botão de ajuda do e-mail de teste abre e fecha a explicação (aria-expanded) e o Enter no campo envia", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    const help = page.getByRole("button", { name: "O que é o e-mail de teste?" })
    await expect(help).toHaveAttribute("aria-expanded", "false")
    await help.click()
    await expect(help).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByTestId("email-test-help")).toContainText("SALVO")
    await help.click()
    await expect(page.getByTestId("email-test-help")).toHaveCount(0)
    await page.getByTestId("email-test-to").fill("voce@gmail.com")
    await page.getByTestId("email-test-to").press("Enter")
    await expect(page.getByTestId("email-test-result")).toHaveAttribute("data-ok", "true")
    expect(tests).toEqual([{ channel: "email", body: { to: "voce@gmail.com" } }])
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
      await openTab(page, channel)
      await page.getByRole("button", { name: channel === "email" ? "Enviar e-mail de teste" : "Enviar WhatsApp de teste", exact: true }).click()
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
    await openTab(page, "whatsapp")
    await page.getByTestId("whatsapp-test-to").fill("+55 (21) 98888-7777")
    await page.getByRole("button", { name: "Enviar WhatsApp de teste" }).click()
    await expect(page.getByTestId("whatsapp-test-result")).toContainText("5521*****7777")
    expect(tests).toEqual([{ channel: "whatsapp", body: { to: "5521988887777" } }])
  })

  test("destino de teste inválido e canal sem destinatário: erro no campo, nada enviado", async ({ page }) => {
    const tests = captureTests(page)
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openTab(page, "email")
    await emailTestButton(page).click()
    await expect(page.getByTestId("email-test").getByText(/Informe o e-mail que vai receber o teste/)).toBeVisible()
    await page.getByTestId("email-test-to").fill("nao-e-email")
    await emailTestButton(page).click()
    await expect(page.getByTestId("email-test").getByText("E-mail de destino inválido.")).toBeVisible()
    expect(tests).toHaveLength(0)
  })

  test("canal sem configuração, com destino: o servidor responde ok:false INVALID_CONFIGURATION (é resultado do teste, não erro da tela)", async ({ page }) => {
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openTab(page, "email")
    await page.getByTestId("email-test-to").fill("dono@exemplo.com")
    await emailTestButton(page).click()
    await expect(page.getByTestId("email-test-result")).toHaveAttribute("data-code", "INVALID_CONFIGURATION")
    await expect(page.getByTestId("email-test-result")).toContainText("configuração está incompleta")
  })

  test("limite de 5 testes/min dividido entre conexão, e-mail e WhatsApp -> 429 com texto próprio", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    for (let i = 0; i < 5; i++) {
      await connectionButton(page).click()
      await expect(page.getByTestId("smtp-connection-result")).toBeVisible()
    }
    await connectionButton(page).click()
    const reqErr = page.getByTestId("smtp-connection-request-error")
    await expect(reqErr).toContainText("Muitas alterações ou testes em pouco tempo")
    await expect(reqErr).toHaveAttribute("data-code", "RATE_LIMITED_COMMUNICATION_SETTINGS")
    await emailTestButton(page).click()
    await expect(page.getByTestId("email-test-request-error")).toHaveAttribute("data-code", "RATE_LIMITED_COMMUNICATION_SETTINGS")
  })

  test("503 da rota de teste (config ilegível no servidor): conexão e WhatsApp", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await page.evaluate(() => localStorage.setItem("mock:comunicacao-teste", "HTTP_503"))
    await openTab(page, "email")
    await connectionButton(page).click()
    await expect(page.getByTestId("smtp-connection-request-error")).toHaveAttribute("data-code", "COMMUNICATION_SETTINGS_UNAVAILABLE")
    await openTab(page, "whatsapp")
    await page.getByRole("button", { name: "Enviar WhatsApp de teste" }).click()
    await expect(page.getByTestId("whatsapp-test-request-error")).toHaveAttribute("data-code", "COMMUNICATION_SETTINGS_UNAVAILABLE")
  })
})

test.describe("verificação do domínio do remetente (SPF, DKIM, DMARC)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("sem seletor: SPF ok, DMARC em atenção, DKIM \"não verificado\"; instruções em linguagem simples só onde falta algo", async ({ page }) => {
    const selectors = captureDomainChecks(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    const panel = page.getByTestId("section-domain-check")
    await expect(panel).toContainText("innoflow.example")
    await panel.getByRole("button", { name: "Verificar" }).click()
    const result = page.getByTestId("domain-check-result")
    await expect(result).toHaveAttribute("data-overall", "ATENCAO")
    await expect(page.getByTestId("domain-spf")).toHaveAttribute("data-status", "OK")
    await expect(page.getByTestId("domain-dmarc")).toHaveAttribute("data-status", "ATENCAO")
    await expect(page.getByTestId("domain-dkim")).toHaveAttribute("data-status", "NAO_VERIFICADO")
    await expect(page.getByTestId("domain-dkim")).toContainText("Não verificado")
    expect(selectors).toEqual([null])
    // SPF ok: sem "Como configurar"; DMARC em atenção: com instrução e valor sugerido
    await expect(page.getByTestId("domain-spf").getByRole("button", { name: /Como configurar/ })).toHaveCount(0)
    const how = page.getByTestId("domain-dmarc").getByRole("button", { name: "Como configurar" })
    await expect(how).toHaveAttribute("aria-expanded", "false")
    await how.click()
    await expect(page.getByTestId("domain-dmarc")).toContainText("v=DMARC1; p=none; rua=mailto:dmarc@innoflow.example")
    await expect(page.getByTestId("domain-dmarc").getByRole("button", { name: "Esconder como configurar" })).toHaveAttribute("aria-expanded", "true")
  })

  test("com seletor: DKIM consultado (ok / ausente / sem resposta); seletor inválido é barrado no cliente", async ({ page }) => {
    const selectors = captureDomainChecks(page)
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    const panel = page.getByTestId("section-domain-check")
    const field = page.getByTestId("domain-selector")
    await field.fill("default")
    await panel.getByRole("button", { name: "Verificar" }).click()
    await expect(page.getByTestId("domain-dkim")).toHaveAttribute("data-status", "OK")
    await field.fill("ausente")
    await panel.getByRole("button", { name: "Verificar" }).click()
    await expect(page.getByTestId("domain-dkim")).toHaveAttribute("data-status", "AUSENTE")
    await expect(page.getByTestId("domain-check-result")).toHaveAttribute("data-overall", "AUSENTE")
    await field.fill("erro")
    await panel.getByRole("button", { name: "Verificar" }).click()
    await expect(page.getByTestId("domain-dkim")).toHaveAttribute("data-status", "ERRO")
    expect(selectors).toEqual(["default", "ausente", "erro"])
    await field.fill("a b!")
    await panel.getByRole("button", { name: "Verificar" }).click()
    await expect(panel.getByText("Seletor inválido")).toBeVisible()
    expect(selectors).toHaveLength(3)
  })

  test("sem remetente salvo (vazia@): nada é consultado e o painel orienta; domínio gratuito mostra o aviso", async ({ page }) => {
    await login(page, "comunicacao-vazia@innoelektron.com")
    await openTab(page, "email")
    const panel = page.getByTestId("section-domain-check")
    await expect(panel).toContainText("Salve primeiro o remetente")
    await panel.getByRole("button", { name: "Verificar" }).click()
    await expect(page.getByTestId("domain-check-result")).toContainText("Cadastre primeiro o e-mail remetente")
    await expect(page.getByTestId("domain-spf")).toHaveCount(0)

    // salva um remetente gratuito: a verificação passa a avisar que SPF/DKIM/DMARC são do provedor
    await page.getByTestId("email-host").fill("smtp.exemplo.com.br")
    await page.getByTestId("email-from").fill("conta@gmail.com")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText(TOAST)).toBeVisible()
    await panel.getByRole("button", { name: "Verificar" }).click()
    await expect(page.getByTestId("domain-check-result")).toContainText("endereço de e-mail gratuito")
  })

  test("falhas da rota por code: limite de 6/min (429) e 503; DNS fora vira \"Sem resposta\" no registro, não erro de tela", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await openTab(page, "email")
    const panel = page.getByTestId("section-domain-check")
    for (let i = 0; i < 6; i++) {
      await panel.getByRole("button", { name: "Verificar" }).click()
      await expect(page.getByTestId("domain-check-result")).toBeVisible()
    }
    await panel.getByRole("button", { name: "Verificar" }).click()
    await expect(page.getByTestId("domain-check-error")).toHaveAttribute("data-code", "RATE_LIMITED_COMMUNICATION_SETTINGS")
    await expect(page.getByTestId("domain-check-error")).toContainText("Muitas alterações ou testes em pouco tempo")
  })

  test("503 da rota de verificação e DNS fora (registro com erro, tela inteira)", async ({ page }) => {
    await login(page, "comunicacao-pronta@innoelektron.com")
    await page.evaluate(() => localStorage.setItem("mock:comunicacao-dominio", "HTTP_503"))
    await openTab(page, "email")
    const panel = page.getByTestId("section-domain-check")
    await panel.getByRole("button", { name: "Verificar" }).click()
    await expect(page.getByTestId("domain-check-error")).toHaveAttribute("data-code", "COMMUNICATION_SETTINGS_UNAVAILABLE")
  })
})

test.describe("mobile (375)", () => {
  test.use({ viewport: { width: 375, height: 800 } })

  for (const tab of ["geral", "email", "whatsapp", "alertas"] as const) {
    test(`aba ${tab}: sem rolagem lateral, 1 h1, h2 nas seções e nenhum controle abaixo de 44 px; rodapé do cartão não é sticky`, async ({ page }) => {
      await login(page, "comunicacao-pronta@innoelektron.com")
      // abaixo de `lg` o menu é um drawer: vai direto pela URL da aba
      await page.goto(`/admin/configuracoes/${tab}`)
      await expect(page.getByRole("heading", { name: `Configurações · ${TAB_LABEL[tab]}`, level: 1 })).toBeVisible()
      await expect(page.locator("main h2").first()).toBeVisible()
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
            // o checkbox nativo tem 20 px mas o rótulo inteiro (44 px) é o alvo
            if (el instanceof HTMLInputElement && el.type === "checkbox") h = el.closest("label")?.getBoundingClientRect().height ?? h
            if (h < 43.5) small.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" h=${Math.round(h)}`)
          }
          return {
            small,
            overflow: { main: m.scrollWidth - m.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth },
            h1: m.querySelectorAll("h1").length,
            bar: getComputedStyle(document.querySelector('[data-testid="save-bar"]')!).position,
          }
        })
      const idle = await medir()
      expect(idle.overflow).toEqual({ main: 0, doc: 0 })
      expect(idle.h1).toBe(1)
      expect(idle.small, `controles < 44 px: ${idle.small.join(" | ")}`).toEqual([])
      expect(idle.bar).toBe("static")
    })
  }
})
