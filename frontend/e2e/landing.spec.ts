import { expect, test, type Page } from "@playwright/test"

/**
 * Landing pública "/" (src/pages/Public/Home.tsx + src/components/landing/*), contra o dev server com mocks.
 *
 * O que se PROVA aqui: carregamento, landmarks/h1 único, mascote (imagem real carregada, com srcset e dimensões),
 * CTAs que navegam, abas do tour, `prefers-reduced-motion` (nenhum loop, nada escondido, sem autoplay), geometria
 * no celular (nenhum texto/botão passa da largura da tela) e as regras de conteúdo (Pix/cartão só "em breve").
 * O que NÃO se prova: desempenho percebido em aparelho real (ver Lighthouse no handoff) e a aparência (screenshots
 * olhados à parte).
 */

/**
 * Abre a landing e monta o conteúdo de baixo da dobra. Ele só é montado quando há intenção de rolar (rolagem, toque,
 * tecla, clique, hash) ou quando a faixa-reserva chega perto da tela — por isso o 1px de rolagem aqui, como uma pessoa
 * faria. O teste "carregamento enxuto" abaixo cobre o comportamento sem interação.
 */
async function openLanding(page: Page, path = "/") {
  await page.goto(path)
  await page.locator("#hero-title").waitFor()
  await page.evaluate(() => window.scrollBy(0, 1))
  await page.locator("#cta-final-titulo").waitFor({ state: "attached" })
}

async function scrollThrough(page: Page) {
  const total = await page.evaluate(() => document.documentElement.scrollHeight)
  const vh = page.viewportSize()?.height ?? 800
  for (let y = 0; y < total; y += Math.round(vh * 0.7)) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y)
    await page.waitForTimeout(80)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
}

