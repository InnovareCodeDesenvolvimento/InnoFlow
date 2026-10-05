import { expect, test, type Page } from "@playwright/test"
import path from "node:path"
import { PASTA_AUTH, PERSONAS, SENHA, T0 } from "./constantes"
import { aguardarEstavel, fotografar, medirContrasteSeSolicitado, prepararPagina } from "./estabilizar"

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

async function foto(page: Page, nome: string, opts: { crescerAteODocumento?: boolean; spinnerEhConteudo?: boolean; soJanela?: boolean } = {}) {
  await aguardarEstavel(page, { spinnerEhConteudo: opts.spinnerEhConteudo })
  const imagem = await fotografar(page, { ...opts, nome })
  if (!process.env.VISUAL_GEO_DIR) expect(imagem).toMatchSnapshot(`${nome}.jpg`) // modo SONDA: ver rotas.visual.ts
  await medirContrasteSeSolicitado(page, nome, { soJanela: opts.soJanela })
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

test.describe("diálogos do gateway de pagamento (admin)", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.admin.arquivo}.json`) })

  // Os dois diálogos são montados só enquanto abertos e não têm dado variável (a senha fica vazia): determinísticos. O 2º só abre com produção
  // escolhida E uma alteração pendente, por isso é o MESMO fluxo (o mock mora na página, zera a cada goto).
  test("adm-dialogo-gateway-producao e adm-dialogo-gateway-salvar (confirmação de produção; resumo + step-up de senha)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto("/admin/gateway-pagamento", { waitUntil: "load" })
    await aguardarEstavel(page)

    // 1) Escolher "Produção" abre a confirmação por palavra digitada.
    await page.locator("label").filter({ hasText: "Cobranças reais" }).click()
    const confirmarProducao = page.getByRole("dialog", { name: "Passar para produção?" })
    await expect(confirmarProducao).toBeVisible()
    await foto(page, "adm-dialogo-gateway-producao")

    // 2) Digita a palavra e seleciona produção (rascunho): há alteração pendente e válida (credencial é par MerchantId+MerchantKey, então não se mexe nela).
    await confirmarProducao.getByLabel(/Para confirmar, digite/).fill("PRODUÇÃO")
    await confirmarProducao.getByRole("button", { name: "Selecionar produção" }).click()
    await expect(confirmarProducao).toBeHidden()
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    const resumo = page.getByRole("dialog", { name: "Confirmar alterações no gateway" })
    await expect(resumo).toBeVisible()
    await expect(resumo.getByRole("alert")).toContainText("passa a cobrar de verdade")
    await foto(page, "adm-dialogo-gateway-salvar")
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

test.describe("recuperação de senha (L1.3) - estados que não são só abrir a URL", () => {
  const TOKEN = "motorista".padEnd(43, "A")

  test("auth-esqueci-enviado (sucesso neutro, contagem do reenvio em 60 s com o relógio fixo)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto("/esqueci-senha", { waitUntil: "load" })
    await page.getByLabel(/^E-mail/).fill("motorista@innoelektron.com")
    await page.getByRole("button", { name: "Enviar link" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Confira seu e-mail" })).toBeVisible()
    await foto(page, "auth-esqueci-enviado")
  })

  test("auth-redefinir-formulario (token no fragmento já lido e apagado da URL)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto(`/redefinir-senha#t=${TOKEN}`, { waitUntil: "load" })
    await expect(page.getByRole("heading", { level: 1, name: "Crie uma nova senha" })).toBeVisible()
    await foto(page, "auth-redefinir-formulario")
  })

  test("auth-login-aviso-senha-alterada (chega do /redefinir-senha pelo estado da rota)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto(`/redefinir-senha#t=${TOKEN}`, { waitUntil: "load" })
    await page.getByLabel(/^Nova senha/).fill("uma-senha-nova-123")
    await page.getByLabel(/^Repita a nova senha/).fill("uma-senha-nova-123")
    await page.getByRole("button", { name: "Redefinir senha" }).click()
    await expect(page.getByText("Senha alterada. Entre com a nova senha.")).toBeVisible()
    await foto(page, "auth-login-aviso-senha-alterada")
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Lote 1 (05/10/2026): tour do Inno, Primeiros passos, Backups (conta populada), recarga remota, estorno/chargeback/devolução. Receitas copiadas das réguas da Lyra
// (`criterios-recarga-remota`, `verificacoes-estorno`, `verificacoes-onboarding`, `verificacoes-backup`), trocando medir por fotografar.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

async function entrarPelaUI(page: Page, email: string, depoisDe: RegExp = /^\/(admin|app)/) {
  await page.goto("/login", { waitUntil: "load" })
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await page.waitForURL((u) => depoisDe.test(u.pathname), { timeout: 30_000 })
}

async function esperarBalao(page: Page) {
  await expect(page.locator("[data-tour-balloon][data-ready]")).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(500)
}

test.describe("tour do Inno (1ª visita; interruptor de aparelho DESLIGADO de propósito: login pela UI com storageState vazio)", () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test("onb-motorista-boas-vindas, onb-motorista-mapa e onb-motorista-qr", async ({ page }) => {
    await prepararPagina(page)
    await entrarPelaUI(page, PERSONAS.driver.email)
    await esperarBalao(page)
    await foto(page, "onb-motorista-boas-vindas", { soJanela: true })
    await page.getByRole("button", { name: "Vamos lá" }).click()
    await page.waitForTimeout(400)
    await esperarBalao(page)
    await foto(page, "onb-motorista-mapa", { soJanela: true })
    await page.getByRole("button", { name: "Próximo" }).click() // QR: está na Home
    await page.waitForTimeout(400)
    await esperarBalao(page)
    await foto(page, "onb-motorista-qr", { soJanela: true })
  })

  test("onb-painel-boas-vindas, onb-painel-menu e onb-painel-passo3 (dashboard a partir de 1024 px; atalhos abaixo disso)", async ({ page }) => {
    await prepararPagina(page)
    await entrarPelaUI(page, PERSONAS.admin.email)
    await esperarBalao(page)
    await foto(page, "onb-painel-boas-vindas", { soJanela: true })
    await page.getByRole("button", { name: "Vamos lá" }).click()
    await page.waitForTimeout(400)
    await esperarBalao(page)
    // `onb-painel-menu` (passo "O menu do painel") NÃO é fotografado: o texto do passo lista "Backups", tela que vai ser refeita (05/10/2026). Volta junto com a baseline do Backups.
    await page.getByRole("button", { name: "Próximo" }).click()
    await page.waitForTimeout(400)
    await esperarBalao(page)
    await foto(page, "onb-painel-passo3", { soJanela: true })
  })
})

