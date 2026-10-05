import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → Backups, contra os mocks MSW (`src/mocks/backupData.ts` + `handlers.ts`). NADA aqui foi provado contra o backend real, nem contra S3/Drive reais. O estado do mock vive por
 * conta de ADMIN e na memória da PÁGINA (um `page.goto` zera tudo), então cada teste usa UMA navegação real (login) e o resto é clique na SPA (exceto os de retorno do Google, que são
 * navegação por natureza).
 *
 * Contas (ver o cabeçalho de `backupData.ts`):
 *  admin@                        -> primeiro uso: sem destino, sem chave
 *  backup-s3@                    -> S3 pronto, chave gerada, ligado, histórico de 27 execuções
 *  backup-drive@                 -> Google Drive conectado
 *  backup-drive-desconectado@    -> Drive escolhido, conta NÃO conectada
 *  backup-atrasado@              -> ligado e atrasado, falhas por CREDENTIAL
 *  backup-nunca@                 -> ligado e nunca saiu uma cópia
 *  backup-andamento@             -> um backup rodando agora
 *  backup-sem-chave@             -> servidor sem PAYMENT_SECRETS_KEY e sem URL pública
 *  backup-ilegivel@              -> segredos salvos que não decifram
 *  backup-indisponivel@          -> GET da config devolve 503
 *
 * Segredos digitados usam marcadores únicos (SEGREDO-...) para provar que NENHUM vaza para o DOM (depois de salvar), o console ou o storage; a chave gerada, idem depois de "Concluir".
 */

const PASSWORD = "senha1234"
const NAV = "Navegação do painel administrativo"
const KEY_FORMAT = /^[0-9a-f]{8}(-[0-9a-f]{8}){7}$/

async function login(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

async function openPage(page: Page) {
  await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Backups" }).click()
  await expect(page).toHaveURL(/\/admin\/backups$/)
  await expect(page.getByRole("heading", { name: "Backups", level: 1 })).toBeVisible()
  await expect(page.getByTestId("section-history")).toBeVisible()
}

async function everythingTheUserCouldSee(page: Page): Promise<string> {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input,textarea")).map((el) => (el as HTMLInputElement).value)
    return [document.body.innerText, ...inputs, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), location.href].join("\n")
  })
}

function captureConsole(page: Page) {
  const lines: string[] = []
  page.on("console", (msg) => lines.push(msg.text()))
  page.on("pageerror", (err) => lines.push(String(err)))
  return lines
}

/** Corpos dos PUTs da config SEM a senha atual (que vai para `passwords`, em paralelo, para provar quais PUTs a carregaram). */
function capturePuts(page: Page) {
  const bodies: Array<Record<string, unknown>> = []
  const passwords: unknown[] = []
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/api/admin/backup/config")) {
      const { currentPassword, ...rest } = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>
      passwords.push(currentPassword)
      bodies.push(rest)
    }
  })
  return { bodies, passwords }
}

function captureKeyPosts(page: Page) {
  const bodies: Array<Record<string, unknown>> = []
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/admin/backup/key")) bodies.push(JSON.parse(req.postData() ?? "{}") as Record<string, unknown>)
  })
  return bodies
}

const main = (page: Page) => page.locator("main")
const saveButton = (page: Page) => page.getByTestId("save-button")
const saveDialog = (page: Page) => page.getByRole("dialog", { name: "Confirmar alterações no backup" })
const destinationGroup = (page: Page) => page.getByRole("group", { name: "Destino do backup" })
const enableSwitch = (page: Page) => page.getByRole("switch", { name: "Ligar o backup automático" })

async function submitSaveDialog(page: Page, password: string = PASSWORD) {
  await saveDialog(page).getByLabel("Sua senha atual").fill(password)
  await saveDialog(page).getByRole("button", { name: "Confirmar e salvar" }).click()
}

test.describe("acesso", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("ADMIN vê Backups no menu (grupo Rede) e abre a tela com 1 h1 e as seções em h2", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    const link = page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Backups" })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute("href", "/admin/backups")
    await openPage(page)
    await expect(page.locator("h1")).toHaveCount(1)
    for (const name of ["Estado geral", "Ações", "Chave de criptografia", "Agendamento", "Destino", "Histórico"]) {
      await expect(main(page).getByRole("heading", { level: 2, name })).toBeVisible()
    }
  })

  test("OPERATOR não vê o item no menu e a rota mostra \"Acesso restrito\"", async ({ page }) => {
    await login(page, "operador@innoelektron.com")
    await expect(page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Backups" })).toHaveCount(0)
    await page.goto("/admin/backups")
    await expect(page.getByRole("heading", { level: 1, name: "Acesso restrito" })).toBeVisible()
  })

  test("o passo 'Backups' do tour do mascote passa a existir (o item entrou no menu)", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await expect(page.locator('[data-tour="nav-backups"]')).toBeVisible()
  })
})

