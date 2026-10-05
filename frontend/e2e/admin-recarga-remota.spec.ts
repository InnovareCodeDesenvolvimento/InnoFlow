import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → Pontos de recarga → "Iniciar recarga" (L1.5), contra os mocks MSW (`src/mocks/remoteStartData.ts`, espelho de `chargePoints.routes.ts` +
 * `adminCommands.routes.ts`). Só ADMIN vê o item (DL4); OPERATOR não vê (e o mock devolve 403 igual ao servidor). O resultado do carregador chega por
 * acompanhamento (GET a cada 2 s): o mock fica PENDING ~3 s e depois dá o desfecho do cenário em `localStorage["mock:remote-start"]`.
 *
 * Lote 1 (backend 3e0dbb3): o DTO traz `online` (calculado pelo servidor) e o `GET /commands/:id` traz `sessionId` no ACCEPTED. Offline: aviso e conector bloqueado SEM depender de erro do
 * servidor; aceito: `sessionId: null` -> "Aguardando a sessão iniciar…" (as 2 primeiras consultas) -> id -> "Ver sessão" abre o detalhe direto; a sessão que nunca chega (60 s) ou o
 * registro que expira (404) caem no link para a lista.
 *
 * Mundo semeado: cp_1 CP-VILA-NORTE-01 ONLINE (conector 1 AVAILABLE, conector 2 CHARGING); cp_4 CP-OUTLET-CAMPINAS-01 OFFLINE (conector 1 AVAILABLE). Motoristas (`driversData.ts`): "Carla Motorista" saldo R$ 50,00 e sem dívida;
 * "Juliana Alves" saldo zero e dívida R$ 18,50; "Eduardo Ferreira" saldo zero. O estado do mock vive NA PÁGINA: cada teste faz login e só navega por dentro.
 */

test.use({ viewport: { width: 1440, height: 900 } })

const PASSWORD = "senha1234"
const ADMIN = "admin@innoelektron.com"
const OPERATOR = "operador@innoelektron.com"
const CP = "CP-VILA-NORTE-01"
const CP_OFFLINE = "CP-OUTLET-CAMPINAS-01"
const REASON = "Motorista sem bateria no celular, recarga iniciada pelo suporte por telefone"
const flat = (s: string | null) => (s ?? "").split(String.fromCharCode(160)).join(" ")

async function login(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Pontos de recarga" }).click()
  await expect(page).toHaveURL(/\/admin\/charge-points/)
  await expect(page.getByRole("button", { name: `Comandos de ${CP}` })).toBeVisible()
}

const scenario = (page: Page, value: string) => page.evaluate((v) => localStorage.setItem("mock:remote-start", v), value)
const dialog = (page: Page) => page.getByRole("dialog", { name: "Iniciar recarga" })

async function openDialog(page: Page, cp = CP) {
  await page.getByRole("button", { name: `Comandos de ${cp}` }).click()
  await page.getByRole("menuitem", { name: /Iniciar recarga/ }).click()
  await expect(dialog(page)).toBeVisible()
  return dialog(page)
}

/** Preenche o passo 1 (conector 1 + motorista pela busca + motivo) e vai para a confirmação. */
async function fillAndReview(page: Page, search: string, driverName: string) {
  const d = await openDialog(page)
  await d.getByRole("searchbox", { name: "Buscar motorista" }).fill(search)
  await d.getByText(driverName, { exact: true }).first().click()
  await d.getByLabel(/Motivo/).fill(REASON)
  await d.getByRole("button", { name: /Revisar recarga/ }).click()
  await expect(page.getByTestId("remote-start-summary")).toBeVisible()
  return d
}

const confirm = (page: Page) => dialog(page).getByRole("button", { name: "Iniciar recarga" })