test.describe("Primeiros passos (card do Dashboard do ADMIN, depois do tour)", () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test("adm-dashboard-primeiros-passos", async ({ page }) => {
    await prepararPagina(page)
    // 1ª visita já concluída (só o tour; o interruptor do aparelho segue desligado=ausente): sem o tour por cima, o card aparece.
    await page.addInitScript(() => localStorage.setItem("innoflow:tour:v1:user_admin:admin", JSON.stringify({ version: 1, status: "completed", at: "2026-10-04T00:00:00.000Z" })))
    await entrarPelaUI(page, PERSONAS.admin.email, /^\/admin/)
    await expect(page.getByRole("region", { name: "Primeiros passos" })).toBeVisible({ timeout: 20_000 })
    await foto(page, "adm-dashboard-primeiros-passos")
  })
})

test.describe("Backups com a conta já configurada (S3 pronto)", () => {
  // storageState PADRÃO do projeto (só o interruptor do onboarding ligado a "off"): senão o tour da 1ª visita abre por cima da tela.

  test("adm-backups-s3-pronto", async ({ page }) => {
    test.fixme(true, "Admin > Backups será REFEITO no layout do InnoChat (pedido do dono, 05/10/2026): sem baseline até o redesenho ser classificado.")
    await prepararPagina(page)
    await entrarPelaUI(page, "backup-s3@innoelektron.com", /^\/admin/)
    await page.goto("/admin/backups", { waitUntil: "load" })
    await expect(page.getByRole("heading", { name: "Backups", level: 1 })).toBeVisible()
    await expect(page.getByTestId("section-history")).toBeVisible()
    await foto(page, "adm-backups-s3-pronto")
  })
})