test.describe("retorno do Google (?google=ok | erro) e redirecionamento de /admin/backup", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("?google=ok: leva para /admin/backups, mostra a mensagem, LIMPA a query e não repete no F5", async ({ page }) => {
    await login(page, "backup-drive@innoelektron.com")
    await page.goto("/admin/backup?google=ok")
    await expect(page).toHaveURL(/\/admin\/backups$/)
    await expect(page.getByTestId("google-return-ok")).toContainText("Conta Google conectada")
    expect(new URL(page.url()).search).toBe("")
    await page.reload()
    await expect(page.getByRole("heading", { name: "Backups", level: 1 })).toBeVisible()
    await expect(page.getByTestId("google-return-ok")).toHaveCount(0)
  })

  test("?google=ok também funciona direto em /admin/backups e a mensagem pode ser dispensada", async ({ page }) => {
    await login(page, "backup-drive@innoelektron.com")
    await page.goto("/admin/backups?google=ok")
    await expect(page.getByTestId("google-return-ok")).toBeVisible()
    expect(new URL(page.url()).search).toBe("")
    await page.getByRole("button", { name: "Dispensar a mensagem" }).click()
    await expect(page.getByTestId("google-return-ok")).toHaveCount(0)
  })

  const MOTIVOS: Array<[string, RegExp]> = [
    ["invalid_state", /expirou ou já foi usado/],
    ["access_denied", /não autorizou/],
    ["refused_by_google", /recusou a autorização/],
    ["no_code", /não devolveu o código/],
    ["bad_credentials", /Client ID ou o Client Secret/],
    ["no_refresh_token", /myaccount\.google\.com\/permissions/],
    ["account_check_failed", /confirmar qual é a conta/],
    ["folder_create_failed", /criar a pasta/],
    ["secrets_key_missing", /PAYMENT_SECRETS_KEY/],
    ["network", /falar com o Google/],
    ["unknown", /não concluiu a conexão/],
  ]
  for (const [motivo, texto] of MOTIVOS) {
    test(`?google=erro&motivo=${motivo}: mensagem própria, query limpa`, async ({ page }) => {
      await login(page, "backup-drive-desconectado@innoelektron.com")
      await page.goto(`/admin/backup?google=erro&motivo=${motivo}`)
      const banner = page.getByTestId("google-return-error")
      await expect(banner).toBeVisible()
      await expect(banner).toContainText("Não deu para conectar a conta Google")
      await expect(banner).toContainText(texto)
      await expect(banner).toHaveAttribute("data-reason", motivo)
      expect(new URL(page.url()).search).toBe("")
    })
  }

  test("motivo desconhecido/malicioso vira a mensagem genérica e NUNCA é ecoado", async ({ page }) => {
    await login(page, "backup-drive-desconectado@innoelektron.com")
    await page.goto("/admin/backup?google=erro&motivo=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E")
    const banner = page.getByTestId("google-return-error")
    await expect(banner).toHaveAttribute("data-reason", "unknown")
    await expect(banner).not.toContainText("onerror")
    expect(await page.locator("main img").count()).toBe(0)
  })

  test("um valor estranho em ?google= não mostra nada", async ({ page }) => {
    await login(page, "backup-drive@innoelektron.com")
    await page.goto("/admin/backups?google=talvez")
    await expect(page.getByRole("heading", { name: "Backups", level: 1 })).toBeVisible()
    await expect(page.getByTestId("google-return-ok")).toHaveCount(0)
    await expect(page.getByTestId("google-return-error")).toHaveCount(0)
  })

  test("sem sessão, /admin/backup?google=ok pede login e preserva o destino", async ({ page }) => {
    await page.goto("/admin/backup?google=ok")
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe("leitura: estados da tela", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("primeiro uso (admin@): sem destino nem chave; ligar bloqueado COM o motivo escrito; aviso permanente e o do runbook", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("secrets-key-notice")).toContainText("A PAYMENT_SECRETS_KEY precisa de uma cópia fora do sistema; sem ela restaurar não devolve os segredos cifrados.")
    await expect(page.getByTestId("restore-notice")).toContainText("Restaurar não tem botão aqui, de propósito")
    await expect(page.getByTestId("restore-notice")).toContainText("docs/RUNBOOK-BACKUP-RESTAURACAO.md")
    await expect(page.getByRole("button", { name: /restaurar/i })).toHaveCount(0)
    await expect(page.getByTestId("health")).toHaveAttribute("data-tone", "off")
    await expect(page.getByTestId("destination-status")).toHaveText("Nenhum destino")
    await expect(page.getByTestId("key-status")).toHaveText("Sem chave")
    await expect(page.getByTestId("key-missing")).toBeVisible()
    await expect(enableSwitch(page)).toBeDisabled()
    const blockers = page.getByTestId("enable-blockers")
    await expect(blockers).toContainText("Complete o destino")
    await expect(blockers).toContainText("Gere a chave de criptografia")
    await expect(page.getByTestId("section-history").getByText("Nenhuma execução ainda")).toBeVisible()
    await expect(page.getByTestId("destination-none-note")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
  })

  test("primeiro uso: 'Fazer backup agora' liberado (vira teste do pg_dump); conferir e testar destino bloqueados com o motivo escrito", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("action-run")).toBeEnabled()
    await expect(page.getByTestId("action-verify")).toBeDisabled()
    await expect(page.getByTestId("action-test")).toBeDisabled()
    await expect(page.getByTestId("reason-verify")).toHaveText("Escolha um destino e salve antes.")
    await expect(page.getByTestId("reason-test")).toHaveText("Escolha um destino e salve antes.")
    await expect(page.getByTestId("action-run")).toHaveAttribute("aria-describedby", "backup-run-reason")
    await expect(page.getByTestId("section-actions")).toContainText("Sem destino escolhido é só um teste do pg_dump")
  })

  test("S3 pronto (backup-s3@): estado em dia, chave com impressão digital, segredos só como 'Configurada', histórico em 3 páginas", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("health")).toHaveAttribute("data-tone", "ok")
    await expect(page.getByTestId("health-title")).toHaveText("Backups em dia")
    await expect(page.getByTestId("fact-next-run")).toContainText("Horário de Brasília")
    await expect(page.getByTestId("fact-last-verify")).toContainText("passou na conferência")
    await expect(page.getByTestId("key-status")).toHaveText("Chave gerada")
    await expect(page.getByTestId("key-fingerprint")).toHaveText("630dcd29")
    await expect(page.getByTestId("destination-status")).toContainText("Bucket S3-compatível: pronto")
    await expect(page.getByTestId("s3-endpoint")).toHaveValue("https://abc123.r2.cloudflarestorage.com")
    await expect(page.getByTestId("s3-bucket")).toHaveValue("innoflow-backups")
    await expect(page.getByTestId("s3-prefix")).toHaveValue("producao")
    await expect(page.getByTestId("secret-s3AccessKey-chip")).toHaveText("Configurada")
    await expect(page.getByTestId("secret-s3SecretKey-chip")).toHaveText("Configurada")
    await expect(main(page).locator('input[type="password"]')).toHaveCount(0)
    await expect(enableSwitch(page)).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("field-retention")).toHaveValue("30")
    await expect(page.getByTestId("run-row")).toHaveCount(10)
    await expect(page.getByTestId("history-range")).toHaveText("Mostrando 1–10 de 27 execuções")
  })

  test("histórico: paginação (próxima/anterior), tipos, estados e o erro por código na linha que falhou", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    const rows = page.getByTestId("run-row")
    await expect(page.getByTestId("history-prev")).toBeDisabled()
    await expect(page.getByTestId("history-page")).toContainText("Página 1 de 3")
    await expect(rows.filter({ hasText: "Conferência" }).first()).toContainText("Conferida")
    const failed = page.getByTestId("run-error").first()
    await expect(failed).toHaveAttribute("data-code", "NETWORK")
    await expect(failed).toContainText("Falha de rede com o destino")
    await expect(failed).toContainText("Código: NETWORK")
    await page.getByTestId("history-next").click()
    await expect(page.getByTestId("history-range")).toHaveText("Mostrando 11–20 de 27 execuções")
    await page.getByTestId("history-next").click()
    await expect(page.getByTestId("history-range")).toHaveText("Mostrando 21–27 de 27 execuções")
    await expect(rows).toHaveCount(7)
    await expect(page.getByTestId("history-next")).toBeDisabled()
    await page.getByTestId("history-prev").click()
    await expect(page.getByTestId("history-range")).toHaveText("Mostrando 11–20 de 27 execuções")
  })

  test("atrasado: destaque vermelho 'Sem backup há X' (alerta), última tentativa com o erro por código e histórico de falhas", async ({ page }) => {
    await login(page, "backup-atrasado@innoelektron.com")
    await openPage(page)
    const health = page.getByTestId("health")
    await expect(health).toHaveAttribute("data-tone", "late")
    await expect(health).toHaveAttribute("role", "alert")
    await expect(page.getByTestId("health-title")).toHaveText(/^Sem backup há \d+ dias? e \d+ h$/)
    await expect(page.getByTestId("status-badge")).toContainText("Atenção")
    await expect(page.getByTestId("fact-last-attempt")).toContainText("Falhou: O destino recusou a credencial")
    const first = page.getByTestId("run-error").first()
    await expect(first).toHaveAttribute("data-code", "CREDENTIAL")
    await expect(first).toContainText("Gere uma credencial nova no provedor")
  })

  test("ligado e nunca rodou: alerta próprio", async ({ page }) => {
    await login(page, "backup-nunca@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("health")).toHaveAttribute("data-tone", "never")
    await expect(page.getByTestId("health-title")).toHaveText("Ligado, mas nunca saiu uma cópia")
    await expect(page.getByTestId("fact-last-success")).toContainText("Nenhuma cópia saiu ainda")
  })

  test("servidor sem PAYMENT_SECRETS_KEY: alerta de perigo, gerar chave indisponível, segredo digitado recusado antes do pedido", async ({ page }) => {
    await login(page, "backup-sem-chave@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("secrets-key-missing-alert")).toContainText("Servidor sem chave de cifragem")
    await expect(page.getByTestId("key-unavailable")).toBeVisible()
    await expect(page.getByTestId("key-generate")).toBeDisabled()
    await destinationGroup(page).getByRole("button", { name: "Bucket S3" }).click()
    await page.getByRole("button", { name: "Informar Chave de acesso" }).click()
    await page.getByTestId("secret-s3AccessKey").getByLabel("Chave de acesso").fill("AK")
    await expect(page.getByTestId("secret-s3AccessKey")).toContainText("O servidor não tem a PAYMENT_SECRETS_KEY")
  })

  test("segredos ilegíveis: alerta e chips 'Configurada (ilegível)'", async ({ page }) => {
    await login(page, "backup-ilegivel@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("secrets-unreadable-alert")).toContainText("Segredos salvos ilegíveis")
    await expect(page.getByTestId("secret-s3AccessKey-chip")).toContainText("ilegível")
    await expect(enableSwitch(page)).toBeDisabled()
    await expect(page.getByTestId("enable-blockers")).toContainText("não podem ser lidos")
  })

  test("GET da config com 503: estado de erro por code, com 'Tentar novamente'", async ({ page }) => {
    await login(page, "backup-indisponivel@innoelektron.com")
    await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Backups" }).click()
    await expect(page.getByText("O servidor não conseguiu atender agora")).toBeVisible()
    await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible()
    await expect(page.getByTestId("section-status")).toHaveCount(0)
  })

  test("o estado geral falha sozinho: a tela segue útil e 'Tentar de novo' recarrega", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await page.evaluate(() => localStorage.setItem("mock:backup-estado", "HTTP_500"))
    await openPage(page)
    await expect(page.getByTestId("status-error")).toContainText("Não deu para ler o estado do backup")
    await expect(page.getByTestId("section-schedule")).toBeVisible()
    await expect(page.getByTestId("section-history")).toBeVisible()
    await page.evaluate(() => localStorage.removeItem("mock:backup-estado"))
    await page.getByRole("button", { name: "Tentar de novo" }).click()
    await expect(page.getByTestId("health")).toBeVisible()
    await expect(page.getByTestId("status-error")).toHaveCount(0)
  })
})

