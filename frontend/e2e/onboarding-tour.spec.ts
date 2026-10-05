import { expect, test, type Locator, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

/**
 * Onboarding (tour do mascote) contra os mocks MSW: tour do MOTORISTA e do PAINEL (ADMIN e OPERATOR), em 375/768/1440, com a régua de geometria (balão dentro da janela, destaque sobre o
 * alvo, balão sem cobrir o alvo, nada cortado, alvos de toque de 44 px), pular/voltar/Esc/foco, "Rever tour", alvo oculto, persistência por usuário e versão do roteiro, axe.
 *
 * `playwright.config.ts` liga o interruptor de aparelho `innoflow:onboarding:off` em TODA spec; esta DESLIGA (storageState vazio) para o tour abrir sozinho, como na 1ª visita real.
 * O estado do mock vive NA PÁGINA: depois do login só se navega por links (um `page.goto` zeraria carteira/sessão), exceto onde o teste PRECISA recarregar (persistência).
 */

test.use({ storageState: { cookies: [], origins: [] } })

const DRIVER = "motorista@innoelektron.com"
const ADMIN = "admin@innoelektron.com"
const OPERATOR = "operador@innoelektron.com"
const OTHER_DRIVER = "devedor@innoelektron.com"

const SIZES = [
  { name: "375", width: 375, height: 812 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
] as const

async function login(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill("senha1234")
  await page.getByRole("button", { name: "Entrar" }).click()
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 })
}

const tour = (page: Page) => page.locator("[data-tour-balloon]")
const title = (page: Page) => page.locator("[data-tour-balloon] .tour-title")
const progress = (page: Page) => page.locator("[data-tour-balloon] .tour-progress")
const next = (page: Page) => page.locator("[data-tour-primary]")

interface Box {
  left: number
  top: number
  width: number
  height: number
}
const boxOf = async (loc: Locator): Promise<Box | null> => {
  // `boundingBox()` ESPERA o elemento aparecer (até o timeout do teste): ausente tem de ser `null` na hora, porque "sem destaque" é um resultado válido.
  if ((await loc.count()) === 0) return null
  const b = await loc.first().boundingBox()
  return b ? { left: b.x, top: b.y, width: b.width, height: b.height } : null
}
const overlap = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

/** Espera o balão e o destaque pararem (as transições de posição duram ~220 ms): 3 leituras iguais seguidas. */
async function settle(page: Page) {
  let last = ""
  let same = 0
  for (let i = 0; i < 40 && same < 3; i++) {
    const now = JSON.stringify([await boxOf(tour(page)), await boxOf(page.locator("[data-tour-spot]"))])
    same = now === last ? same + 1 : 0
    last = now
    await page.waitForTimeout(60)
  }
}

async function waitForTour(page: Page, name: RegExp | string) {
  await expect(page.getByRole("dialog", { name })).toBeVisible({ timeout: 15_000 })
  await expect(next(page)).toBeFocused()
  await settle(page)
}

/**
 * A RÉGUA: tudo que a geometria do tour promete, medido no navegador, no passo atual. Devolve o que mediu para o teste poder afirmar mais.
 */
