import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → Gateway de pagamento no PADRÃO das demais telas do Admin (pedido do dono, 05/10/2026): mesma largura de conteúdo, mesmo cabeçalho e
 * mesmo ritmo vertical que Tarifas/Financeiro; alvos de toque >= 44 px a 375 px; barra de salvar que não tapa a tela quando não há o que salvar;
 * e a seção de webhook SEM instrução de cadastrar URL no Site Cielo (conta COMPARTILHADA com o Parque: cadastrar sobrescreveria a URL deles).
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

/** Geometria do miolo da tela aberta: o 1º filho do <main> é a raiz da página. */
async function layoutDoMiolo(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main")!
    const root = main.firstElementChild as HTMLElement
    const r = root.getBoundingClientRect()
    const h1 = root.querySelector("h1")!
    const header = h1.closest("header")!
    const kids = [...root.children].filter((k) => k.getBoundingClientRect().height > 0)
    const card = root.querySelector<HTMLElement>(".card-elevated")
    return {
      x: Math.round(r.x),
      width: Math.round(r.width),
      h1Count: root.querySelectorAll("h1").length,
      h1Size: getComputedStyle(h1).fontSize,
      h1Weight: getComputedStyle(h1).fontWeight,
      headerHeight: Math.round(header.getBoundingClientRect().height),
      gapHeaderToFirst: Math.round(kids[1].getBoundingClientRect().top - kids[0].getBoundingClientRect().bottom),
      cardRadius: card ? getComputedStyle(card).borderTopLeftRadius : null,
      mainOverflow: main.scrollWidth > main.clientWidth,
    }
  })
}

test.describe("layout igual ao das telas de referência (1440)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("Gateway tem a mesma largura, cabeçalho e ritmo que Tarifas e Financeiro", async ({ page }) => {
    await login(page, "gateway-pronto@innoelektron.com")
    const nav = page.getByRole("navigation", { name: NAV })

    await nav.getByRole("link", { name: "Tarifas" }).click()
    await expect(page.getByRole("heading", { name: "Tarifas", level: 1 })).toBeVisible()
    const tarifas = await layoutDoMiolo(page)

    await nav.getByRole("link", { name: "Financeiro" }).click()
    await expect(page.getByRole("heading", { name: "Financeiro", level: 1 })).toBeVisible()
    await expect(page.getByText("Resumo do período")).toBeVisible()
    const financeiro = await layoutDoMiolo(page)

    await nav.getByRole("link", { name: "Gateway de pagamento" }).click()
    await expect(page.getByRole("heading", { name: "Gateway de pagamento", level: 1 })).toBeVisible()
    await expect(page.getByTestId("section-webhook")).toBeVisible()
    const gateway = await layoutDoMiolo(page)

    // Sem `max-w-4xl mx-auto`: começa no mesmo x e ocupa a mesma largura (antes: x=400 e 896 px contra x=288 e 1120 px).
    expect(gateway.x).toBe(financeiro.x)
    expect(gateway.width).toBe(financeiro.width)
    expect(gateway.x).toBe(tarifas.x)
    for (const ref of [tarifas, financeiro]) {
      expect(gateway.h1Count).toBe(1)
      expect(gateway.h1Size).toBe(ref.h1Size)
      expect(gateway.h1Weight).toBe(ref.h1Weight)
      expect(gateway.headerHeight).toBe(ref.headerHeight)
      expect(gateway.gapHeaderToFirst).toBe(ref.gapHeaderToFirst)
    }
    expect(gateway.cardRadius).toBe(financeiro.cardRadius)
    expect(gateway.mainOverflow).toBe(false)
  })

  test("barra de salvar: só gruda quando há alteração; parada no fim da página quando não há", async ({ page }) => {
    await login(page, "gateway-pronto@innoelektron.com")
    await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Gateway de pagamento" }).click()
    const bar = page.getByTestId("save-bar")
    await expect(bar).toBeVisible()
    await expect(bar).toHaveCSS("position", "static")

    await page.getByLabel("MerchantId", { exact: true }).fill("mid-novo-123")
    await expect(bar).toHaveCSS("position", "sticky")
    // É um card como os outros: dentro da coluna de conteúdo (nada de sangrar por cima da margem do shell).
    const [barBox, headerBox] = await Promise.all([bar.boundingBox(), page.getByRole("heading", { name: "Gateway de pagamento", level: 1 }).boundingBox()])
    expect(barBox!.x).toBeGreaterThanOrEqual(288 - 1)
    expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(1408 + 1)
    expect(headerBox!.x).toBeGreaterThan(0)
  })
})

test.describe("conta Cielo compartilhada: webhook sem instrução de cadastro", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("com URL e header devolvidos pelo servidor, a seção avisa para NÃO cadastrar e mantém os dados", async ({ page }) => {
    await login(page, "admin@innoelektron.com") // mock: servidor com CIELO_WEBHOOK_PATH_TOKEN definido => o DTO traz webhookUrl
    await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Gateway de pagamento" }).click()
    const section = page.getByTestId("section-webhook")
    await expect(section).toBeVisible()

    await expect(page.getByTestId("webhook-shared-account-warning")).toContainText("Webhook não usado nesta conta compartilhada")
    await expect(page.getByTestId("webhook-shared-account-warning")).toContainText("Não cadastre URL de notificação no Site Cielo")
    await expect(page.getByTestId("webhook-shared-account-warning")).toContainText("Parque")
    // Informação do backend preservada (só consulta): URL, nome do header e o campo do segredo.
    await expect(section.locator("#webhook-url")).toHaveValue(/\/api\/webhooks\/cielo\//)
    await expect(section.locator("#webhook-header-name")).toHaveValue("InnoFlowWebhookSecret")
    await expect(page.getByTestId("secret-webhookHeaderSecret")).toBeVisible()
    // Nenhuma frase manda cadastrar a URL na Cielo.
    await expect(section).not.toContainText(/Cadastre a URL|cadastre no Site da Cielo|Cadastre este|cadastre este/)

    // Gerar o segredo continua funcionando, e a nota também NÃO manda cadastrar.
    await page.getByRole("button", { name: "Gerar segredo aleatório" }).click()
    const note = page.getByTestId("webhook-secret-generated-note")
    await expect(note).toContainText("antes de salvar")
    await expect(note).toContainText("Não o cadastre no Site Cielo")
  })

  test("sem URL nem segredo: estado 'não usado' com a mesma advertência", async ({ page }) => {
    await login(page, "gateway-sem-chave@innoelektron.com")
    await page.getByRole("navigation", { name: NAV }).getByRole("link", { name: "Gateway de pagamento" }).click()
    const notInUse = page.getByTestId("webhook-not-in-use")
    await expect(notInUse).toContainText("Webhook não usado (conta compartilhada)")
    await expect(notInUse).toContainText("Não cadastre URL de notificação no Site Cielo")
  })
})