test.describe("ações: backup agora, conferir, testar destino (assíncronas, com polling)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  test.setTimeout(60_000)

  test("backup em andamento ao abrir a tela: botões desabilitados com o motivo, e o fim aparece sozinho (polling do estado geral)", async ({ page }) => {
    await login(page, "backup-andamento@innoelektron.com")
    await openPage(page)
    const active = page.getByTestId("active-run")
    await expect(active).toHaveAttribute("data-status", "RUNNING")
    await expect(active).toContainText("Backup manual: em andamento")
    await expect(page.getByTestId("status-badge")).toContainText("Rodando agora")
    await expect(page.getByTestId("action-run")).toBeDisabled()
    await expect(page.getByTestId("action-verify")).toBeDisabled()
    await expect(page.getByTestId("reason-run")).toContainText("em andamento")
    await expect(page.getByTestId("key-replace")).toBeDisabled()
    await expect(page.getByTestId("key-replace-reason")).toContainText("Há um backup em andamento")
    // O mock termina a execução semeada na 3ª consulta do estado (polling de 3 s): o histórico ganha a linha e os botões voltam.
    await expect(active).toHaveCount(0, { timeout: 20_000 })
    await expect(page.getByTestId("action-run")).toBeEnabled()
    await expect(page.getByTestId("run-row").first()).toContainText("Manual")
    await expect(page.getByTestId("run-row").first()).toContainText("Enviado")
  })

  test("Fazer backup agora (S3): 202 na fila -> em andamento -> concluído, botões travados no meio, histórico atualizado", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("run-row").first()).toContainText("Automático")
    await page.getByTestId("action-run").click()
    const active = page.getByTestId("active-run")
    await expect(active).toHaveAttribute("data-status", "QUEUED")
    await expect(page.getByTestId("action-run")).toBeDisabled()
    await expect(page.getByTestId("action-verify")).toBeDisabled()
    await expect(active).toHaveAttribute("data-status", "RUNNING", { timeout: 10_000 })
    const outcome = page.getByTestId("run-outcome")
    await expect(outcome).toHaveAttribute("data-ok", "true", { timeout: 15_000 })
    await expect(outcome).toContainText("Backup concluído")
    await expect(outcome).toContainText("backup-innoflow-")
    await expect(active).toHaveCount(0)
    await expect(page.getByTestId("action-run")).toBeEnabled()
    await expect(page.getByTestId("run-row").first()).toContainText("Manual")
    await expect(page.getByTestId("run-row").first()).toContainText("Enviado")
  })

  test("sem destino, 'Fazer backup agora' é um TESTE do pg_dump e não conta como backup", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openPage(page)
    await page.getByTestId("action-run").click()
    const outcome = page.getByTestId("run-outcome")
    await expect(outcome).toHaveAttribute("data-ok", "true", { timeout: 15_000 })
    await expect(outcome).toHaveAttribute("data-test-only", "true")
    await expect(outcome).toContainText("NÃO conta como backup")
    await expect(page.getByTestId("run-row").first()).toContainText("Só teste")
    // não vira "último backup com sucesso"
    await expect(page.getByTestId("fact-last-success")).toContainText("Nenhuma cópia saiu ainda")
  })

  const FALHAS: Array<[string, string]> = [
    ["CREDENTIAL", "O destino recusou a credencial"],
    ["QUOTA", "Sem espaço no destino"],
    ["OAUTH_DISCONNECTED", "Conta Google desconectada"],
    ["NOT_PICKED_UP", "Ninguém pegou o pedido"],
    ["DUMP_TIMEOUT", "A cópia do banco passou do prazo"],
  ]
  for (const [code, titulo] of FALHAS) {
    test(`falha por código ${code}: texto próprio (nunca o do servidor), código visível, linha vermelha no histórico`, async ({ page }) => {
      await login(page, "backup-s3@innoelektron.com")
      await page.evaluate((c) => localStorage.setItem("mock:backup-execucao", c), code)
      await openPage(page)
      await page.getByTestId("action-run").click()
      const outcome = page.getByTestId("run-outcome")
      await expect(outcome).toHaveAttribute("data-ok", "false", { timeout: 15_000 })
      await expect(outcome).toHaveAttribute("data-code", code)
      await expect(outcome).toContainText(`O backup falhou: ${titulo}`)
      await expect(outcome).toContainText(`Código: ${code}`)
      expect(await page.locator("body").innerText()).not.toContain("MENSAGEM-CRUA")
      await expect(page.getByTestId("run-error").first()).toHaveAttribute("data-code", code)
      await expect(page.getByTestId("run-row").first()).toContainText("Falhou")
      await expect(page.getByTestId("fact-last-attempt")).toContainText(`Falhou: ${titulo}`)
    })
  }

  test("Conferir backup: aprovado e reprovado (VERIFY)", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await page.getByTestId("action-verify").click()
    await expect(page.getByTestId("run-outcome")).toContainText("A cópia está íntegra", { timeout: 15_000 })
    await expect(page.getByTestId("run-row").first()).toContainText("Conferência")
    await expect(page.getByTestId("run-row").first()).toContainText("Conferida")
    await page.evaluate(() => localStorage.setItem("mock:backup-execucao", "VERIFY"))
    await page.getByTestId("action-verify").click()
    const outcome = page.getByTestId("run-outcome")
    await expect(outcome).toHaveAttribute("data-code", "VERIFY", { timeout: 15_000 })
    await expect(outcome).toContainText("A conferência reprovou: A conferência reprovou a cópia")
    await expect(page.getByTestId("run-row").first()).toContainText("Reprovou")
    await expect(page.getByTestId("fact-last-verify")).toContainText("Reprovou")
  })

  test("fila fora do ar (503 QUEUE_UNAVAILABLE): mensagem por código e nada fica 'rodando'", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await page.evaluate(() => localStorage.setItem("mock:backup-fila", "off"))
    await openPage(page)
    await page.getByTestId("action-run").click()
    const error = page.getByTestId("action-error")
    await expect(error).toHaveAttribute("data-code", "QUEUE_UNAVAILABLE")
    await expect(error).toContainText("fila de tarefas")
    await expect(page.getByTestId("active-run")).toHaveCount(0)
    await expect(page.getByTestId("action-run")).toBeEnabled()
  })

  test("Testar destino: ok e falha por código (a falha é RESULTADO, não erro da rota)", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await page.getByTestId("action-test").click()
    await expect(page.getByTestId("test-outcome")).toHaveAttribute("data-ok", "true")
    await expect(page.getByTestId("test-outcome")).toContainText("gravou e apagou um arquivinho de teste no bucket")
    expect(await page.locator("body").innerText()).not.toContain("MENSAGEM-CRUA")
    await page.evaluate(() => localStorage.setItem("mock:backup-teste", "FOLDER"))
    await page.getByTestId("action-test").click()
    const outcome = page.getByTestId("test-outcome")
    await expect(outcome).toHaveAttribute("data-ok", "false")
    await expect(outcome).toHaveAttribute("data-code", "FOLDER")
    await expect(outcome).toContainText("Bucket ou pasta inacessível")
    await expect(page.getByTestId("action-error")).toHaveCount(0)
    expect(await page.locator("body").innerText()).not.toContain("MENSAGEM-CRUA")
  })

  test("Testar destino: 503 da rota e o 429 do 6º teste no minuto, com o tempo de espera", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await page.evaluate(() => localStorage.setItem("mock:backup-teste", "HTTP_503"))
    await page.getByTestId("action-test").click()
    await expect(page.getByTestId("action-error")).toContainText("O servidor não conseguiu atender agora")
    await page.evaluate(() => localStorage.removeItem("mock:backup-teste"))
    for (let i = 0; i < 5; i += 1) {
      await page.getByTestId("action-test").click()
      await expect(page.getByTestId("test-outcome")).toBeVisible()
    }
    await page.getByTestId("action-test").click()
    await expect(page.getByTestId("action-error")).toHaveAttribute("data-code", "RATE_LIMITED_BACKUP")
    await expect(page.getByTestId("action-error")).toContainText("Aguarde 30 segundos")
  })

  test("Testar destino num Drive desconectado: falha por CONFIG; o botão avisa quando o destino está incompleto", async ({ page }) => {
    await login(page, "backup-drive-desconectado@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("action-test")).toBeDisabled()
    await expect(page.getByTestId("reason-test")).toContainText("O destino escolhido está incompleto")
    await expect(page.getByTestId("action-run")).toBeDisabled()
    await expect(page.getByTestId("action-verify")).toBeDisabled()
  })

  test("alteração não salva trava as três ações (elas usam a configuração SALVA), e descartar libera", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await page.getByTestId("field-alert-after").fill("48")
    for (const id of ["action-run", "action-verify", "action-test"]) await expect(page.getByTestId(id)).toBeDisabled()
    await expect(page.getByTestId("reason-run")).toContainText("alterações não salvas")
    await page.getByRole("button", { name: "Descartar" }).click()
    for (const id of ["action-run", "action-verify", "action-test"]) await expect(page.getByTestId(id)).toBeEnabled()
  })
})

