import { expect, test, type Locator, type Page } from "@playwright/test"
import path from "node:path"

/**
 * F5.9c — sessão travada (`STOP_UNCONFIRMED`, encerramento pelo servidor, `FAULTED` ainda "ativa", stop tardio no admin).
 * Contra o mock MSW (`src/mocks/meData.ts`, `seedStuckDemoSessions`/`stuckDemoFaultedSession`, e `reportsData.ts`,
 * `appendStuckSessions`) — NADA provado contra o backend real.
 *
 * Motorista `travado@innoelektron.com` (`user_driver_travado`) nasce com 3 recibos pré-semeados + 1 sessão ativa
 * `FAULTED`. Os horários do mock são "hoje às HH:MM LOCAL" (18:30 de prazo, 14:07 de corte), então o texto exato
 * pode ser afirmado sem depender do relógio nem do fuso da máquina.
 *
 * `E2E_SHOTS_DIR=<pasta>` também grava screenshots de cada tela (para medir/olhar; não afirma pixels).
 */

const PASSWORD = "senha1234"
const DRIVER_EMAIL = "travado@innoelektron.com"
const ADMIN_EMAIL = "admin@innoelektron.com"
const SHOTS_DIR = process.env.E2E_SHOTS_DIR

const VIEWPORTS = [
  { name: "mobile-375", width: 375, height: 812 },
  { name: "desktop-1440", width: 1440, height: 900 },
] as const

async function loginAsDriver(page: Page, redirect: string) {
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`)
  await page.getByLabel("E-mail").fill(DRIVER_EMAIL)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(new RegExp(redirect.replace(/\//g, "\\/")))
}

async function shot(page: Page, name: string, viewport: string) {
  if (SHOTS_DIR) await page.screenshot({ path: path.join(SHOTS_DIR, `${name}-${viewport}.png`), fullPage: true })
}

/** Propriedade MEDIDA (não deduzida do CSS): a página não rola na horizontal. */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, "a página não pode rolar na horizontal").toBeLessThanOrEqual(0)
}

/** Propriedade MEDIDA: o badge (pílula) ficou numa linha só — texto quebrado dentro dele vira retângulo espremido. */
async function expectSingleLineBadge(badge: Locator) {
  const box = await badge.boundingBox()
  expect(box, "badge visível").not.toBeNull()
  expect(box!.height, "badge de uma linha só (11px de texto + padding ≈ 26px)").toBeLessThan(34)
}

for (const viewport of VIEWPORTS) {
  test.describe(`PWA — sessão travada — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("(a) em confirmação, WALLET: nada cobrado + prazo HH:MM, sem total, sem 'Recarga concluída'", async ({ page }) => {
      await loginAsDriver(page, "/app/sessoes/me_seed_unconfirmed_wallet")

      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Shopping Vila Norte")
      const badge = page.getByText("Encerramento em confirmação", { exact: true })
      await expect(badge).toBeVisible()
      await expectSingleLineBadge(badge)

      const notice = page.getByTestId("session-closure-notice")
      await expect(notice).toHaveText("Encerramento em confirmação com o carregador. Nada foi cobrado ainda. Valor final até 18:30.")
      await expect(notice).toHaveAttribute("role", "status")

      // carteira: nunca fala de pré-autorização; sem valor final => sem bloco de custo/total/saldo
      await expect(page.getByText(/pré-autorização/)).toHaveCount(0)
      await expect(page.getByText("Detalhamento do custo")).toHaveCount(0)
      await expect(page.getByText("Total", { exact: true })).toHaveCount(0)
      await expect(page.getByText("Recarga concluída")).toHaveCount(0)
      // energia medida até agora continua visível
      await expect(page.getByText("7,2 kWh")).toBeVisible()

      await expectNoHorizontalOverflow(page)
      await shot(page, "a-recibo-confirmacao-wallet", viewport.name)
    })

    test("(b) em confirmação, CARD: acrescenta que a pré-autorização continua reservada (valor do payload)", async ({ page }) => {
      await loginAsDriver(page, "/app/sessoes/me_seed_unconfirmed_card")

      const notice = page.getByTestId("session-closure-notice")
      await expect(notice).toContainText("Encerramento em confirmação com o carregador. Nada foi cobrado ainda. Valor final até 18:30.")
      await expect(notice).toContainText(/A pré-autorização de R\$\s60,00 continua reservada\./)
      // cartão identificado no cabeçalho; sem "Status da cobrança" (nada foi capturado)
      await expect(page.getByText("Visa •••• 1234")).toBeVisible()
      await expect(page.getByText("Status da cobrança")).toHaveCount(0)
      await expect(page.getByText("Detalhamento do custo")).toHaveCount(0)

      await expectNoHorizontalOverflow(page)
      await shot(page, "b-recibo-confirmacao-card", viewport.name)
    })

    test("(c) encerrada pelo servidor: aviso 'cobramos só o que foi medido até HH:MM', recibo normal com total", async ({ page }) => {
      await loginAsDriver(page, "/app/sessoes/me_seed_server_closed")

      const notice = page.getByTestId("session-closure-notice")
      await expect(notice).toHaveText("O carregador parou de responder. Cobramos só o que foi medido até 14:07.")
      await expect(notice).toHaveAttribute("data-kind", "server")
      // é um recibo de verdade: detalhamento e total aparecem, status "Encerrada"
      await expect(page.getByText("Detalhamento do custo")).toBeVisible()
      await expect(page.getByText(/R\$\s32,65/)).toBeVisible()
      await expect(page.getByText("Encerrada", { exact: true })).toBeVisible()
      // o motorista nunca vê o vocabulário do admin
      expect(await page.locator("body").innerText()).not.toMatch(/StopTransaction|tardio|LAST_METER_SAMPLE|WATCHDOG/i)

      await expectNoHorizontalOverflow(page)
      await shot(page, "c-recibo-encerrada-servidor", viewport.name)
    })

    test("histórico: o badge novo cabe, o valor em confirmação não vira 'R$ 0,00', e navega para o recibo", async ({ page }) => {
      await loginAsDriver(page, "/app/sessoes")

      const pendingRows = page.getByRole("link").filter({ hasText: "Encerramento em confirmação" })
      await expect(pendingRows).toHaveCount(2)
      for (const row of await pendingRows.all()) {
        await expect(row).toContainText("Em confirmação")
        await expect(row).not.toContainText("R$ 0,00")
        await expectSingleLineBadge(row.getByText("Encerramento em confirmação", { exact: true }))
      }
      await expectNoHorizontalOverflow(page)
      await shot(page, "historico", viewport.name)

      await pendingRows.first().click()
      await expect(page).toHaveURL(/\/app\/sessoes\/me_seed_unconfirmed_/)
      await expect(page.getByTestId("session-closure-notice")).toBeVisible()
    })

    test("(e) FAULTED ainda aparece como ativa: banner na Home, aviso de falha na tela de sessão e botão de encerrar", async ({ page }) => {
      await loginAsDriver(page, "/app")

      // Home: a sessão FAULTED é "em andamento" (STOP_UNCONFIRMED, do histórico, NÃO gera esse banner)
      const banner = page.getByRole("link", { name: /Recarga em andamento/ })
      await expect(banner).toBeVisible()
      await shot(page, "e-home-faulted", viewport.name)

      await banner.click()
      await expect(page).toHaveURL(/\/app\/sessao$/)
      const alert = page.getByRole("status").filter({ hasText: "O carregador informou uma falha nesta recarga." })
      await expect(alert).toBeVisible()
      await expect(alert).toContainText("Você pode encerrá-la")
      await expect(page.getByRole("button", { name: "Parar recarga" })).toBeEnabled()
      await expectNoHorizontalOverflow(page)
      await shot(page, "e-sessao-faulted", viewport.name)
    })
  })
}