test.describe("ADMIN inicia recarga remota", () => {
  test("caminho feliz: conector → motorista (saldo e dívida à vista) → motivo → confirmar → aguardando → aceito → link para Sessões", async ({ page }) => {
    await login(page, ADMIN)
    const d = await openDialog(page)

    // Conector: só o livre é escolhível; o que está carregando aparece desabilitado com o status escrito.
    await expect(d.getByRole("radio", { name: /Conector 1/ })).toBeEnabled()
    await expect(d.getByRole("radio", { name: /Conector 2/ })).toBeDisabled()
    await expect(d.getByText("Carregando", { exact: true })).toBeVisible()

    // A busca só lista depois de digitar.
    await expect(page.getByTestId("driver-search-prompt")).toBeVisible()
    await d.getByRole("searchbox", { name: "Buscar motorista" }).fill("carla")
    const row = d.getByRole("radio", { name: /Carla Motorista/ })
    await expect(row).toBeVisible()
    await d.getByText("Carla Motorista", { exact: true }).first().click()

    // Saldo e dívida VISÍVEIS antes de confirmar (no cartão do motorista escolhido).
    const chosen = page.getByTestId("remote-start-driver-selected")
    await expect(chosen).toContainText("Carla Motorista")
    expect(flat(await chosen.textContent())).toMatch(/Saldo R\$ 50,00/)
    await expect(chosen).toContainText("Sem dívida")

    // Contador do motivo.
    await expect(page.getByTestId("reason-counter")).toHaveText("0/200 · mínimo 10")
    await d.getByLabel(/Motivo/).fill(REASON)
    await expect(page.getByTestId("reason-counter")).toHaveText(`${REASON.length}/200 · mínimo 10`)

    // Confirmação: frase inequívoca, saldo, dívida e motivo. Nada enviado ainda.
    let posts = 0
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/commands/remote-start")) posts += 1
    })
    await d.getByRole("button", { name: /Revisar recarga/ }).click()
    await expect(page.getByTestId("remote-start-summary")).toHaveText("Vai debitar a carteira de Carla Motorista")
    expect(flat(await page.getByTestId("remote-start-balance").textContent())).toBe("R$ 50,00")
    await expect(page.getByTestId("remote-start-debt")).toHaveText("Nenhuma")
    await expect(d.getByText(REASON)).toBeVisible()
    expect(posts).toBe(0)

    // Confirma: aguardando o carregador (região aria-live) -> aceito, mas a sessão ainda não nasceu (sessionId null) -> a sessão chegou.
    await confirm(page).click()
    const status = page.getByTestId("remote-start-status")
    await expect(status).toHaveAttribute("aria-live", "polite")
    await expect(status).toContainText("Aguardando o carregador")
    await expect(status).toContainText("Aguardando a sessão iniciar…", { timeout: 15_000 })
    await expect(status).toHaveAttribute("data-phase", "STARTING")
    await expect(d.getByRole("link")).toHaveCount(0) // ainda não terminou: nenhum link
    await expect(d.getByRole("button", { name: "Fechar janela" })).toBeVisible()
    await expect(status).toContainText("O carregador aceitou.", { timeout: 15_000 })
    await expect(status).toContainText("a sessão já foi criada")
    expect(posts).toBe(1)

    // "Ver sessão" vai DIRETO ao detalhe da sessão (diálogo da tela de Sessões aberto pela querystring); fechar limpa a URL (F5 não reabre).
    await expect(d.getByRole("link", { name: "Ver sessões" })).toHaveCount(0)
    await d.getByRole("link", { name: "Ver sessão", exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/sessoes\?sessao=[A-Za-z0-9_-]+$/)
    const detail = page.getByRole("dialog", { name: /Detalhe da sessão/ })
    await expect(detail).toBeVisible()
    await expect(detail.getByText(/CP-VILA-NORTE-01 · conector \d/)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(detail).toHaveCount(0)
    await expect(page).toHaveURL(/\/admin\/sessoes$/)
  })

  test("carregador OFFLINE: aviso claro e nenhum conector escolhível ANTES de qualquer erro do servidor; nada é enviado", async ({ page }) => {
    await login(page, ADMIN)
    let posts = 0
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/commands/remote-start")) posts += 1
    })
    const d = await openDialog(page, CP_OFFLINE)
    await expect(d.getByTestId("remote-start-offline")).toHaveText("Este carregador está offline. Não é possível iniciar uma recarga agora.")
    // O conector 1 está AVAILABLE no cadastro, mas o carregador está offline: não dá para escolher (nem vem escolhido sozinho).
    await expect(d.getByRole("radio", { name: /Conector 1/ })).toBeDisabled()
    await expect(d.getByRole("radio", { name: /Conector 1/ })).not.toBeChecked()
    await expect(d.getByText(/Nenhum conector está livre/)).toHaveCount(0)
    await expect(d.getByRole("button", { name: /Revisar recarga/ })).toBeDisabled()
    // O resto do formulário continua usável (dá para preparar enquanto o carregador volta), mas nada avança.
    await d.getByRole("searchbox", { name: "Buscar motorista" }).fill("carla")
    await d.getByText("Carla Motorista", { exact: true }).first().click()
    await d.getByLabel(/Motivo/).fill(REASON)
    await expect(d.getByRole("button", { name: /Revisar recarga/ })).toBeDisabled()
    await expect(page.getByTestId("remote-start-summary")).toHaveCount(0)
    expect(posts).toBe(0)
    // Teclado: Esc fecha e o foco volta ao menu da linha certa.
    await page.keyboard.press("Escape")
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByRole("button", { name: `Comandos de ${CP_OFFLINE}` })).toBeFocused()
  })

  test("carregador ONLINE não mostra o aviso e deixa escolher o conector livre (cp_1)", async ({ page }) => {
    await login(page, ADMIN)
    const d = await openDialog(page)
    await expect(d.getByTestId("remote-start-offline")).toHaveCount(0)
    await expect(d.getByRole("radio", { name: /Conector 1/ })).toBeEnabled()
  })

  test("sem motivo (ou curto): erro no campo, nada avança; sem motorista também avisa", async ({ page }) => {
    await login(page, ADMIN)
    const d = await openDialog(page)

    // cp_1 tem UM conector livre: já vem escolhido (a falta de conector é coberta no teste de componente, com dois livres).
    await expect(d.getByRole("radio", { name: /Conector 1/ })).toBeChecked()
    await d.getByRole("button", { name: /Revisar recarga/ }).click()
    await expect(d.getByText(/Escolha o motorista/)).toBeVisible()
    await expect(d.getByText(/Informe o motivo/)).toBeVisible()
    await expect(page.getByTestId("remote-start-summary")).toHaveCount(0)

    await d.getByLabel(/Motivo/).fill("curto")
    await expect(d.getByText(/faltam 5/)).toBeVisible()
    await d.getByLabel(/Motivo/).fill("com quebra de\nlinha no meio")
    await expect(d.getByText(/uma linha só/)).toBeVisible()
    await d.getByLabel(/Motivo/).fill("x".repeat(201))
    await expect(d.getByText(/sobram 1/)).toBeVisible()
    await expect(page.getByTestId("reason-counter")).toHaveText("201/200 · mínimo 10")
  })

  test("o mock honra o contrato: 400 sem reason (details[].path = reason), 403 para OPERATOR no POST e no GET", async ({ page }) => {
    await login(page, ADMIN)
    const adminCalls = await page.evaluate(async () => {
      const token = localStorage.getItem("innoelektron_token") ?? ""
      const call = async (url: string, init?: RequestInit) => {
        const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } })
        return { status: res.status, body: await res.json().catch(() => null) }
      }
      return {
        semReason: await call("/api/admin/charge-points/cp_1/commands/remote-start", { method: "POST", body: JSON.stringify({ connectorId: 1, userId: "user_driver" }) }),
        curto: await call("/api/admin/charge-points/cp_1/commands/remote-start", { method: "POST", body: JSON.stringify({ connectorId: 1, userId: "user_driver", reason: "curto" }) }),
        inexistente: await call("/api/admin/commands/3f9c2a10-5b7e-4d21-9a6c-aaaaaaaaaaaa"),
      }
    })
    expect(adminCalls.semReason.status).toBe(400)
    expect(adminCalls.semReason.body.code).toBe("VALIDATION_ERROR")
    expect(adminCalls.semReason.body.details[0].path).toBe("reason")
    expect(adminCalls.curto.status).toBe(400)
    expect(adminCalls.inexistente.status).toBe(404)
    expect(adminCalls.inexistente.body.code).toBe("COMMAND_NOT_FOUND")
  })

  test("motorista com dívida: aviso ANTES de enviar e DRIVER_HAS_OPEN_DEBT por code na tela (não o texto do backend)", async ({ page }) => {
    await login(page, ADMIN)
    await fillAndReview(page, "juliana", "Juliana Alves")
    await expect(dialog(page).getByText(/de dívida em aberto\. O servidor costuma recusar/)).toBeVisible()
    expect(flat(await page.getByTestId("remote-start-debt").textContent())).toBe("R$ 18,50")

    await confirm(page).click()
    const alert = page.getByTestId("remote-start-error")
    await expect(alert).toContainText("Este motorista tem uma dívida em aberto e não pode iniciar recargas")
    await expect(alert).not.toContainText("Motorista com dívida em aberto.") // texto cru do backend
    await expect(alert).toHaveAttribute("role", "alert")
    // Continua na confirmação: dá para voltar e escolher outro motorista.
    await dialog(page).getByRole("button", { name: /Voltar/ }).click()
    await expect(dialog(page).getByLabel(/Motivo/)).toHaveValue(REASON)
  })

  test("saldo insuficiente (Eduardo, saldo zero) vem por code", async ({ page }) => {
    await login(page, ADMIN)
    await fillAndReview(page, "eduardo", "Eduardo Ferreira")
    await confirm(page).click()
    await expect(page.getByTestId("remote-start-error")).toContainText("O saldo da carteira deste motorista é insuficiente")
  })

  for (const [value, expected] of [
    ["offline", "O carregador está offline"],
    ["busy", "Este conector não está livre agora"],
    ["forbidden", "Só administradores da plataforma podem iniciar uma recarga remota"],
    ["5xx", "O serviço está instável agora"],
  ] as const) {
    test(`erro do POST por code/status: ${value}`, async ({ page }) => {
      await login(page, ADMIN)
      await scenario(page, value)
      await fillAndReview(page, "carla", "Carla Motorista")
      await confirm(page).click()
      const alert = page.getByTestId("remote-start-error")
      await expect(alert).toContainText(expected)
      if (value === "5xx") await expect(alert).toContainText("Confira em Sessões") // resultado incerto: não repetir às cegas
    })
  }

  test("o carregador RECUSA: aviso 'O carregador recusou' (não é erro) e dá para tentar de novo", async ({ page }) => {
    await login(page, ADMIN)
    await scenario(page, "rejected")
    await fillAndReview(page, "carla", "Carla Motorista")
    await confirm(page).click()
    const status = page.getByTestId("remote-start-status")
    await expect(status).toContainText("O carregador recusou o início da recarga.", { timeout: 15_000 })
    await expect(status).toHaveAttribute("data-phase", "REJECTED")
    await expect(page.getByTestId("remote-start-error")).toHaveCount(0)
    await expect(dialog(page).getByRole("link", { name: "Ver sessões" })).toHaveCount(0)
    await dialog(page).getByRole("button", { name: /Tentar de novo/ }).click()
    await expect(page.getByTestId("remote-start-summary")).toBeVisible()
  })

  test("TIMEOUT: 'Sem resposta do carregador' com aviso de que pode ter começado", async ({ page }) => {
    await login(page, ADMIN)
    await scenario(page, "timeout")
    await fillAndReview(page, "carla", "Carla Motorista")
    await confirm(page).click()
    const status = page.getByTestId("remote-start-status")
    await expect(status).toContainText("Sem resposta do carregador.", { timeout: 15_000 })
    await expect(status).toContainText("pode ter começado")
    await expect(dialog(page).getByRole("link", { name: "Ver sessões" })).toBeVisible()
  })

  test("404 durante o acompanhamento: 'Resultado indisponível'", async ({ page }) => {
    await login(page, ADMIN)
    await scenario(page, "not-found")
    await fillAndReview(page, "carla", "Carla Motorista")
    await confirm(page).click()
    await expect(page.getByTestId("remote-start-status")).toContainText("Resultado indisponível.", { timeout: 15_000 })
  })

  test("falha de conexão no acompanhamento (5xx no GET, 3 seguidas): 'Perdemos a conexão', sem loop infinito", async ({ page }) => {
    await login(page, ADMIN)
    await scenario(page, "poll-5xx")
    await fillAndReview(page, "carla", "Carla Motorista")
    const gets: string[] = []
    page.on("request", (r) => {
      if (r.url().includes("/api/admin/commands/")) gets.push(r.url())
    })
    await confirm(page).click()
    await expect(page.getByTestId("remote-start-status")).toContainText("Perdemos a conexão com o servidor.", { timeout: 20_000 })
    const total = gets.length
    expect(total).toBe(3)
    await page.waitForTimeout(5_000)
    expect(gets.length).toBe(total) // parou
  })

  test("FECHAR o diálogo durante o acompanhamento para as consultas", async ({ page }) => {
    await login(page, ADMIN)
    await scenario(page, "stuck")
    await fillAndReview(page, "carla", "Carla Motorista")
    const gets: number[] = []
    page.on("request", (r) => {
      if (r.url().includes("/api/admin/commands/")) gets.push(Date.now())
    })
    await confirm(page).click()
    await expect(page.getByTestId("remote-start-status")).toContainText("Aguardando o carregador")
    await expect.poll(() => gets.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2) // 2 s entre consultas
    await page.keyboard.press("Escape")
    await expect(dialog(page)).toHaveCount(0)
    const total = gets.length
    await page.waitForTimeout(5_000)
    expect(gets.length).toBe(total)
  })

  test("teclado: Esc fecha e o foco volta para o menu da linha; Tab fica preso no diálogo", async ({ page }) => {
    await login(page, ADMIN)
    const trigger = page.getByRole("button", { name: `Comandos de ${CP}` })
    await openDialog(page)
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab")
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
    }
    await page.keyboard.press("Escape")
    await expect(dialog(page)).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
})