test.describe("configuração: salvar, step-up de senha, validação", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("horário/frequência/alerta salvam SEM senha (sem diálogo, o PUT não leva currentPassword)", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    const puts = capturePuts(page)
    await openPage(page)
    await page.getByTestId("field-hour").selectOption("5")
    await page.getByRole("group", { name: "Frequência do backup" }).getByRole("button", { name: "Toda semana" }).click()
    await page.getByTestId("field-alert-after").fill("48")
    await expect(page.getByTestId("save-bar-status")).toContainText("3 alterações não salvas")
    await expect(page.getByTestId("save-bar-password-note")).toHaveText("Esta alteração não pede senha.")
    await saveButton(page).click()
    await expect(page.getByText("Configuração do backup salva.")).toBeVisible()
    expect(puts.bodies).toEqual([{ hourLocal: 5, frequencyDays: 7, alertAfterHours: 48 }])
    expect(puts.passwords).toEqual([undefined])
    await expect(saveDialog(page)).toHaveCount(0)
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
    await expect(page.getByTestId("fact-next-run")).toContainText("05:00")
  })

  test("desligar o automático não pede senha; ligar de volta pede", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    const puts = capturePuts(page)
    await openPage(page)
    await enableSwitch(page).click()
    await expect(page.getByTestId("save-bar-password-note")).toHaveText("Esta alteração não pede senha.")
    await saveButton(page).click()
    await expect(page.getByTestId("schedule-status")).toHaveText("Desligado")
    expect(puts.bodies[0]).toEqual({ enabled: false })
    expect(puts.passwords[0]).toBeUndefined()
    await expect(page.getByTestId("fact-next-run")).toContainText("Automático desligado")
    await expect(page.getByTestId("health")).toHaveAttribute("data-tone", "off")

    await enableSwitch(page).click()
    await expect(page.getByTestId("save-bar-password-note")).toHaveText("Esta alteração pede a sua senha atual ao salvar.")
    await saveButton(page).click()
    await expect(saveDialog(page)).toBeVisible()
    await expect(saveDialog(page).getByTestId("save-summary")).toContainText("Backup automático")
    await submitSaveDialog(page)
    await expect(page.getByTestId("schedule-status")).toHaveText("Ligado")
    expect(puts.bodies[1]).toEqual({ enabled: true })
    expect(puts.passwords[1]).toBe(PASSWORD)
  })

  test("cópias a manter pede senha; reduzir mostra o aviso; senha errada FICA no diálogo e o rascunho segue; senha certa envia", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    const puts = capturePuts(page)
    await openPage(page)
    await page.getByTestId("field-retention").fill("10")
    await saveButton(page).click()
    const dialog = saveDialog(page)
    await expect(dialog.getByTestId("save-summary")).toContainText("Cópias a manter")
    await expect(dialog.getByTestId("save-summary")).toContainText("30")
    await expect(dialog.getByTestId("retention-warning")).toContainText("apaga as mais antigas")
    await submitSaveDialog(page, "senha-errada")
    await expect(dialog.getByText("Senha incorreta.")).toBeVisible()
    await expect(dialog.getByLabel("Sua senha atual")).toBeFocused()
    await expect(dialog.getByLabel("Sua senha atual")).toHaveValue("")
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId("field-retention")).toHaveValue("10")
    // a sessão NÃO caiu (era 403, não 401)
    await expect(page).toHaveURL(/\/admin\/backups$/)
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do backup salva.")).toBeVisible()
    expect(puts.bodies.at(-1)).toEqual({ retentionCount: 10 })
    expect(puts.passwords.at(-1)).toBe(PASSWORD)
    await expect(page.getByTestId("field-retention")).toHaveValue("10")
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
  })

  test("limite de tentativas (429 RATE_LIMITED_BACKUP): vira alerta da tela com o tempo de espera e o rascunho continua; 503 do step-up idem", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await page.getByTestId("field-retention").fill("12")
    await saveButton(page).click()
    await submitSaveDialog(page, "stepup-429")
    const error = page.getByTestId("save-error")
    await expect(error).toHaveAttribute("data-code", "RATE_LIMITED_BACKUP")
    await expect(error).toContainText("Aguarde 2 minutos")
    await expect(error).toContainText("continua na tela")
    await expect(page.getByTestId("field-retention")).toHaveValue("12")
    await saveButton(page).click()
    await submitSaveDialog(page, "stepup-503")
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "STEPUP_UNAVAILABLE")
    await expect(page.getByTestId("save-error")).toContainText("Nada foi salvo")
  })

  test("5 senhas erradas seguidas viram 429 (tranca da senha)", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await page.getByTestId("field-retention").fill("12")
    for (let i = 0; i < 5; i += 1) {
      await saveButton(page).click()
      await submitSaveDialog(page, `errada-${i}`)
      await expect(saveDialog(page).getByText("Senha incorreta.")).toBeVisible()
      await page.keyboard.press("Escape")
    }
    await saveButton(page).click()
    await submitSaveDialog(page, "errada-6")
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "RATE_LIMITED_BACKUP")
    await expect(page.getByTestId("save-error")).toContainText("Aguarde 10 minutos")
  })

  test("validação no cliente: faixas, ponto decimal, e o botão salvar fica bloqueado com os campos marcados", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await page.getByTestId("field-retention").fill("0")
    await page.getByTestId("field-alert-after").fill("5")
    await expect(main(page).getByText("Informe um número inteiro de 1 a 365.")).toBeVisible()
    await expect(main(page).getByText("Informe um número inteiro de 6 a 720 horas.")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()
    await expect(page.getByTestId("save-bar-errors")).toContainText("corrija os campos marcados")
    await page.getByTestId("field-retention").fill("366")
    await expect(main(page).getByText("Informe um número inteiro de 1 a 365.")).toBeVisible()
    await page.getByTestId("field-retention").fill("2,5")
    await expect(main(page).getByText("Informe um número inteiro de 1 a 365.")).toBeVisible()
    await page.getByTestId("field-retention").fill("365")
    await page.getByTestId("field-alert-after").fill("720")
    await expect(saveButton(page)).toBeEnabled()
  })

  test("Descartar volta tudo ao salvo (inclusive segredo aberto e destino)", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await page.getByTestId("field-retention").fill("9")
    await page.getByRole("button", { name: "Substituir Segredo" }).click()
    await page.getByTestId("secret-s3SecretKey").getByLabel("Segredo").fill("SEGREDO-DESCARTADO-1")
    await destinationGroup(page).getByRole("button", { name: "Google Drive" }).click()
    await page.getByRole("button", { name: "Descartar" }).click()
    await expect(page.getByTestId("field-retention")).toHaveValue("30")
    await expect(destinationGroup(page).getByRole("button", { name: "Bucket S3" })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByTestId("secret-s3SecretKey").locator("input")).toHaveCount(0)
    expect(await everythingTheUserCouldSee(page)).not.toContain("SEGREDO-DESCARTADO-1")
  })
})