test.describe("Admin — sessão travada (detalhe da sessão)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  async function openSession(page: Page, status: string, driver: string) {
    await page.goto("/login")
    await page.getByLabel("E-mail").fill(ADMIN_EMAIL)
    await page.getByLabel("Senha").fill(PASSWORD)
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)
    await page.getByRole("link", { name: "Sessões" }).first().click()
    await expect(page).toHaveURL(/\/admin\/sessoes/)
    await page.getByLabel("Status", { exact: true }).selectOption({ label: status })
    const row = page.getByRole("row").filter({ hasText: driver })
    await expect(row).toHaveCount(1)
    // O badge longo ("Encerramento em confirmação") não pode quebrar em duas linhas dentro da tabela (medido).
    await expectSingleLineBadge(row.locator("td span").filter({ hasText: status }).first())
    await row.click()
    return page.getByRole("dialog")
  }

  test("(d) stop tardio: bloco informativo com Wh, quando parou, quando recebemos e custo NÃO cobrado", async ({ page }) => {
    const dialog = await openSession(page, "Encerrada", "Tiago Travado")

    const closure = dialog.getByTestId("admin-session-closure")
    await expect(closure).toContainText("Servidor (encerramento automático)")
    await expect(closure).toContainText("Última amostra do medidor")
    await expect(closure).toContainText("Vigia automático")

    const late = dialog.getByTestId("admin-late-stop")
    await expect(late).toContainText("StopTransaction tardio")
    await expect(late).toContainText("Informativo")
    await expect(late).toContainText("NÃO alterou o total cobrado")
    await expect(late).toContainText("Leitura do StopTransaction")
    await expect(late).toContainText("26,5 kWh") // leitura absoluta do medidor: 5000 (início) + 18000 (cobrado) + 3500 (tardio) Wh
    await expect(late).toContainText(/R\$\s6,97/) // 3,5 kWh × R$ 1,99 não cobrados
    // o total cobrado segue o do fechamento do servidor (18 kWh): 1,99 × 18 + 2,00 de taxa = R$ 37,82
    await expect(dialog.getByText(/R\$\s37,82/).first()).toBeVisible()

    await expectNoHorizontalOverflow(page)
    await shot(page, "d-admin-stop-tardio", "desktop-1440")
  })

  test("admin: sessão em confirmação mostra motivo, quem pediu a parada, tentativas, prazo — e custos '—' (não R$ 0,00)", async ({ page }) => {
    const dialog = await openSession(page, "Encerramento em confirmação", "Tiago Travado")

    await expect(dialog.getByText("Encerramento em confirmação", { exact: true })).toBeVisible()
    const closure = dialog.getByTestId("admin-session-closure")
    await expect(closure).toContainText("Sessão aguardando confirmação do carregador")
    await expect(closure).toContainText("Carregador não confirmou a parada a tempo")
    await expect(closure).toContainText("Motorista")
    await expect(closure).toContainText("Tentativas de parada")
    await expect(closure.getByText("2", { exact: true })).toBeVisible()
    await expect(closure).toContainText("Prazo de confirmação")
    // sem stop tardio nesta sessão
    await expect(dialog.getByTestId("admin-late-stop")).toHaveCount(0)
    await expect(dialog.getByText(/R\$\s0,00/)).toHaveCount(0)

    await shot(page, "d-admin-em-confirmacao", "desktop-1440")
  })
})