test.describe("estrutura e conteúdo", () => {
  test("carrega com um único h1, landmarks e o mascote com alt, srcset e dimensões", async ({ page }) => {
    await openLanding(page)
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Recarregue seu elétrico")
    await expect(page.getByRole("banner")).toHaveCount(1)
    await expect(page.getByRole("main")).toHaveCount(1)
    await expect(page.getByRole("contentinfo")).toHaveCount(1)

    const mascot = page.getByRole("img", { name: /Mascote da InnoFlow/ }).first()
    await expect(mascot).toBeVisible()
    const info = await mascot.evaluate((el: HTMLImageElement) => ({
      loaded: el.complete && el.naturalWidth > 0,
      srcset: el.srcset.split(",").length,
      width: el.getAttribute("width"),
      height: el.getAttribute("height"),
      priority: el.getAttribute("fetchpriority"),
      loading: el.getAttribute("loading"),
      format: /\.webp$/.test(el.currentSrc),
    }))
    expect(info).toEqual({ loaded: true, srcset: 4, width: "1006", height: "1358", priority: "high", loading: "eager", format: true })
  })

  test("carregamento enxuto: sem interação (nem rolagem) o conteúdo de baixo da dobra não é montado; o 1º sinal de rolagem monta", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto("/")
    await page.locator("#hero-title").waitFor()
    await page.waitForTimeout(1500)
    await expect(page.getByTestId("below-fold-placeholder")).toHaveCount(1)
    await expect(page.locator("#como-funciona")).toHaveCount(0)
    // o hero inteiro, a faixa de fatos e o rodapé (landmarks) já estão lá
    await expect(page.locator("#inicio")).toBeVisible()
    await expect(page.getByRole("contentinfo")).toHaveCount(1)
    await page.mouse.wheel(0, 400)
    await expect(page.locator("#como-funciona")).toHaveCount(1)
    await expect(page.getByTestId("below-fold-placeholder")).toHaveCount(0)
  })

  test("o mascote do CTA final e as demais imagens abaixo da dobra carregam sob demanda (lazy)", async ({ page }) => {
    await openLanding(page)
    await scrollThrough(page)
    const lazy = await page.locator("main img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).loading))
    // Hero (eager) + logos/ícones pequenos; o mascote do final é o único <img> do mascote fora do hero e é lazy.
    const finalMascot = page.locator("#cta-final-titulo").locator("xpath=ancestor::section").getByRole("img", { name: /Mascote da InnoFlow/ })
    await expect(finalMascot).toHaveAttribute("loading", "lazy")
    expect(lazy.filter((l) => l === "eager").length).toBeLessThanOrEqual(2)
  })

  test("SEO e compartilhamento: title, description, Open Graph, Twitter card e JSON-LD verdadeiro", async ({ page }) => {
    await openLanding(page)
    await expect(page).toHaveTitle(/InnoFlow/)
    const meta = (sel: string) => page.locator(sel).first().getAttribute("content")
    expect(await meta('meta[name="description"]')).toContain("recarga de veículos elétricos")
    expect(await meta('meta[property="og:title"]')).toContain("InnoFlow")
    expect(await meta('meta[property="og:image"]')).toMatch(/^https:\/\/.+\/brand\/og-innoflow\.jpg$/)
    expect(await meta('meta[property="og:image:width"]')).toBe("1200")
    expect(await meta('meta[property="og:image:height"]')).toBe("630")
    expect(await meta('meta[name="twitter:card"]')).toBe("summary_large_image")

    const ld = await page.locator('script[type="application/ld+json"]').first().textContent()
    const graph = JSON.parse(ld ?? "{}")["@graph"] as Array<Record<string, unknown>>
    expect(graph.map((n) => n["@type"])).toEqual(["Organization", "WebSite"])
    // nada de nota, avaliação, preço ou endereço inventado
    expect(ld).not.toMatch(/aggregateRating|ratingValue|price|address|telephone|review/i)

    const og = await page.request.get("/brand/og-innoflow.jpg")
    expect(og.ok()).toBe(true)
    expect(og.headers()["content-type"]).toContain("image/jpeg")
  })

  test("regra de ouro: Pix/cartão só aparecem como 'em breve'; nada de depoimento, estrela ou contato inventado", async ({ page }) => {
    await openLanding(page)
    await scrollThrough(page)
    const blocks = await page.locator("main p, main li, main h3, main summary, main details").allInnerTexts()
    const pay = blocks.filter((t) => /(?<![\p{L}])(pix|cart[aã]o)(?![\p{L}])/iu.test(t))
    expect(pay.length).toBeGreaterThan(0)
    for (const t of pay) expect(t.toLowerCase(), t).toContain("em breve")

    const text = (await page.locator("main").innerText()) + (await page.locator("footer").innerText())
    expect(text).not.toMatch(/depoiment|★|⭐|certifica|prêmio|whatsapp|\(\d{2}\)\s?\d{4,5}-?\d{4}|@[\w-]+\.\w{2,}/i)
    // as telas de exemplo se declaram exemplo
    await expect(page.getByText("Telas ilustrativas, com dados de exemplo.").first()).toBeVisible()
    await expect(page.getByText("Dados de exemplo").first()).toBeVisible()
  })
})

test.describe("navegação", () => {
  test("CTAs do hero levam a /eletropostos, /cadastro e /login", async ({ page }) => {
    const hero = () => page.locator("#inicio")

    await openLanding(page)
    await hero().getByRole("link", { name: /Ver eletropostos/ }).click()
    await expect(page).toHaveURL(/\/eletropostos$/)
    await expect(page.getByRole("heading", { level: 1, name: "Eletropostos" })).toBeVisible()

    await openLanding(page)
    await hero().getByRole("link", { name: "Criar conta" }).click()
    await expect(page).toHaveURL(/\/cadastro$/)

    await openLanding(page)
    await hero().getByRole("link", { name: "Entrar" }).click()
    await expect(page).toHaveURL(/\/login$/)
  })

  test("menu de seções: âncoras levam à seção e o link 'Eletropostos' navega", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page)
    const nav = page.getByRole("navigation", { name: "Seções da página" })
    await nav.getByRole("link", { name: "Recursos" }).click()
    await expect(page).toHaveURL(/#recursos$/)
    await expect(page.locator("#recursos")).toBeInViewport()
    await nav.getByRole("link", { name: "Eletropostos" }).click()
    await expect(page).toHaveURL(/\/eletropostos$/)
  })

  test("link direto para uma seção (/#recursos) rola até ela mesmo com o chunk de baixo carregando depois", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page, "/#recursos")
    await expect(page.locator("#recursos")).toBeInViewport()
  })

  test("no celular o menu abre, fecha com Esc e devolve o foco ao botão", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await openLanding(page)
    const toggle = page.getByRole("button", { name: "Abrir menu" })
    await toggle.click()
    const menu = page.getByRole("navigation", { name: "Seções da página (menu)" })
    await expect(menu).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(menu).toBeHidden()
    await expect(page.getByRole("button", { name: "Abrir menu" })).toBeFocused()
  })

  test("logado, o cabeçalho troca 'Criar conta' pelo atalho da área (motorista -> Meu app)", async ({ page }) => {
    await page.goto("/login")
    await page.getByLabel("E-mail").fill("motorista@innoelektron.com")
    await page.getByLabel("Senha").fill("senha1234")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page).toHaveURL(/\/app/)
    await openLanding(page)
    const header = page.getByRole("banner")
    await expect(header.getByRole("link", { name: "Meu app" })).toHaveAttribute("href", "/app")
    await expect(header.getByRole("link", { name: "Criar conta" })).toHaveCount(0)
  })

  test("rota inexistente continua caindo na landing e /eletropostos segue no layout público claro", async ({ page }) => {
    await page.goto("/nao-existe")
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Recarregue seu elétrico")
    await page.goto("/eletropostos")
    await expect(page.getByRole("navigation", { name: "Navegação principal" })).toBeVisible()
  })
})