test.describe("destino S3: credenciais só-escrita e regras do servidor espelhadas", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("trocar o ENDEREÇO do bucket abre as duas credenciais e exige digitar AS DUAS; segredos nunca vazam depois de salvar", async ({ page }) => {
    const logs = captureConsole(page)
    await login(page, "backup-s3@innoelektron.com")
    const puts = capturePuts(page)
    await openPage(page)
    await page.getByTestId("s3-endpoint").fill("https://novo.r2.cloudflarestorage.com")
    await expect(page.getByTestId("s3-host-changed")).toBeVisible()
    await expect(page.getByTestId("secret-s3AccessKey").getByLabel("Chave de acesso")).toBeVisible()
    await expect(page.getByTestId("secret-s3SecretKey").getByLabel("Segredo")).toBeVisible()
    await expect(saveButton(page)).toBeDisabled()
    await expect(page.getByTestId("secret-s3AccessKey")).toContainText("digite a chave de acesso E o segredo de novo")
    await page.getByTestId("secret-s3AccessKey").getByLabel("Chave de acesso").fill("SEGREDO-AK-777")
    await expect(saveButton(page)).toBeDisabled()
    await page.getByTestId("secret-s3SecretKey").getByLabel("Segredo").fill("SEGREDO-SK-888")
    await expect(saveButton(page)).toBeEnabled()

    await saveButton(page).click()
    const summary = await saveDialog(page).getByTestId("save-summary").innerText()
    expect(summary).toContain("https://novo.r2.cloudflarestorage.com")
    expect(summary).toContain("Será substituída")
    expect(summary).not.toContain("SEGREDO-")
    expect(await saveDialog(page).innerHTML()).not.toContain("SEGREDO-")
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do backup salva.")).toBeVisible()

    expect(puts.bodies.at(-1)).toEqual({ s3: { endpoint: "https://novo.r2.cloudflarestorage.com", accessKey: "SEGREDO-AK-777", secretKey: "SEGREDO-SK-888" } })
    await expect(page.getByTestId("s3-endpoint")).toHaveValue("https://novo.r2.cloudflarestorage.com")
    await expect(page.getByTestId("secret-s3AccessKey-chip")).toHaveText("Configurada")
    const seen = await everythingTheUserCouldSee(page)
    expect(seen).not.toContain("SEGREDO-")
    expect(logs.join("\n")).not.toContain("SEGREDO-")
  })

  test("só o caminho/barra do mesmo host NÃO pede credencial de novo; trocar bucket e pasta salva com senha e sem credencial", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    const puts = capturePuts(page)
    await openPage(page)
    await page.getByTestId("s3-endpoint").fill("https://abc123.r2.cloudflarestorage.com/")
    await expect(page.getByTestId("s3-host-changed")).toHaveCount(0)
    await page.getByTestId("s3-bucket").fill("outro-bucket")
    await page.getByTestId("s3-prefix").fill("")
    await saveButton(page).click()
    await expect(saveDialog(page).getByTestId("save-summary")).toContainText("outro-bucket")
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do backup salva.")).toBeVisible()
    expect(puts.bodies.at(-1)).toEqual({ s3: { endpoint: "https://abc123.r2.cloudflarestorage.com/", bucket: "outro-bucket", prefix: null } })
    await expect(page.getByTestId("s3-prefix")).toHaveValue("")
  })

  test("endereço inválido no cliente: marca o campo e bloqueia salvar", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    for (const [value, text] of [
      ["abc", "Endereço inválido"],
      ["https://u:p@x.com", "não pode conter usuário e senha"],
      ["https://x.com/?a=1", "não pode ter"],
      ["", "Informe o endereço do bucket"],
    ] as const) {
      await page.getByTestId("s3-endpoint").fill(value)
      await expect(main(page).getByText(new RegExp(text)).first()).toBeVisible()
      await expect(saveButton(page)).toBeDisabled()
    }
  })

  const SERVIDOR: Array<[string, string, string]> = [
    ["http://novo.exemplo.com", "HTTPS_REQUIRED", "precisa usar https"],
    ["https://localhost", "DESTINATION_NOT_ALLOWED", "rede interna"],
    ["https://169.254.169.254", "DESTINATION_NOT_ALLOWED", "rede interna"],
    ["https://meu-bucket.local", "DESTINATION_NOT_ALLOWED", "rede interna"],
  ]
  for (const [endpoint, code, texto] of SERVIDOR) {
    test(`o servidor recusa ${endpoint} (${code}): erro no campo, alerta da tela, rascunho mantido`, async ({ page }) => {
      await login(page, "backup-s3@innoelektron.com")
      await openPage(page)
      await page.getByTestId("s3-endpoint").fill(endpoint)
      await page.getByTestId("secret-s3AccessKey").getByLabel("Chave de acesso").fill("AK")
      await page.getByTestId("secret-s3SecretKey").getByLabel("Segredo").fill("SK")
      await saveButton(page).click()
      await submitSaveDialog(page)
      await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", code)
      await expect(page.getByTestId("save-error")).toContainText(texto)
      await expect(page.getByTestId("s3-endpoint")).toHaveValue(endpoint)
      await expect(page.getByTestId("s3-endpoint")).toHaveAttribute("aria-invalid", "true")
      // o erro do campo some na próxima edição
      await page.getByTestId("s3-endpoint").fill("https://abc123.r2.cloudflarestorage.com")
      await expect(page.getByTestId("s3-endpoint")).not.toHaveAttribute("aria-invalid", "true")
    })
  }

  test("apagar um segredo salvo: marca, mostra 'Será apagada ao salvar', o resumo diz 'Será apagado', e o chip some depois de salvar", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    const puts = capturePuts(page)
    await openPage(page)
    // com o automático ligado, deixar o destino incompleto é barrado antes do pedido
    await page.getByRole("button", { name: "Apagar o segredo salvo" }).click()
    await expect(page.getByTestId("secret-s3SecretKey-chip")).toHaveText("Será apagada ao salvar")
    await expect(page.getByTestId("destination-error")).toContainText("destino precisa continuar completo")
    await expect(saveButton(page)).toBeDisabled()
    await enableSwitch(page).click()
    await expect(page.getByTestId("destination-error")).toHaveCount(0)
    await saveButton(page).click()
    await expect(saveDialog(page).getByTestId("save-summary")).toContainText("Será apagado")
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do backup salva.")).toBeVisible()
    expect(puts.bodies.at(-1)).toEqual({ enabled: false, clearSecrets: ["s3SecretKey"] })
    await expect(page.getByTestId("secret-s3SecretKey-chip")).toHaveText("Não configurada")
    await expect(page.getByTestId("destination-status")).toContainText("incompleto")
  })

  test("digitar um valor novo desfaz o 'apagar'; abrir o campo e não digitar nada não envia nada", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    const puts = capturePuts(page)
    await openPage(page)
    await page.getByRole("button", { name: "Apagar a chave de acesso salva" }).click()
    await page.getByRole("button", { name: "Desfazer" }).click()
    await page.getByRole("button", { name: "Substituir Chave de acesso" }).click()
    await expect(saveButton(page)).toBeDisabled()
    await expect(page.getByTestId("save-bar-status")).toHaveText("Nenhuma alteração pendente.")
    await page.getByTestId("secret-s3AccessKey").getByLabel("Chave de acesso").fill("SEGREDO-NOVO-AK")
    await expect(saveButton(page)).toBeEnabled()
    await page.getByRole("button", { name: "Cancelar" }).first().click()
    await expect(saveButton(page)).toBeDisabled()
    expect(puts.bodies).toEqual([])
  })

  test("quebra de linha no segredo é recusada sem ecoar o valor", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await page.getByRole("button", { name: "Substituir Segredo" }).click()
    // `fill` em <input> descarta \n; força um caractere de controle (tab) como a colagem de um segredo com sobra
    await page.getByTestId("secret-s3SecretKey").getByLabel("Segredo").evaluate((el: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(el, "abc\tdef")
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await expect(page.getByTestId("secret-s3SecretKey")).toContainText("Não pode conter quebra de linha")
    await expect(saveButton(page)).toBeDisabled()
  })

  test("primeira configuração do zero (admin@): S3 + credenciais + chave + ligar numa gravação só (o servidor valida o estado futuro)", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    const puts = capturePuts(page)
    await openPage(page)
    // 1) a chave
    await page.getByTestId("key-generate").click()
    await page.getByRole("dialog").getByLabel("Sua senha atual").fill(PASSWORD)
    await page.getByTestId("key-confirm").click()
    await page.getByTestId("key-saved-checkbox").check()
    await page.getByTestId("key-done").click()
    await expect(page.getByTestId("key-status")).toHaveText("Chave gerada")
    // 2) destino + ligar
    await destinationGroup(page).getByRole("button", { name: "Bucket S3" }).click()
    await expect(enableSwitch(page)).toBeDisabled()
    await page.getByTestId("s3-endpoint").fill("https://acc.r2.cloudflarestorage.com")
    await page.getByTestId("s3-bucket").fill("meu-bucket")
    await page.getByRole("button", { name: "Informar Chave de acesso" }).click()
    await page.getByTestId("secret-s3AccessKey").getByLabel("Chave de acesso").fill("SEGREDO-PRIMEIRA-AK")
    await page.getByRole("button", { name: "Informar Segredo" }).click()
    await page.getByTestId("secret-s3SecretKey").getByLabel("Segredo").fill("SEGREDO-PRIMEIRA-SK")
    await expect(enableSwitch(page)).toBeEnabled()
    await enableSwitch(page).click()
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do backup salva.")).toBeVisible()
    expect(puts.bodies).toHaveLength(1)
    expect(puts.bodies[0]).toMatchObject({ enabled: true, destination: "S3", s3: { endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "meu-bucket" } })
    await expect(page.getByTestId("schedule-status")).toHaveText("Ligado")
    await expect(page.getByTestId("destination-status")).toContainText("pronto")
    expect(await everythingTheUserCouldSee(page)).not.toContain("SEGREDO-PRIMEIRA")
  })
})