test.describe("mobile 375: alvos de toque >= 44 px, sem rolagem horizontal", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  for (const [email, rotulo] of [
    ["gateway-pronto@innoelektron.com", "pronto"],
    ["admin@innoelektron.com", "env (webhook com URL)"],
  ] as const) {
    test(`${rotulo}: todo controle do miolo mede 44 px de altura (interruptor pelo alvo ampliado) e a página não rola de lado`, async ({ page }) => {
      await login(page, email)
      await page.goto("/admin/gateway-pagamento")
      await expect(page.getByTestId("section-webhook")).toBeVisible()
      // Abre os campos de segredo e gera o segredo do webhook para medir também o estado "preenchendo".
      await page.getByRole("button", { name: /^(Informar|Substituir) MerchantKey$/ }).click()

      const pequenos = await page.evaluate(() => {
        const out: string[] = []
        const main = document.querySelector("main")!
        const alvos = main.querySelectorAll<HTMLElement>("button, a[href], input:not(.sr-only), [role=switch]")
        for (const el of alvos) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          let altura = r.height
          if (el.getAttribute("role") === "switch") {
            // O trilho tem 24 px; o alvo é o ::before. Mede-se com o ponteiro: o elemento sob um ponto 20 px acima do trilho ainda é o interruptor?
            el.scrollIntoView({ block: "center" })
            const rr = el.getBoundingClientRect()
            const cx = rr.left + rr.width / 2
            const acima = document.elementFromPoint(cx, rr.top - 10) === el
            const abaixo = document.elementFromPoint(cx, rr.bottom + 10) === el
            altura = acima && abaixo ? 44 : rr.height
          }
          if (altura < 44) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" h=${Math.round(altura)}`)
        }
        return out
      })
      expect(pequenos, `alvos < 44 px: ${pequenos.join(" | ")}`).toEqual([])

      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main")!
        return { main: main.scrollWidth - main.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth }
      })
      expect(overflow).toEqual({ main: 0, doc: 0 })
    })
  }

  test("diálogos: botões e fechar com alvo >= 44 px; Tab fica preso dentro do diálogo", async ({ page }) => {
    await login(page, "gateway-pronto@innoelektron.com")
    await page.goto("/admin/gateway-pagamento")
    await page.getByLabel("MerchantId", { exact: true }).fill("mid-novo-123")
    await page.getByRole("button", { name: "Salvar alterações" }).click()
    const dialog = page.getByRole("dialog", { name: "Confirmar alterações no gateway" })
    await expect(dialog).toBeVisible()
    for (const name of ["Cancelar", "Confirmar e salvar"]) {
      // offsetHeight (layout): `boundingBox` mede a caixa já escalada pela animação de entrada do diálogo (scale-in) e daria 43,6.
      const altura = await dialog.getByRole("button", { name }).evaluate((el) => (el as HTMLElement).offsetHeight)
      expect(altura, name).toBeGreaterThanOrEqual(44)
    }
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).animationName === "none" || el.getAnimations().every((a) => a.playState === "finished"))).toBe(true)
    // Fechar (X): alvo ampliado pelo ::before (28 px visíveis + 8 de cada lado).
    const fechar = await dialog.getByRole("button", { name: "Fechar" }).evaluate((el) => {
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      return { acima: document.elementFromPoint(cx, r.top - 6) === el, abaixo: document.elementFromPoint(cx, r.bottom + 6) === el }
    })
    expect(fechar).toEqual({ acima: true, abaixo: true })

    // Ordem de tab: a senha recebe o foco; depois de percorrer todos os controles volta ao diálogo (nunca vaza para a página).
    await expect(dialog.getByLabel("Sua senha atual")).toBeFocused()
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab")
      const dentro = await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))
      expect(dentro).toBe(true)
    }
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
  })

  test("diálogo de produção: campo de confirmação com foco, botões de 44 px, Esc fecha", async ({ page }) => {
    await login(page, "gateway-pronto@innoelektron.com")
    await page.goto("/admin/gateway-pagamento")
    await page.getByTestId("section-environment").locator("label").filter({ hasText: "Produção" }).click()
    const dialog = page.getByRole("dialog", { name: "Passar para produção?" })
    await expect(dialog).toBeVisible()
    for (const name of ["Cancelar", "Selecionar produção"]) {
      // offsetHeight (layout): `boundingBox` mede a caixa já escalada pela animação de entrada do diálogo (scale-in) e daria 43,6.
      const altura = await dialog.getByRole("button", { name }).evaluate((el) => (el as HTMLElement).offsetHeight)
      expect(altura, name).toBeGreaterThanOrEqual(44)
    }
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
  })
})