test.describe("Iniciar recarga (Admin > Pontos de recarga) — diálogo em seus estados", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.admin.arquivo}.json`) })
  const CP = "CP-VILA-NORTE-01"
  const MOTIVO = "Motorista sem bateria no celular, recarga iniciada pelo suporte por telefone a pedido do cliente que está no local"
  const dialogo = (page: Page) => page.getByRole("dialog", { name: "Iniciar recarga" })

  async function abrir(page: Page, cp = CP, cenario?: string) {
    await page.goto("/admin/charge-points", { waitUntil: "load" })
    await aguardarEstavel(page)
    if (cenario) await page.evaluate((c) => localStorage.setItem("mock:remote-start", c), cenario)
    await page.getByRole("button", { name: `Comandos de ${cp}` }).click()
    await page.getByRole("menuitem", { name: /Iniciar recarga/ }).click()
    await expect(dialogo(page)).toBeVisible()
    await page.waitForTimeout(500)
  }
  async function preencher(page: Page) {
    const d = dialogo(page)
    await d.getByRole("searchbox", { name: "Buscar motorista" }).fill("carla")
    await d.getByText("Carla Motorista", { exact: true }).first().click()
    await d.getByLabel(/Motivo/).fill(MOTIVO)
    return d
  }

  test("adm-dialogo-recarga-remota-form, -confirmacao, -aguardando e -aceito (um fluxo só: o mock mora na página)", async ({ page }) => {
    await prepararPagina(page)
    await abrir(page)
    await foto(page, "adm-dialogo-recarga-remota-form")
    const d = await preencher(page)
    await d.getByRole("button", { name: /Revisar recarga/ }).click()
    await expect(page.getByTestId("remote-start-summary")).toBeVisible()
    await foto(page, "adm-dialogo-recarga-remota-confirmacao")
    await d.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page.getByTestId("remote-start-status")).toHaveAttribute("data-phase", "POLLING")
    await foto(page, "adm-dialogo-recarga-remota-aguardando", { spinnerEhConteudo: true }) // o estado É "aguardando": o spinner é o conteúdo
    await page.clock.setFixedTime(new Date(T0.getTime() + 5_000)) // o mock passa dos 3 s e o próximo ciclo traz ACCEPTED
    await expect(page.getByTestId("remote-start-status")).toHaveAttribute("data-phase", "ACCEPTED", { timeout: 20_000 })
    await expect(dialogo(page).getByRole("link", { name: "Ver sessão", exact: true })).toBeVisible()
    await foto(page, "adm-dialogo-recarga-remota-aceito")
  })

  test("adm-dialogo-recarga-remota-recusado (cenário 'rejected' do mock)", async ({ page }) => {
    await prepararPagina(page)
    await abrir(page, CP, "rejected")
    const d = await preencher(page)
    await d.getByRole("button", { name: /Revisar recarga/ }).click()
    await d.getByRole("button", { name: "Iniciar recarga" }).click()
    await page.clock.setFixedTime(new Date(T0.getTime() + 5_000))
    await expect(page.getByTestId("remote-start-status")).toHaveAttribute("data-phase", "REJECTED", { timeout: 15_000 })
    await foto(page, "adm-dialogo-recarga-remota-recusado")
  })

  test("adm-dialogo-recarga-remota-offline (carregador sem conexão: conectores bloqueados)", async ({ page }) => {
    await prepararPagina(page)
    await abrir(page, "CP-OUTLET-CAMPINAS-01")
    await expect(dialogo(page).getByTestId("remote-start-offline")).toBeVisible()
    await foto(page, "adm-dialogo-recarga-remota-offline")
  })
})

test.describe("estorno, chargeback e devolução de conta excluída (Admin) — diálogos", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.admin.arquivo}.json`) })

  test("adm-dialogo-estorno-form e adm-dialogo-estorno-confirmacao (detalhe da sessão > Devoluções > Estornar)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto("/admin/sessoes", { waitUntil: "load" })
    await aguardarEstavel(page)
    await page.getByRole("row").filter({ hasText: "Tiago Travado" }).filter({ hasText: "Encerrada" }).click()
    const detalhe = page.getByRole("dialog", { name: /Detalhe da sessão/ })
    await expect(detalhe.getByTestId("admin-refunds").getByTestId("refund-item").first()).toBeVisible()
    await detalhe.getByTestId("admin-refunds").getByRole("button", { name: "Estornar" }).click()
    const form = page.getByRole("dialog", { name: /Estornar sessão/ })
    await expect(form).toBeVisible()
    await foto(page, "adm-dialogo-estorno-form")
    await form.getByLabel(/Valor \(R\$\)/).fill("8,00")
    await form.getByLabel(/Motivo/).fill("Estorno parcial por energia não entregue")
    await form.getByRole("button", { name: /Revisar estorno/ }).click()
    await expect(page.getByRole("dialog", { name: "Confirmar estorno" })).toBeVisible()
    await foto(page, "adm-dialogo-estorno-confirmacao")
  })

  test("adm-dialogo-chargeback-registrar (Pagamentos > busca Cielo > Registrar chargeback)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto("/admin/pagamentos", { waitUntil: "load" })
    await expect(page.getByRole("heading", { name: "Pagamentos", level: 1 })).toBeVisible()
    await aguardarEstavel(page)
    await page.getByRole("button", { name: "Buscar venda da Cielo" }).click()
    await page.locator("#acquirer-filters").getByLabel("Tid").fill("10069930690000999001")
    await page.locator("#acquirer-filters").getByRole("button", { name: "Buscar" }).click()
    await expect(page.getByRole("row")).toHaveCount(2)
    await page.getByRole("button", { name: /Registrar chargeback/ }).click()
    await expect(page.getByRole("dialog", { name: "Registrar chargeback" })).toBeVisible()
    await foto(page, "adm-dialogo-chargeback-registrar")
  })

  test("adm-dialogo-chargeback-detalhe (caso aberto com prazo vencido)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto("/admin/chargebacks", { waitUntil: "load" })
    await expect(page.getByTestId("chargebacks-urgent")).toBeVisible()
    await aguardarEstavel(page)
    await page.getByRole("button", { name: "Ver chargeback do caso CASO-2026-0166" }).click()
    await expect(page.getByRole("dialog", { name: /CASO-2026-0166/ })).toBeVisible()
    await foto(page, "adm-dialogo-chargeback-detalhe")
  })

  test("adm-dialogo-devolver-saldo-form (fila de devoluções de contas excluídas > Devolver)", async ({ page }) => {
    await prepararPagina(page)
    await page.goto("/admin/devolucoes-contas-excluidas", { waitUntil: "load" })
    await expect(page.getByTestId("deletion-row")).toHaveCount(3)
    await aguardarEstavel(page)
    await page.getByTestId("deletion-row").nth(2).getByRole("button", { name: /Devolver/ }).click()
    await expect(page.getByRole("dialog", { name: "Devolver saldo" })).toBeVisible()
    await foto(page, "adm-dialogo-devolver-saldo-form")
  })
})