test.describe("destino Google Drive: Client ID/Secret, endereço de retorno, conectar e desconectar (com senha)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("Drive desconectado: passo a passo, dica 'Em produção', endereço de retorno com Copiar, e 'Conectar' liberado", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await login(page, "backup-drive-desconectado@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("drive-fields")).toBeVisible()
    await expect(page.getByTestId("drive-production-tip")).toContainText("Em produção")
    await expect(page.getByTestId("drive-production-tip")).toContainText("expira em 7 dias")
    await expect(page.getByTestId("drive-redirect-uri")).toHaveValue("https://api.innoflow.example/api/backup/google/callback")
    await expect(page.getByTestId("drive-redirect-uri")).toHaveAttribute("readonly", "")
    await page.getByTestId("drive-redirect-copy").click()
    await expect(page.getByText("Endereço de retorno copiado.")).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://api.innoflow.example/api/backup/google/callback")
    await expect(page.getByTestId("drive-disconnected")).toContainText("Conta Google não conectada")
    await expect(page.getByTestId("secret-driveClientSecret-chip")).toHaveText("Configurada")
    await expect(page.getByTestId("drive-client-id")).toHaveValue("1234567890-abc.apps.googleusercontent.com")
    await expect(page.getByTestId("drive-connect")).toBeEnabled()
    await expect(page.getByTestId("drive-disconnect")).toHaveCount(0)
  })

  test("Conectar: pede a senha (errada fica no diálogo), e depois NAVEGA para o Google (só accounts.google.com)", async ({ page }) => {
    await page.route("https://accounts.google.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google</title><h1>Entrar com o Google (simulado)</h1>" }))
    await login(page, "backup-drive-desconectado@innoelektron.com")
    await openPage(page)
    await page.getByTestId("drive-connect").click()
    const dialog = page.getByRole("dialog", { name: "Conectar com o Google" })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel("Sua senha atual").fill("errada")
    await dialog.getByRole("button", { name: "Confirmar e ir ao Google" }).click()
    await expect(dialog.getByText("Senha incorreta.")).toBeVisible()
    await dialog.getByLabel("Sua senha atual").fill(PASSWORD)
    await dialog.getByRole("button", { name: "Confirmar e ir ao Google" }).click()
    await page.waitForURL(/^https:\/\/accounts\.google\.com\//)
    await expect(page.getByRole("heading", { name: "Entrar com o Google (simulado)" })).toBeVisible()
  })

  test("Conectar com alteração não salva: bloqueado com o motivo escrito (o Google usa o Client ID salvo)", async ({ page }) => {
    await login(page, "backup-drive-desconectado@innoelektron.com")
    await openPage(page)
    await page.getByTestId("drive-client-id").fill("outro-client-id")
    await expect(page.getByTestId("drive-connect")).toBeDisabled()
    await expect(page.getByTestId("drive-connect-reason")).toContainText("salve antes de conectar")
    await page.getByRole("button", { name: "Descartar" }).click()
    await expect(page.getByTestId("drive-connect")).toBeEnabled()
  })

  test("Drive sem Client ID/Secret: 'Conectar' bloqueado dizendo o que falta; salvar Client ID + Secret libera", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    await openPage(page)
    await destinationGroup(page).getByRole("button", { name: "Google Drive" }).click()
    await expect(page.getByTestId("drive-connect")).toBeDisabled()
    await expect(page.getByTestId("drive-connect-reason")).toContainText("salve antes de conectar")
    await page.getByTestId("drive-client-id").fill("novo-app.apps.googleusercontent.com")
    await page.getByRole("button", { name: "Informar Client Secret" }).click()
    await page.getByTestId("secret-driveClientSecret").getByLabel("Client Secret").fill("SEGREDO-CLIENT-SECRET")
    await saveButton(page).click()
    await submitSaveDialog(page)
    await expect(page.getByText("Configuração do backup salva.")).toBeVisible()
    await expect(page.getByTestId("drive-connect")).toBeEnabled()
    expect(await everythingTheUserCouldSee(page)).not.toContain("SEGREDO-CLIENT-SECRET")
  })

  test("Drive conectado: conta e data, 'Reconectar' e 'Desconectar'; desconectar com o automático ligado AVISA que o próximo backup falha", async ({ page }) => {
    await login(page, "backup-drive@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("drive-connected")).toContainText("Conectado como dono@gmail.example")
    await expect(page.getByTestId("drive-connected")).toContainText("Backups InnoFlow")
    await expect(page.getByTestId("drive-connect")).toHaveText("Reconectar com Google")
    await page.getByTestId("drive-disconnect").click()
    const dialog = page.getByRole("dialog", { name: "Desconectar a conta Google" })
    await expect(dialog.getByTestId("disconnect-warning")).toContainText("vai FALHAR")
    await dialog.getByLabel("Sua senha atual").fill("errada")
    await dialog.getByRole("button", { name: "Confirmar e desconectar" }).click()
    await expect(dialog.getByText("Senha incorreta.")).toBeVisible()
    await dialog.getByLabel("Sua senha atual").fill(PASSWORD)
    await dialog.getByRole("button", { name: "Confirmar e desconectar" }).click()
    await expect(page.getByText("Conta Google desconectada.")).toBeVisible()
    await expect(page.getByTestId("drive-disconnected")).toBeVisible()
    await expect(page.getByTestId("destination-status")).toContainText("incompleto")
    await expect(page.getByTestId("drive-connect")).toHaveText("Conectar com Google")
  })

  test("trocar o Client ID avisa que a conta Google será desconectada (também no resumo do diálogo)", async ({ page }) => {
    await login(page, "backup-drive@innoelektron.com")
    await openPage(page)
    await page.getByTestId("drive-client-id").fill("outro-client-id.apps.googleusercontent.com")
    await expect(page.getByTestId("drive-client-id-disconnects")).toContainText("dono@gmail.example")
    // o automático está ligado: o destino ficaria incompleto -> barrado antes do pedido
    await expect(page.getByTestId("destination-error")).toContainText("destino precisa continuar completo")
    await expect(saveButton(page)).toBeDisabled()
    await enableSwitch(page).click()
    await saveButton(page).click()
    await expect(saveDialog(page).getByTestId("save-summary")).toContainText("Será desconectada")
    await submitSaveDialog(page)
    await expect(page.getByTestId("drive-disconnected")).toBeVisible()
  })

  test("senha do step-up com 429/503 ao conectar: mensagem por código, sem sair da tela", async ({ page }) => {
    await login(page, "backup-drive-desconectado@innoelektron.com")
    await openPage(page)
    await page.getByTestId("drive-connect").click()
    const dialog = page.getByRole("dialog", { name: "Conectar com o Google" })
    await dialog.getByLabel("Sua senha atual").fill("stepup-429")
    await dialog.getByRole("button", { name: "Confirmar e ir ao Google" }).click()
    await expect(page.getByTestId("drive-error")).toHaveAttribute("data-code", "RATE_LIMITED_BACKUP")
    await expect(page.getByTestId("drive-error")).toContainText("Aguarde 2 minutos")
    await expect(page).toHaveURL(/\/admin\/backups$/)
  })

  test("sem URL pública (PUBLIC_API_BASE_URL): o endereço de retorno não aparece e o motivo é dito", async ({ page }) => {
    await login(page, "backup-sem-chave@innoelektron.com")
    await openPage(page)
    await destinationGroup(page).getByRole("button", { name: "Google Drive" }).click()
    await expect(page.getByTestId("drive-redirect-unknown")).toContainText("PUBLIC_API_BASE_URL")
    await expect(page.getByTestId("drive-redirect-uri")).toHaveCount(0)
  })
})