test.describe("aceito: a sessão que não chega", () => {
  test("registro do comando expira (404) depois do aceito: o carregador ACEITOU, então cai no link para a LISTA - não vira 'resultado indisponível'", async ({ page }) => {
    await login(page, ADMIN)
    await scenario(page, "session-expired")
    await fillAndReview(page, "carla", "Carla Motorista")
    await confirm(page).click()
    const status = page.getByTestId("remote-start-status")
    await expect(status).toHaveAttribute("data-phase", "STARTING", { timeout: 15_000 })
    await expect(status).toHaveAttribute("data-phase", "ACCEPTED", { timeout: 15_000 })
    await expect(status).toContainText("O carregador aceitou.")
    await expect(status).not.toContainText("Resultado indisponível")
    await expect(dialog(page).getByRole("link", { name: "Ver sessão", exact: true })).toHaveCount(0)
    await dialog(page).getByRole("link", { name: "Ver sessões", exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/sessoes$/)
  })

  test("a sessão NUNCA chega: espera dentro do mesmo limite de 60 s e só então oferece a lista de Sessões", async ({ page }) => {
    test.setTimeout(150_000)
    await login(page, ADMIN)
    await scenario(page, "session-never")
    await fillAndReview(page, "carla", "Carla Motorista")
    const gets: number[] = []
    page.on("request", (r) => {
      if (r.url().includes("/api/admin/commands/")) gets.push(Date.now())
    })
    await confirm(page).click()
    const status = page.getByTestId("remote-start-status")
    await expect(status).toHaveAttribute("data-phase", "STARTING", { timeout: 15_000 })
    await expect(status).toContainText("Aguardando a sessão iniciar…")
    await expect(dialog(page).getByRole("link")).toHaveCount(0)
    // Passou do limite: termina como ACCEPTED sem sessão (não como "sem resposta"), com o link para a lista.
    await expect(status).toHaveAttribute("data-phase", "ACCEPTED", { timeout: 90_000 })
    await expect(status).toContainText("O carregador aceitou.")
    await expect(status).not.toContainText("a sessão já foi criada")
    await expect(dialog(page).getByRole("link", { name: "Ver sessões", exact: true })).toHaveAttribute("href", "/admin/sessoes")
    const total = gets.length
    expect(total, "consultas de 2 em 2 s por ~60 s (o contador conta a partir do envio)").toBeGreaterThanOrEqual(25)
    expect(total).toBeLessThanOrEqual(33)
    await page.waitForTimeout(5_000)
    expect(gets.length).toBe(total) // parou
  })
})

test.describe("OPERATOR não inicia recarga remota (DL4)", () => {
  test("o menu NÃO tem 'Iniciar recarga' (mas continua com os outros comandos)", async ({ page }) => {
    await login(page, OPERATOR)
    await page.getByRole("button", { name: `Comandos de ${CP}` }).click()
    await expect(page.getByRole("menuitem", { name: /Reiniciar \(soft\)/ })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: /Iniciar recarga/ })).toHaveCount(0)
  })

  test("e o servidor (mock) recusa o POST e o GET com 403 FORBIDDEN, mesmo chamado direto", async ({ page }) => {
    await login(page, OPERATOR)
    const r = await page.evaluate(async () => {
      const token = localStorage.getItem("innoelektron_token") ?? ""
      const call = async (url: string, init?: RequestInit) => {
        const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } })
        return { status: res.status, body: await res.json().catch(() => null) }
      }
      return {
        post: await call("/api/admin/charge-points/cp_1/commands/remote-start", { method: "POST", body: JSON.stringify({ connectorId: 1, userId: "user_driver", reason: "Teste de política DL4 do operador" }) }),
        get: await call("/api/admin/commands/3f9c2a10-5b7e-4d21-9a6c-000000000001"),
      }
    })
    expect(r.post.status).toBe(403)
    expect(r.post.body.code).toBe("FORBIDDEN")
    expect(r.get.status).toBe(403)
  })
})