test.describe("tour do motorista (celular animado)", () => {
  test("clicar numa etapa troca o texto e a tela do celular; setas navegam pelo teclado", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page)
    const tour = page.locator("#como-funciona")
    await tour.scrollIntoViewIfNeeded()
    const tabs = tour.getByRole("tab")
    await expect(tabs).toHaveCount(5)
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true")

    await tour.getByTestId("tour-tab-carregando").click()
    await expect(tour.getByRole("tabpanel")).toContainText("Acompanhe em tempo real")
    await expect(page.locator('[data-screen="carregando"]')).toHaveAttribute("data-active", "true")
    await expect(page.locator('[data-screen="mapa"]')).toHaveAttribute("data-active", "false")

    await tour.getByTestId("tour-tab-carregando").focus()
    await page.keyboard.press("ArrowDown")
    await expect(tour.getByTestId("tour-tab-recibo")).toHaveAttribute("aria-selected", "true")
    await expect(page.locator('[data-screen="recibo"]')).toHaveAttribute("data-active", "true")
    await page.keyboard.press("Home")
    await expect(tour.getByTestId("tour-tab-mapa")).toHaveAttribute("aria-selected", "true")
  })

  test("o contador de kWh do celular sobe de verdade enquanto a tela 'Acompanhe' está ativa", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page)
    const tour = page.locator("#como-funciona")
    await tour.scrollIntoViewIfNeeded()
    await tour.getByTestId("tour-tab-carregando").click()
    const kwh = page.locator('[data-screen="carregando"] .text-gradient-brand').first()
    const parse = async () => Number((await kwh.innerText()).replace("kWh", "").trim().replace(",", "."))
    const a = await parse()
    await page.waitForTimeout(1500)
    const b = await parse()
    expect(b).toBeGreaterThan(a)
  })

  test("há botão para pausar a animação (WCAG 2.2.2) e ele para o avanço automático", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page)
    const tour = page.locator("#como-funciona")
    await tour.scrollIntoViewIfNeeded()
    await expect(tour.getByTestId("tour-progress")).toHaveCount(1)
    const pause = tour.getByRole("button", { name: "Pausar animação" })
    await pause.click()
    await expect(tour.getByRole("button", { name: "Retomar animação" })).toHaveAttribute("aria-pressed", "true")
    await expect(tour.getByTestId("tour-progress")).toHaveCount(0)
  })
})