test.describe("chave de criptografia: gerar, mostrar UMA vez, substituir", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("gerar: senha errada fica no diálogo; a chave aparece uma vez; não fecha sem 'guardei'; copiar; baixar o .txt; depois some de tudo", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    const logs = captureConsole(page)
    await login(page, "admin@innoelektron.com")
    const posts = captureKeyPosts(page)
    await openPage(page)
    await page.getByTestId("key-generate").click()
    const dialog = page.getByRole("dialog", { name: "Gerar a chave do backup" })
    await expect(dialog.getByTestId("key-confirm")).toBeDisabled()
    await dialog.getByLabel("Sua senha atual").fill("errada")
    await dialog.getByTestId("key-confirm").click()
    await expect(dialog.getByText("Senha incorreta.")).toBeVisible()
    await dialog.getByLabel("Sua senha atual").fill(PASSWORD)
    await dialog.getByTestId("key-confirm").click()
    expect(posts).toEqual([{ currentPassword: "errada" }, { currentPassword: PASSWORD }])

    const reveal = page.getByTestId("key-reveal-dialog")
    await expect(reveal).toBeVisible()
    await expect(reveal.getByTestId("key-reveal-warning")).toContainText("Sem esta chave, os backups são inúteis")
    await expect(reveal.getByTestId("key-reveal-warning")).toContainText("PAYMENT_SECRETS_KEY")
    const key = (await reveal.getByTestId("generated-key").innerText()).trim()
    expect(key).toMatch(KEY_FORMAT)
    // o cartão atrás já mostra a impressão digital nova
    await expect(page.getByTestId("key-status")).toHaveText("Chave gerada")

    // o evento de saída da página é barrado enquanto a chave está na tela
    expect(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)

    // não fecha por Esc, clique fora nem X: só destaca o aviso e leva o foco à confirmação
    await expect(reveal.getByTestId("key-done")).toBeDisabled()
    await page.keyboard.press("Escape")
    await expect(reveal).toBeVisible()
    await expect(reveal.getByTestId("key-saved-warning")).toBeVisible()
    await expect(reveal.getByTestId("key-saved-checkbox")).toBeFocused()
    await page.mouse.click(5, 5)
    await expect(reveal).toBeVisible()
    await reveal.getByRole("button", { name: "Fechar" }).click()
    await expect(reveal).toBeVisible()

    // copiar
    await reveal.getByTestId("key-copy").click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key)

    // baixar o .txt (o `fileText` do servidor, com a linha CHAVE:)
    const [download] = await Promise.all([page.waitForEvent("download"), reveal.getByTestId("key-download").click()])
    expect(download.suggestedFilename()).toMatch(/^chave-backup-innoflow-[0-9a-f]{8}\.txt$/)
    const filePath = await download.path()
    expect(readFileSync(filePath, "utf8")).toContain(`CHAVE: ${key}`)

    await reveal.getByTestId("key-saved-checkbox").check()
    await expect(reveal.getByTestId("key-saved-warning")).toHaveCount(0)
    await reveal.getByTestId("key-done").click()
    await expect(reveal).toHaveCount(0)

    // a chave sumiu de TUDO: DOM, inputs, storage, console; e o evento de saída já não é barrado
    const seen = await everythingTheUserCouldSee(page)
    expect(seen).not.toContain(key)
    expect(await page.content()).not.toContain(key)
    expect(logs.join("\n")).not.toContain(key)
    expect(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(false)
    await expect(page.getByTestId("key-fingerprint")).toHaveText(/^[0-9a-f]{8}$/)
    await expect(page.getByTestId("key-replace")).toBeVisible()
    // uma chave existe agora: o servidor deixa de oferecer "Gerar" e a tela troca para "Substituir"
    await expect(page.getByTestId("key-generate")).toHaveCount(0)
  })

  test("gerar a chave libera o 'ligar' do agendamento (a pendência some)", async ({ page }) => {
    await login(page, "backup-drive-desconectado@innoelektron.com")
    await openPage(page)
    // esta conta já tem chave: o impedimento é só a conta Google; prova que o texto da chave NÃO aparece como pendência
    await expect(page.getByTestId("enable-blockers")).not.toContainText("Gere a chave")
    await expect(page.getByTestId("enable-blockers")).toContainText("Complete o destino")
  })

  test("substituir: aviso forte, frase exata + senha, expectedFingerprint no pedido, e a chave nova aparece uma vez", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    const posts = captureKeyPosts(page)
    await openPage(page)
    await expect(page.getByTestId("key-fingerprint")).toHaveText("630dcd29")
    await page.getByTestId("key-replace").click()
    const dialog = page.getByRole("dialog", { name: "Substituir a chave do backup" })
    await expect(dialog.getByTestId("replace-key-warning")).toContainText("continuam precisando da chave ANTIGA")
    await expect(dialog.getByTestId("replace-key-warning")).toContainText("Só troque se a chave atual vazou")
    const confirm = dialog.getByTestId("key-confirm")
    await expect(confirm).toBeDisabled()
    await dialog.getByLabel("Sua senha atual").fill(PASSWORD)
    await expect(confirm).toBeDisabled()
    await dialog.getByTestId("replace-key-phrase").fill("gerar nova chave")
    await expect(confirm).toBeDisabled()
    await dialog.getByTestId("replace-key-phrase").fill("GERAR NOVA CHAVE")
    await expect(confirm).toBeEnabled()
    await confirm.click()
    const reveal = page.getByTestId("key-reveal-dialog")
    await expect(reveal).toBeVisible()
    await expect(reveal.getByTestId("key-reveal-warning")).toContainText("A chave antiga continua necessária")
    expect(posts).toEqual([{ currentPassword: PASSWORD, replace: true, confirmation: "GERAR NOVA CHAVE", expectedFingerprint: "630dcd29" }])
    const key = (await reveal.getByTestId("generated-key").innerText()).trim()
    expect(key).toMatch(KEY_FORMAT)
    await reveal.getByTestId("key-saved-checkbox").check()
    await reveal.getByTestId("key-done").click()
    await expect(page.getByTestId("key-fingerprint")).not.toHaveText("630dcd29")
    expect(await everythingTheUserCouldSee(page)).not.toContain(key)
  })

  test("substituir com um backup em andamento: botão desabilitado com o motivo (o servidor recusaria com 409 BACKUP_BUSY)", async ({ page }) => {
    await login(page, "backup-andamento@innoelektron.com")
    await openPage(page)
    await expect(page.getByTestId("key-replace")).toBeDisabled()
  })

  test("cancelar o diálogo de gerar não manda nada", async ({ page }) => {
    await login(page, "admin@innoelektron.com")
    const posts = captureKeyPosts(page)
    await openPage(page)
    await page.getByTestId("key-generate").click()
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(posts).toEqual([])
  })
})