async function ruler(page: Page, viewport: { width: number; height: number }, targetName?: string) {
  const balloon = (await boxOf(tour(page)))!
  expect(balloon, "balão visível").not.toBeNull()
  // 1) o balão inteiro está dentro da janela
  expect(balloon.left).toBeGreaterThanOrEqual(0)
  expect(balloon.top).toBeGreaterThanOrEqual(0)
  expect(balloon.left + balloon.width).toBeLessThanOrEqual(viewport.width)
  expect(balloon.top + balloon.height).toBeLessThanOrEqual(viewport.height)
  // 2) nada cortado: o miolo de texto não precisa rolar e todo botão está dentro do balão
  const clipped = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>("[data-tour-balloon] .tour-body")!
    return body.scrollHeight - body.clientHeight
  })
  expect(clipped, "texto do balão cortado (precisaria rolar)").toBeLessThanOrEqual(1)
  for (const btn of await tour(page).locator("button").all()) {
    const b = (await boxOf(btn))!
    expect(b.left).toBeGreaterThanOrEqual(balloon.left - 0.5)
    expect(b.left + b.width).toBeLessThanOrEqual(balloon.left + balloon.width + 0.5)
    expect(b.top + b.height).toBeLessThanOrEqual(balloon.top + balloon.height + 0.5)
    // 3) alvos de toque de 44 px
    expect(b.height, `altura do botão "${await btn.innerText()}"`).toBeGreaterThanOrEqual(43.5)
    expect(b.width).toBeGreaterThanOrEqual(43.5)
  }
  const layout = await tour(page).getAttribute("data-layout")
  const spot = await boxOf(page.locator("[data-tour-spot]"))
  if (layout === "center") {
    // centralizado: no meio da janela (±2 px) e sem destaque
    expect(Math.abs(balloon.left + balloon.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(balloon.top + balloon.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2)
    expect(spot).toBeNull()
  } else if (targetName) {
    // 4) o destaque cobre o alvo (dentro de 1 px) e o balão NÃO cobre o destaque
    const target = (await boxOf(page.locator(`[data-tour="${targetName}"]:visible`).first()))!
    expect(spot, `destaque do alvo ${targetName}`).not.toBeNull()
    expect(spot!.left).toBeLessThanOrEqual(target.left + 1)
    expect(spot!.top).toBeLessThanOrEqual(target.top + 1)
    expect(spot!.left + spot!.width).toBeGreaterThanOrEqual(target.left + target.width - 1)
    expect(spot!.top + spot!.height).toBeGreaterThanOrEqual(target.top + target.height - 1)
    expect(overlap(balloon, target), `balão cobre o alvo ${targetName}`).toBe(false)
  }
  return { balloon, spot, layout }
}

/** Percorre TODOS os passos com "Próximo", rodando a régua em cada um. Devolve os títulos. */
async function walk(page: Page, viewport: { width: number; height: number }, targets: Record<string, string | undefined>) {
  const titles: string[] = []
  for (let guard = 0; guard < 30; guard++) {
    const t = (await title(page).innerText()).trim()
    titles.push(t)
    await ruler(page, viewport, targets[t])
    const label = (await next(page).innerText()).trim()
    await next(page).click()
    if (/concluir/i.test(label)) break
    await settle(page)
  }
  return titles
}

const DRIVER_TARGETS: Record<string, string | undefined> = {
  "Bem-vindo à InnoFlow!": undefined,
  "Eletropostos perto de você": "app-nav-mapa",
  "Carregar é só escanear": "home-qr",
  "Acompanhe a recarga": "app-nav-sessao",
  "Sua carteira": "app-nav-carteira",
  "Histórico e recibos": "app-nav-sessoes",
  "Seu perfil": "app-profile",
  "Tudo pronto!": undefined,
}

for (const size of SIZES) {
  test.describe(`tour do motorista @ ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test("abre sozinho na 1ª visita, percorre os 8 passos com a régua de geometria e conclui", async ({ page }) => {
      await login(page, DRIVER)
      await waitForTour(page, /tour do aplicativo/i)
      await expect(progress(page)).toHaveText("Passo 1 de 8")
      const titles = await walk(page, size, DRIVER_TARGETS)
      expect(titles).toEqual(Object.keys(DRIVER_TARGETS))
      await expect(tour(page)).toHaveCount(0)
      // o app está de volta: nada inerte, foco utilizável
      await expect(page.locator("#root")).not.toHaveAttribute("inert", "")
    })

    test("depois de concluir, recarregar a página NÃO reabre o tour (flag por usuário)", async ({ page }) => {
      await login(page, DRIVER)
      await waitForTour(page, /tour do aplicativo/i)
      for (let i = 0; i < 7; i++) await next(page).click()
      await next(page).click() // Concluir
      await expect(tour(page)).toHaveCount(0)
      const record = await page.evaluate(() => localStorage.getItem("innoflow:tour:v1:user_driver:driver"))
      expect(JSON.parse(record!)).toMatchObject({ version: 1, status: "completed" })
      await page.reload()
      await expect(page.locator("[data-app-shell]")).toBeVisible()
      await page.waitForTimeout(1600)
      await expect(tour(page)).toHaveCount(0)
    })
  })
}

test.describe("tour do motorista: pular, voltar, Esc, foco, rever", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("Pular tour fecha e grava 'skipped'; recarregar não reabre", async ({ page }) => {
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await page.getByRole("button", { name: "Pular tour" }).click()
    await expect(tour(page)).toHaveCount(0)
    const record = await page.evaluate(() => localStorage.getItem("innoflow:tour:v1:user_driver:driver"))
    expect(JSON.parse(record!).status).toBe("skipped")
    await page.reload()
    await page.waitForTimeout(1600)
    await expect(tour(page)).toHaveCount(0)
  })

  test("Voltar e as setas do teclado navegam; no 1º passo não há Voltar", async ({ page }) => {
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await expect(page.getByRole("button", { name: "Voltar" })).toHaveCount(0)
    await next(page).click()
    await expect(progress(page)).toHaveText("Passo 2 de 8")
    await page.getByRole("button", { name: "Voltar" }).click()
    await expect(progress(page)).toHaveText("Passo 1 de 8")
    await expect(next(page)).toBeFocused() // "Voltar" sumiu: o foco foi para o principal, não se perdeu
    await page.keyboard.press("ArrowRight")
    await expect(progress(page)).toHaveText("Passo 2 de 8")
    await page.keyboard.press("ArrowRight")
    await expect(progress(page)).toHaveText("Passo 3 de 8")
    await page.keyboard.press("ArrowLeft")
    await expect(progress(page)).toHaveText("Passo 2 de 8")
  })

  test("Esc fecha e grava 'skipped'", async ({ page }) => {
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await page.keyboard.press("Escape")
    await expect(tour(page)).toHaveCount(0)
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("innoflow:tour:v1:user_driver:driver")))!).status).toBe("skipped")
  })

  test("foco preso no balão, resto do app inerte, e o foco volta ao botão 'Rever tour' ao fechar", async ({ page }) => {
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await expect(page.locator("#root")).toHaveAttribute("inert", "")
    // Tab nunca sai do balão: 6 Tabs seguidos (mais que os 3 botões) e o foco continua dentro dele
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab")
      expect(await page.evaluate(() => !!document.activeElement?.closest("[data-tour-balloon]"))).toBe(true)
    }
    await page.keyboard.press("Escape")
    await expect(tour(page)).toHaveCount(0)

    await page.getByRole("link", { name: /meu perfil/i }).click()
    await expect(page.getByRole("heading", { name: "Meu perfil" })).toBeVisible()
    const replay = page.getByRole("button", { name: "Rever tour" })
    await replay.scrollIntoViewIfNeeded()
    await replay.focus()
    await replay.press("Enter")
    await waitForTour(page, /tour do aplicativo/i)
    await expect(progress(page)).toHaveText("Passo 1 de 8")
    await page.keyboard.press("Escape")
    await expect(tour(page)).toHaveCount(0)
    await expect(replay).toBeFocused()
  })

  test("alvo OCULTO: o passo cai no balão centralizado, sem destaque e sem erro", async ({ page }) => {
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await page.addStyleTag({ content: '[data-tour="app-nav-mapa"]{display:none !important}' })
    await next(page).click()
    await expect(title(page)).toHaveText("Eletropostos perto de você")
    await settle(page)
    const r = await ruler(page, { width: 375, height: 812 })
    expect(r.layout).toBe("center")
    await expect(page.locator("[data-tour-spot]")).toHaveCount(0)
    // o passo seguinte volta a ter destaque
    await next(page).click()
    await settle(page)
    await expect(page.locator("[data-tour-spot]")).toHaveCount(1)
  })

  test("alvo AUSENTE da página (QR do Início fora de /app): balão centralizado", async ({ page }) => {
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await page.keyboard.press("Escape")
    await page.getByRole("link", { name: "Carteira", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Carteira" })).toBeVisible()
    await page.getByRole("link", { name: /meu perfil/i }).click()
    await page.getByRole("button", { name: "Rever tour" }).click()
    await waitForTour(page, /tour do aplicativo/i)
    await next(page).click()
    await next(page).click()
    await expect(title(page)).toHaveText("Carregar é só escanear")
    await settle(page)
    expect((await ruler(page, { width: 375, height: 812 })).layout).toBe("center")
  })

  test("a rolagem do app não desalinha o destaque do QR (reposiciona)", async ({ page }) => {
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await next(page).click()
    await next(page).click()
    await expect(title(page)).toHaveText("Carregar é só escanear")
    await settle(page)
    await page.mouse.wheel(0, 120)
    await settle(page)
    await ruler(page, { width: 375, height: 812 }, "home-qr")
  })
})

test.describe("controle negativo da régua (ela PRECISA reprovar geometria errada)", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("balão empurrado para fora da janela é reprovado", async ({ page }) => {
    test.fail() // passa SE a régua falhar
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await page.addStyleTag({ content: ".tour-balloon{translate:160px 0 !important}" })
    await settle(page)
    await ruler(page, { width: 375, height: 812 })
  })

  test("balão cobrindo o alvo é reprovado", async ({ page }) => {
    test.fail()
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await next(page).click()
    await settle(page)
    await page.addStyleTag({ content: ".tour-balloon{transition:none !important;top:560px !important}" })
    await settle(page)
    await ruler(page, { width: 375, height: 812 }, "app-nav-mapa")
  })

  test("destaque deslocado do alvo é reprovado", async ({ page }) => {
    test.fail()
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await next(page).click()
    await settle(page)
    await page.addStyleTag({ content: ".tour-spot{transition:none !important;margin-left:90px !important}" })
    await settle(page)
    await ruler(page, { width: 375, height: 812 }, "app-nav-mapa")
  })
})

test.describe("tour: persistência por usuário e versão do roteiro", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("o registro é POR USUÁRIO: quem concluiu não incomoda o próximo usuário do mesmo aparelho", async ({ page }) => {
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Sair" }).click()
    await login(page, OTHER_DRIVER)
    await waitForTour(page, /tour do aplicativo/i) // outro usuário, mesmo aparelho: 1ª visita dele
    await page.keyboard.press("Escape")
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("innoflow:tour:")).sort())).toEqual([
      "innoflow:tour:v1:user_driver:driver",
      "innoflow:tour:v1:user_driver_devedor:driver",
    ])
  })

  test("roteiro de versão MAIOR que a do registro reabre o tour; versão igual não", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("innoflow:tour:v1:user_driver:driver", JSON.stringify({ version: 0, status: "completed", at: "2025-01-01T00:00:00.000Z" }))
      localStorage.setItem("innoflow:tour:v1:user_driver_devedor:driver", JSON.stringify({ version: 1, status: "completed", at: "2026-01-01T00:00:00.000Z" }))
    })
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i) // viu a versão 0: reexibe
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Sair" }).click()
    await login(page, OTHER_DRIVER)
    await expect(page.locator("[data-app-shell]")).toBeVisible()
    await page.waitForTimeout(1600)
    await expect(tour(page)).toHaveCount(0) // versão atual já concluída: não reabre
  })

  test("localStorage bloqueado: o app abre normalmente e o tour não se impõe", async ({ page }) => {
    await page.addInitScript(() => {
      const real = Storage.prototype.getItem
      Storage.prototype.getItem = function (key: string) {
        if (key.startsWith("innoflow:")) throw new DOMException("bloqueado", "SecurityError")
        return real.call(this, key)
      }
    })
    await login(page, DRIVER)
    await expect(page.locator("[data-app-shell]")).toBeVisible()
    await page.waitForTimeout(1600)
    await expect(tour(page)).toHaveCount(0)
  })
})

test.describe("movimento reduzido", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("com prefers-reduced-motion: reduce o mascote e o balão ficam estáticos; sem a preferência, se movem", async ({ page }) => {
    const animations = () =>
      page.evaluate(() => {
        const name = (sel: string) => getComputedStyle(document.querySelector(sel)!).animationName
        const trans = (sel: string) => getComputedStyle(document.querySelector(sel)!).transitionDuration
        return { body: name(".tm-body"), led: name(".tm-led"), eye: name(".tm-eye"), wave: name(".tm-wave"), spotTransition: document.querySelector("[data-tour-spot]") ? trans("[data-tour-spot]") : null }
      })
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await login(page, DRIVER)
    await waitForTour(page, /tour do aplicativo/i)
    const moving = await animations()
    expect(moving.body).toBe("tm-breathe")
    expect(moving.led).toBe("tm-led")
    expect(moving.eye).toBe("tm-blink")
    expect(moving.wave).toBe("tm-wave")

    await page.emulateMedia({ reducedMotion: "reduce" })
    await next(page).click()
    await settle(page)
    const still = await animations()
    expect(still).toMatchObject({ body: "none", led: "none", eye: "none", wave: "none" })
    // o `index.css` já zera a duração sob `reduce` (1e-6 s, não 0); aceitamos qualquer valor imperceptível
    expect(parseFloat(still.spotTransition ?? "1")).toBeLessThan(0.001)
    // e o tour continua 100% utilizável: balão visível, texto legível
    await expect(title(page)).toHaveText("Eletropostos perto de você")
    await ruler(page, { width: 1440, height: 900 }, "app-nav-mapa")
  })
})

test.describe("acessibilidade (axe) com o tour aberto", () => {
  for (const size of SIZES) {
    test(`motorista @ ${size.name}: 0 violações em cada passo`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await login(page, DRIVER)
      await waitForTour(page, /tour do aplicativo/i)
      for (let i = 0; i < 8; i++) {
        await settle(page)
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()
        expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `passo ${i + 1}`).toEqual([])
        await next(page).click()
      }
    })
  }
})

// ---------------------------------------------------------------- painel -------------------------------------------------------------

const ADMIN_WIDE_TARGETS: Record<string, string | undefined> = {
  "Bem-vindo ao painel da InnoFlow!": undefined,
  "O menu do painel": "admin-sidebar",
  "Dashboard e ao vivo": "nav-dashboard",
  Sites: "nav-sites",
  "Pontos de recarga": "nav-charge-points",
  Conectores: "nav-connectors",
  "Tarifas e vínculos": "nav-tariffs",
  Sessões: "nav-sessoes",
  Financeiro: "nav-financeiro",
  "Gateway de pagamento": "nav-gateway-pagamento",
  Configurações: "nav-configuracoes",
  "Atalhos rápidos": "admin-quick-actions",
  "Seu nome, aqui embaixo": "admin-user",
  "Tudo pronto!": undefined,
}

/** Mesmo roteiro com o passo "Backups" (entra depois de "Configurações") — só vale quando a tela existir no menu. */
const ADMIN_WIDE_TARGETS_WITH_BACKUPS: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(ADMIN_WIDE_TARGETS).flatMap(([title, target]) => (title === "Configurações" ? [[title, target], ["Backups", "nav-backups"]] : [[title, target]])),
)

test.describe("tour do painel (ADMIN) @ 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("todos os passos (14, ou 15 quando a tela de Backups entrar no menu), cada um com a régua; inclui Gateway e Configurações", async ({ page }) => {
    await login(page, ADMIN)
    await waitForTour(page, /tour do painel administrativo/i)
    // Backups: o passo existe se e somente se o menu já tem a tela (feature check do roteiro). Hoje não tem; quando entrar, o passo aparece sozinho.
    const hasBackups = (await page.getByRole("navigation", { name: /painel administrativo/i }).getByRole("link", { name: /backup/i }).count()) > 0
    const expected = hasBackups ? { ...ADMIN_WIDE_TARGETS_WITH_BACKUPS } : ADMIN_WIDE_TARGETS
    await expect(progress(page)).toHaveText(`Passo 1 de ${Object.keys(expected).length}`)
    const titles = await walk(page, { width: 1440, height: 900 }, expected)
    expect(titles).toEqual(Object.keys(expected))
    expect(titles.includes("Backups")).toBe(hasBackups)
  })

  test("com o menu recolhido (só ícones) o tour continua apontando para cada item", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("innoelektron-admin-sidebar-collapsed", "1"))
    await login(page, ADMIN)
    await waitForTour(page, /tour do painel administrativo/i)
    await next(page).click()
    await next(page).click()
    await expect(title(page)).toHaveText("Dashboard e ao vivo")
    await settle(page)
    await ruler(page, { width: 1440, height: 900 }, "nav-dashboard")
  })

  test("com um grupo do menu recolhido pelo usuário, o tour o abre para apontar (e o destaque aparece)", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("innoelektron-admin-nav-groups-open", JSON.stringify({ Financeiro: false })))
    await login(page, ADMIN)
    await waitForTour(page, /tour do painel administrativo/i)
    for (let i = 0; i < 8; i++) await next(page).click()
    await expect(title(page)).toHaveText("Financeiro")
    await settle(page)
    await ruler(page, { width: 1440, height: 900 }, "nav-financeiro")
  })

  test("Rever tour pelo menu do nome (rodapé da sidebar) reabre do 1º passo e devolve o foco ao fechar", async ({ page }) => {
    await login(page, ADMIN)
    await waitForTour(page, /tour do painel administrativo/i)
    await page.keyboard.press("Escape")
    const trigger = page.getByRole("button", { name: /menu do usuário: ana admin/i })
    await trigger.click()
    await page.getByRole("menuitem", { name: "Rever tour" }).click()
    await waitForTour(page, /tour do painel administrativo/i)
    await expect(progress(page)).toHaveText(/^Passo 1 de \d+$/)
    await page.keyboard.press("Escape")
    await expect(tour(page)).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test("redimensionar a janela para tablet no meio do tour reduz os passos e mantém o balão na tela", async ({ page }) => {
    await login(page, ADMIN)
    await waitForTour(page, /tour do painel administrativo/i)
    for (let i = 0; i < 3; i++) await next(page).click() // "Sites"
    await expect(title(page)).toHaveText("Sites")
    await page.setViewportSize({ width: 768, height: 1024 })
    await settle(page)
    await expect(progress(page)).toHaveText("Passo 1 de 4") // o passo deixou de existir: volta ao primeiro, sem quebrar
    await ruler(page, { width: 768, height: 1024 })
    await page.setViewportSize({ width: 1440, height: 900 })
    await settle(page)
    await expect(progress(page)).toHaveText(/de 1[45]$/)
  })

  test("redimensionar sem trocar de modo reposiciona o destaque sobre o alvo", async ({ page }) => {
    await login(page, ADMIN)
    await waitForTour(page, /tour do painel administrativo/i)
    for (let i = 0; i < 3; i++) await next(page).click()
    await expect(title(page)).toHaveText("Sites")
    await settle(page)
    await page.setViewportSize({ width: 1180, height: 700 })
    await settle(page)
    await ruler(page, { width: 1180, height: 700 }, "nav-sites")
  })

  test("checklist 'Primeiros passos': mostra o que falta (gateway), leva à tela, e dispensar persiste", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("innoflow:tour:v1:user_admin:admin", JSON.stringify({ version: 1, status: "completed", at: "2026-10-05T00:00:00.000Z" })))
    await login(page, ADMIN)
    const card = page.getByRole("region", { name: "Primeiros passos" })
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuetext", /^\d de 7 passos$/)
    const gateway = card.getByRole("link", { name: /configurar: configurar o gateway de pagamento/i })
    await expect(gateway).toBeVisible()
    // alvos de toque de 44 px
    for (const el of await card.getByRole("link").all()) expect((await boxOf(el))!.height).toBeGreaterThanOrEqual(43.5)
    for (const el of await card.getByRole("button").all()) expect((await boxOf(el))!.height).toBeGreaterThanOrEqual(43.5)
    const axe = await new AxeBuilder({ page }).include("[data-tour-checklist]").withTags(["wcag2a", "wcag2aa"]).analyze()
    expect(axe.violations).toEqual([])

    await card.getByRole("button", { name: /dispensar o checklist/i }).click()
    await expect(card).toHaveCount(0)
    await expect(page.getByRole("status").filter({ hasText: "Checklist dispensado" })).toBeAttached()
    await page.reload()
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
    await page.waitForTimeout(1200)
    await expect(page.getByRole("region", { name: "Primeiros passos" })).toHaveCount(0)
  })

  test("checklist 'Rever tour' dentro do card abre o tour", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("innoflow:tour:v1:user_admin:admin", JSON.stringify({ version: 1, status: "completed", at: "2026-10-05T00:00:00.000Z" })))
    await login(page, ADMIN)
    const card = page.getByRole("region", { name: "Primeiros passos" })
    await expect(card).toBeVisible({ timeout: 15_000 })
    await card.getByRole("button", { name: "Rever tour" }).click()
    await waitForTour(page, /tour do painel administrativo/i)
  })

  test("operação completa (gateway pronto + canal de aviso ativo): o card NÃO aparece (sem ruído)", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("innoflow:tour:v1:user_admin_gateway_pronto:admin", JSON.stringify({ version: 1, status: "completed", at: "2026-10-05T00:00:00.000Z" })))
    await login(page, "gateway-pronto@innoelektron.com")
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Faturamento por dia" })).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1200)
    await expect(page.getByRole("region", { name: "Primeiros passos" })).toHaveCount(0)
  })
})

test.describe("tour do painel (OPERATOR)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("o roteiro é o do ADMIN sem as telas só-ADMIN (12 passos, sem Gateway/Configurações/Rede)", async ({ page }) => {
    await login(page, OPERATOR)
    await waitForTour(page, /tour do painel do operador/i)
    await expect(progress(page)).toHaveText("Passo 1 de 12")
    const { "Gateway de pagamento": _g, Configurações: _c, ...operatorTargets } = ADMIN_WIDE_TARGETS
    void _g
    void _c
    const titles: string[] = []
    const texts: string[] = []
    for (let guard = 0; guard < 20; guard++) {
      const t = (await title(page).innerText()).trim()
      titles.push(t)
      texts.push(await tour(page).innerText())
      await settle(page)
      await ruler(page, { width: 1440, height: 900 }, operatorTargets[t])
      const label = (await next(page).innerText()).trim()
      await next(page).click()
      if (/concluir/i.test(label)) break
    }
    expect(titles).toEqual(Object.keys(operatorTargets))
    const all = texts.join("\n")
    expect(all).not.toMatch(/gateway|configurações|auditoria|tokens|cielo|\bRede\b|primeiros passos/i)
    // o menu do OPERATOR realmente não tem essas telas (o roteiro não esconde nada que existe)
    await expect(page.getByRole("link", { name: "Gateway de pagamento" })).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Configurações" })).toHaveCount(0)
  })

  test("OPERATOR não vê o card de Primeiros passos (é só do ADMIN)", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("innoflow:tour:v1:user_operator:operator", JSON.stringify({ version: 1, status: "completed", at: "2026-10-05T00:00:00.000Z" })))
    await login(page, OPERATOR)
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
    await page.waitForTimeout(1500)
    await expect(page.getByRole("region", { name: "Primeiros passos" })).toHaveCount(0)
  })
})

for (const size of SIZES.filter((s) => s.width < 1024)) {
  test.describe(`tour do painel @ ${size.name} (menu em drawer)`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test("4 passos: boas-vindas, botão do menu, atalhos, fim — cada um com a régua", async ({ page }) => {
      await login(page, ADMIN)
      await waitForTour(page, /tour do painel administrativo/i)
      await expect(progress(page)).toHaveText("Passo 1 de 4")
      const titles = await walk(page, size, { "O menu do painel": "admin-menu-button", "Atalhos rápidos": "admin-quick-actions" })
      expect(titles).toEqual(["Bem-vindo ao painel da InnoFlow!", "O menu do painel", "Atalhos rápidos", "Tudo pronto!"])
    })

    test("o passo do menu lista as áreas que o ADMIN realmente tem", async ({ page }) => {
      await login(page, ADMIN)
      await waitForTour(page, /tour do painel administrativo/i)
      await next(page).click()
      const text = await tour(page).innerText()
      for (const label of ["Dashboard", "Pontos de recarga", "Gateway de pagamento", "Configurações", "Auditoria"]) expect(text).toContain(label)
    })

    test("Rever tour no drawer do menu abre o tour do 1º passo", async ({ page }) => {
      await login(page, ADMIN)
      await waitForTour(page, /tour do painel administrativo/i)
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "Abrir menu" }).click()
      await page.getByRole("button", { name: "Rever tour" }).click()
      await waitForTour(page, /tour do painel administrativo/i)
      await expect(progress(page)).toHaveText("Passo 1 de 4")
      await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0)
    })

    test("OPERATOR: o texto do menu não cita telas só-ADMIN", async ({ page }) => {
      await login(page, OPERATOR)
      await waitForTour(page, /tour do painel do operador/i)
      await next(page).click()
      const text = await tour(page).innerText()
      expect(text).toContain("Dashboard")
      expect(text).not.toMatch(/gateway|configurações|auditoria|tokens/i)
    })

    test("axe: 0 violações em cada passo", async ({ page }) => {
      await login(page, ADMIN)
      await waitForTour(page, /tour do painel administrativo/i)
      for (let i = 0; i < 4; i++) {
        await settle(page)
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()
        expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `passo ${i + 1}`).toEqual([])
        await next(page).click()
      }
    })
  })
}

test.describe("axe do painel @ 1440 com o tour aberto", () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  test("0 violações em cada passo (ADMIN)", async ({ page }) => {
    await login(page, ADMIN)
    await waitForTour(page, /tour do painel administrativo/i)
    for (let i = 0; i < 14; i++) { // 14 passos; com Backups no menu haveria 15, e o 15º só rola (o axe cobre os 14 primeiros)
      await settle(page)
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()
      expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `passo ${i + 1}`).toEqual([])
      await next(page).click()
    }
  })
})