test.describe("prefers-reduced-motion: reduce", () => {
  test.use({ reducedMotion: "reduce" })

  test("nenhuma animação em loop, nada escondido por revelação, sem autoplay, tudo legível", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page)
    await scrollThrough(page)

    const info = await page.evaluate(() => {
      const anims = document.getAnimations()
      const looping = anims.filter((a) => (a.effect?.getComputedTiming().iterations ?? 1) === Infinity)
      const running = anims.filter((a) => a.playState === "running")
      return {
        looping: looping.map((a) => (a as CSSAnimation).animationName ?? a.id),
        running: running.map((a) => (a as CSSAnimation).animationName ?? a.id),
        hidden: document.querySelectorAll('[data-reveal="hidden"]').length,
      }
    })
    // Os únicos CSS animation que sobrevivem são os utilitários do app (ex.: animate-pulse/spin do Tailwind) —
    // nenhuma classe da landing (`lnd-*`) pode estar rodando.
    expect(info.looping.filter((n) => /^lnd-/.test(n))).toEqual([])
    expect(info.running.filter((n) => /^lnd-/.test(n))).toEqual([])
    expect(info.hidden).toBe(0)

    // texto essencial visível e com opacidade cheia
    for (const sel of ["#hero-title", "#como-funciona-titulo", "#operadores-titulo", "#recursos-titulo", "#seguranca-titulo", "#perguntas-titulo", "#cta-final-titulo"]) {
      const o = await page.locator(sel).evaluate((el) => Number(getComputedStyle(el.parentElement?.closest("[data-reveal-from], div") ?? el).opacity))
      expect(o, sel).toBe(1)
      await expect(page.locator(sel)).toBeVisible()
    }
    await expect(page.getByRole("button", { name: /animação/ })).toHaveCount(0)
    await expect(page.getByTestId("tour-progress")).toHaveCount(0)
    // as pálpebras do mascote nunca aparecem
    const eyes = await page.locator(".lnd-eye").evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity))
    expect(eyes.every((o) => o === "0")).toBe(true)
  })

  test("o tour continua utilizável por clique e o kWh do celular fica parado", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page)
    const tour = page.locator("#como-funciona")
    await tour.scrollIntoViewIfNeeded()
    await tour.getByTestId("tour-tab-carregando").click()
    await expect(page.locator('[data-screen="carregando"]')).toHaveAttribute("data-active", "true")
    const kwh = page.locator('[data-screen="carregando"] .text-gradient-brand').first()
    const a = await kwh.innerText()
    await page.waitForTimeout(1200)
    expect(await kwh.innerText()).toBe(a)
  })

  test("o canvas de fluxo desenha um único quadro estático (existe e tem tamanho)", async ({ page }) => {
    await openLanding(page)
    const canvas = page.getByTestId("hero-flow")
    await expect(canvas).toHaveCount(1)
    await page.waitForTimeout(1500)
    const size = await canvas.evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }))
    expect(size.w).toBeGreaterThan(100)
    expect(size.h).toBeGreaterThan(100)
  })
})

test.describe("movimento ligado (padrão)", () => {
  test.use({ reducedMotion: "no-preference" })

  test("o mascote flutua, as pálpebras piscam e o conteúdo abaixo da dobra aparece ao rolar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page)
    const names = await page.evaluate(() => document.getAnimations().map((a) => (a as CSSAnimation).animationName))
    for (const n of ["lnd-float", "lnd-blink", "lnd-breathe"]) expect(names, n).toContain(n)

    // abaixo da dobra começa escondido e aparece ao rolar
    const target = page.locator("#recursos-titulo")
    await expect.poll(() => target.evaluate((el) => el.closest("[data-reveal]")?.getAttribute("data-reveal") ?? "none")).toBe("hidden")
    await target.scrollIntoViewIfNeeded()
    await expect.poll(() => target.evaluate((el) => el.closest("[data-reveal]")?.getAttribute("data-reveal"))).toBe("shown")
  })
})