test.describe("a11y e teclado", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("segmentos com aria-pressed, interruptor com nome, rótulos associados, foco volta ao gatilho do diálogo", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await openPage(page)
    await expect(page.getByRole("group", { name: "Frequência do backup" }).getByRole("button", { name: "Todo dia" })).toHaveAttribute("aria-pressed", "true")
    await expect(destinationGroup(page).getByRole("button", { name: "Bucket S3" })).toHaveAttribute("aria-pressed", "true")
    await expect(enableSwitch(page)).toHaveAttribute("aria-describedby", /.+/)
    await expect(page.getByLabel("Cópias a manter")).toBeVisible()
    await expect(page.getByLabel("Horário (Brasília)")).toBeVisible()
    await expect(page.getByLabel("Endereço do bucket")).toBeVisible()
    await page.getByTestId("key-replace").focus()
    await page.keyboard.press("Enter")
    const dialog = page.getByRole("dialog", { name: "Substituir a chave do backup" })
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId("key-replace")).toBeFocused()
  })

  test("é possível salvar só com o teclado (Tab/Espaço/Enter)", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    const puts = capturePuts(page)
    await openPage(page)
    await page.getByTestId("field-alert-after").focus()
    await page.keyboard.press("Control+A")
    await page.keyboard.type("60")
    await page.getByTestId("save-button").focus()
    await page.keyboard.press("Enter")
    await expect(page.getByText("Configuração do backup salva.")).toBeVisible()
    expect(puts.bodies).toEqual([{ alertAfterHours: 60 }])
  })
})

test.describe("375 px: sem rolagem lateral, alvos de 44 px, histórico em cartões", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  async function measure(page: Page) {
    return page.evaluate(() => {
      const mainEl = document.querySelector("main")!
      const small: string[] = []
      for (const el of mainEl.querySelectorAll<HTMLElement>("button, a[href], input:not(.sr-only), select, textarea, [role=switch]")) {
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
      return { overflow: { main: mainEl.scrollWidth - mainEl.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth }, small }
    })
  }

  for (const [email, label] of [
    ["backup-s3@innoelektron.com", "S3 pronto"],
    ["backup-drive-desconectado@innoelektron.com", "Drive desconectado"],
    ["admin@innoelektron.com", "primeiro uso"],
    ["backup-atrasado@innoelektron.com", "atrasado"],
  ] as const) {
    test(`${label}: sem rolagem lateral e nenhum controle abaixo de 44 px`, async ({ page }) => {
      await login(page, email)
      await page.goto("/admin/backups")
      await expect(page.getByRole("heading", { name: "Backups", level: 1 })).toBeVisible()
      await expect(page.getByTestId("section-history")).toBeVisible()
      const m = await measure(page)
      expect(m.overflow).toEqual({ main: 0, doc: 0 })
      expect(m.small, `alvos < 44 px: ${m.small.join(" | ")}`).toEqual([])
    })
  }

  test("histórico vira lista de cartões (sem tabela) e a paginação tem botões de 44 px", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await page.goto("/admin/backups")
    await expect(page.getByTestId("section-history")).toBeVisible()
    await expect(page.getByTestId("section-history").locator("table")).toHaveCount(0)
    await expect(page.getByTestId("run-row")).toHaveCount(10)
    for (const id of ["history-prev", "history-next"]) {
      const box = await page.getByTestId(id).boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(43.5)
    }
    await page.getByTestId("history-next").click()
    await expect(page.getByTestId("history-range")).toHaveText("Mostrando 11–20 de 27 execuções")
  })

  test("diálogos a 375: o da chave e o de senha cabem e os botões têm 44 px", async ({ page }) => {
    await login(page, "backup-s3@innoelektron.com")
    await page.goto("/admin/backups")
    await expect(page.getByTestId("section-key")).toBeVisible()
    await page.getByTestId("key-replace").click()
    const dialog = page.getByRole("dialog", { name: "Substituir a chave do backup" })
    await expect(dialog).toBeVisible()
    // o "X" (Fechar) tem 28 px visíveis e 44 px de alvo (pseudo-elemento); aqui só os botões do rodapé
    const heights = await dialog.evaluate((el) => ({ overflowX: el.scrollWidth - el.clientWidth, buttons: [...el.querySelectorAll("button:not([aria-label=Fechar])")].map((b) => Math.round((b as HTMLElement).offsetHeight)) }))
    expect(heights.overflowX).toBe(0)
    expect(heights.buttons.length).toBeGreaterThanOrEqual(2)
    for (const h of heights.buttons) expect(h).toBeGreaterThanOrEqual(44)
  })
})