test.describe("geometria", () => {
  for (const [name, width, height] of [
    ["celular 375", 375, 812],
    ["tablet 768", 768, 1024],
    ["desktop 1440", 1440, 900],
  ] as const) {
    test(`${name}: nenhum texto, botão ou card passa da largura da tela e não há rolagem horizontal`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await openLanding(page)
      await scrollThrough(page)
      const result = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth
        const offenders: string[] = []
        // O que é decorativo e sangra de propósito (blobs, brilho, anel, canvas, sombras do painel 3D) é aria-hidden.
        const sel = "main h1, main h2, main h3, main p, main li, main a, main button, main summary, footer p, footer a, footer li"
        document.querySelectorAll(sel).forEach((el) => {
          if (el.closest("[aria-hidden='true']")) return
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) return
          if (r.right > vw + 1 || r.left < -1) offenders.push(`${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 40)} [${Math.round(r.left)}..${Math.round(r.right)}]`)
        })
        return { vw, sw: document.documentElement.scrollWidth, bodySw: document.body.scrollWidth, offenders }
      })
      expect(result.offenders).toEqual([])
      expect(result.sw).toBeLessThanOrEqual(result.vw)
      expect(result.bodySw).toBeLessThanOrEqual(result.vw)
    })
  }

  test("celular 375: o mascote cabe inteiro na largura e o hero mostra os dois CTAs sem cortar", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await openLanding(page)
    const box = await page.locator('[data-testid="hero-stage"] .lnd-mascot-box').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
    // proporção do recorte preservada (sem esticar): 1006x1358
    expect(box!.width / box!.height).toBeCloseTo(1006 / 1358, 1)
    for (const name of ["Ver eletropostos", "Criar conta"]) {
      const b = await page.locator("#inicio").getByRole("link", { name: new RegExp(name) }).boundingBox()
      expect(b!.x).toBeGreaterThanOrEqual(0)
      expect(b!.x + b!.width).toBeLessThanOrEqual(375)
      expect(b!.height).toBeGreaterThanOrEqual(44)
    }
  })

  test("desktop 1440: mascote visível na primeira tela, ao lado do texto, sem sobrepor o h1", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page)
    const m = await page.locator('[data-testid="hero-stage"] .lnd-mascot-box').boundingBox()
    const h = await page.locator("#hero-title").boundingBox()
    expect(m!.y + m!.height).toBeLessThanOrEqual(900 + 40)
    expect(m!.x).toBeGreaterThan(h!.x + h!.width * 0.6)
    // os cartões flutuantes não encostam no h1
    const chips = await page.locator(".lnd-chip").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left))
    for (const left of chips) expect(left).toBeGreaterThan(h!.x + h!.width - 10)
  })
})

test.describe("acessibilidade", () => {
  test("link 'Pular para o conteúdo' é o primeiro foco e leva ao <main>", async ({ page }) => {
    await openLanding(page)
    await page.keyboard.press("Tab")
    const skip = page.getByRole("link", { name: "Pular para o conteúdo" })
    await expect(skip).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/#conteudo$/)
  })

  test("todos os links e botões do hero têm nome acessível e alvo de toque de pelo menos 44px no celular", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await openLanding(page)
    const small = await page.locator("#inicio a, #inicio button, header a, header button").evaluateAll((els) =>
      els
        .map((e) => ({ name: (e.getAttribute("aria-label") ?? e.textContent ?? "").trim(), r: e.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0 && x.r.height > 0)
        .filter((x) => !x.name || x.r.height < 44 - 0.5 && !/Entrar/.test(x.name))
        .map((x) => `${x.name || "(sem nome)"} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
    )
    expect(small).toEqual([])
  })

  test("o foco do teclado é visível nos botões sobre fundo escuro (contorno lima)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLanding(page)
    await page.locator("#inicio").getByRole("link", { name: /Ver eletropostos/ }).focus()
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Tab")
    const outline = await page.locator("#inicio").getByRole("link", { name: /Ver eletropostos/ }).evaluate((el) => {
      const s = getComputedStyle(el)
      return { width: s.outlineWidth, color: s.outlineColor, style: s.outlineStyle }
    })
    expect(outline.style).toBe("solid")
    expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2)
    expect(outline.color.replace(/\s/g, "")).toBe("rgb(97,219,36)")
  })

  test("FAQ: abre e fecha por teclado e só um item fica aberto por vez", async ({ page }) => {
    await openLanding(page)
    const faq = page.locator("#perguntas")
    await faq.scrollIntoViewIfNeeded()
    const first = faq.getByText("Preciso baixar um aplicativo?")
    await first.focus()
    await page.keyboard.press("Enter")
    await expect(faq.locator("details[open]")).toHaveCount(1)
    await expect(faq.getByText(/funciona no navegador do celular/)).toBeVisible()
    await faq.getByText("Como pago a recarga?").click()
    await expect(faq.locator("details[open]")).toHaveCount(1)
    await expect(faq.getByText(/ainda não está disponível e chega em breve/)).toBeVisible()
  })
})
