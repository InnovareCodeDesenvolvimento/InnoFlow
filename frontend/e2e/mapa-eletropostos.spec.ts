import { expect, test, type BrowserContext, type Page } from "@playwright/test"

/**
 * Aba "Mapa" do PWA (eletropostos perto de mim), contra os mocks MSW
 * (`src/mocks/stationsData.ts`). Geolocalização real do navegador
 * (`grantPermissions` + `setGeolocation` do Playwright) — o que NÃO se prova
 * aqui: GPS de aparelho de verdade e tiles reais (interceptados com um PNG de
 * 1×1; só o HOST pedido é registrado).
 *
 * Posição de teste: a ~240 m do "Shopping Paulista" (`st_paulista`, o mais
 * próximo). Números do mock: Paulista tem 4 conectores, 2 livres; o stream de
 * tempo real vira um deles ocupado 5 s depois de conectar.
 */

const DRIVER = { email: "motorista@innoelektron.com", password: "senha1234" }
const USER_POSITION = { latitude: -23.5631, longitude: -46.6544 }
// Trecho exato da posição que NUNCA pode aparecer em nenhuma requisição.
const EXACT_LAT = "23.5631"
const EXACT_LNG = "46.6544"

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")

async function stubTiles(context: BrowserContext): Promise<string[]> {
  const hosts: string[] = []
  await context.route(/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/, (route) => {
    hosts.push(new URL(route.request().url()).host)
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 })
  })
  return hosts
}

async function loginAndGo(page: Page, path: string) {
  await page.goto(`/login?redirect=${encodeURIComponent(path)}`)
  await page.getByLabel("E-mail").fill(DRIVER.email)
  await page.getByLabel("Senha").fill(DRIVER.password)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(new RegExp(path.replace(/\//g, "\\/")))
}

const cards = (page: Page) => page.locator("[data-station-id][data-state]:not(a)")
const cardNames = (page: Page) => cards(page).locator("h3").allTextContents()

test.describe("com permissão de localização", () => {
  test.use({ geolocation: USER_POSITION, permissions: ["geolocation"], viewport: { width: 390, height: 844 } })

  test("mais próximo primeiro, com distância e '2 de 4 conectores livres'; privacidade: nenhuma requisição leva a posição exata", async ({ page }) => {
    const leaked: string[] = []
    const siteRequests: URL[] = []
    page.on("request", (req) => {
      const raw = `${req.url()} ${req.postData() ?? ""}`
      if (raw.includes(EXACT_LAT) || raw.includes(EXACT_LNG)) leaked.push(req.url())
      const url = new URL(req.url())
      if (url.pathname === "/api/sites") siteRequests.push(url)
    })

    await loginAndGo(page, "/app/mapa")

    const first = cards(page).first()
    await expect(first.locator("h3")).toHaveText("Shopping Paulista")
    // (o stream de tempo real vira um conector ~5 s depois: aqui só importa que é "x de 4")
    await expect(first).toContainText(/\d de 4 conectores livres/)
    await expect(first).toContainText("Livre agora")
    await expect(first).toContainText(/\d+ m/) // "240 m"

    // Distâncias em ordem crescente (parse "850 m" / "1,2 km" / "12 km").
    const distances = (await cards(page).locator("span[title='Distância em linha reta']").allTextContents()).map((t) => {
      const n = Number(t.replace(/[^\d,]/g, "").replace(",", "."))
      return t.includes("km") ? n : n / 1000
    })
    expect(distances.length).toBeGreaterThan(3)
    expect(distances).toEqual([...distances].sort((a, b) => a - b))

    // ---- Privacidade (LGPD) ------------------------------------------------
    expect(siteRequests.length).toBeGreaterThan(0)
    const withBox = siteRequests.filter((u) => u.searchParams.has("minLat"))
    expect(withBox.length).toBeGreaterThan(0)
    for (const url of withBox) {
      for (const key of ["minLat", "maxLat", "minLng", "maxLng"]) {
        const value = Number(url.searchParams.get(key))
        expect(Math.abs(value * 10 - Math.round(value * 10)), `${key}=${value} deve ser múltiplo de 0,1`).toBeLessThan(1e-6)
      }
    }
    expect(leaked, "posição exata não pode ir em URL nem corpo de nenhuma requisição").toEqual([])
    // ...nem ficar guardada no aparelho.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
    expect(stored).not.toContain(EXACT_LAT)
    expect(stored).not.toContain(EXACT_LNG)
  })

  test("Home: 'Perto de você' com os 3 mais próximos; tocar abre o detalhe da estação", async ({ page }) => {
    await loginAndGo(page, "/app")
    const section = page.getByRole("region", { name: "Perto de você" })
    const rows = section.locator("a[data-station-id]")
    await expect(rows).toHaveCount(3)
    await expect(rows.first()).toContainText("Shopping Paulista")
    await expect(rows.first()).toContainText("de 4 conectores livres")
    await expect(rows.first()).toContainText(/\d+ m/)

    await rows.first().click()
    await expect(page).toHaveURL(/\/app\/mapa$/)
    const sheet = page.getByRole("dialog")
    await expect(sheet.getByRole("heading", { name: "Shopping Paulista" })).toBeVisible()
  })

  test("detalhe: conectores com status, preço, Como chegar/Waze — e NUNCA 'Iniciar recarga' nem promessa de reserva", async ({ page }) => {
    await loginAndGo(page, "/app/mapa")
    await cards(page).first().getByRole("button", { name: /Shopping Paulista: ver detalhes/ }).click()
    const sheet = page.getByRole("dialog")
    await expect(sheet.getByRole("heading", { name: "Shopping Paulista" })).toBeVisible()
    await expect(sheet.getByText("CP-PAULISTA-01")).toBeVisible()
    await expect(sheet.getByText("Livre agora").first()).toBeVisible()
    await expect(sheet.getByText(/atualizado/)).toBeVisible()
    await expect(sheet.getByText(/R\$\s*1,99/).first()).toBeVisible() // preço só existe aqui (a lista não traz)
    await expect(sheet.getByRole("link", { name: /Como chegar/ })).toHaveAttribute("href", /google\.com\/maps\/dir\/\?api=1&destination=-23\.5614,-46\.6559/)
    await expect(sheet.getByRole("link", { name: /Waze/ })).toHaveAttribute("href", "https://waze.com/ul?ll=-23.5614,-46.6559&navigate=yes")
    await expect(sheet.getByText(/não é possível reservar/)).toBeVisible()

    await expect(page.getByText(/iniciar recarga/i)).toHaveCount(0)
    await expect(page.getByText(/estará livre/i)).toHaveCount(0)

    await page.keyboard.press("Escape")
    await expect(sheet).toHaveCount(0)
  })

  test("tempo real: um conector vira ocupado e a lista muda SOZINHA (sem F5)", async ({ page }) => {
    let reloads = 0
    page.on("framenavigated", (frame) => frame === page.mainFrame() && (reloads += 1))
    await loginAndGo(page, "/app/mapa")
    const first = cards(page).first()
    await expect(first).toContainText(/\d de 4 conectores livres/)
    const before = (await first.textContent())!.match(/(\d) de 4 conectores livres/)![1]
    const navsBefore = reloads
    // O stream do mock vira um conector do Paulista ~5 s depois de conectar (2 → 1): o número muda sem recarregar a página.
    await expect(first).not.toContainText(`${before} de 4 conectores livres`, { timeout: 25_000 })
    await expect(first).toContainText(/\d de 4 conectores livres/)
    expect(reloads).toBe(navsBefore)
  })
})

test.describe("sem permissão de localização (negada)", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("fallback: mensagem clara, lista por nome SEM bbox, busca por cidade/endereço funciona", async ({ page }) => {
    const siteRequests: URL[] = []
    page.on("request", (req) => {
      const url = new URL(req.url())
      if (url.pathname === "/api/sites") siteRequests.push(url)
    })

    await loginAndGo(page, "/app/mapa")

    // Convite (não pede sozinho); o clique é negado pelo navegador.
    await page.getByRole("button", { name: "Usar minha localização" }).click()
    await expect(page.getByRole("alert")).toContainText("Localização bloqueada")
    await expect(page.getByRole("alert")).toContainText("busque por cidade ou endereço")

    // A tela continua útil: lista por nome (A→Z) e busca.
    const names = await cardNames(page)
    expect(names.length).toBeGreaterThan(5)
    expect(names[0]).toContain("Cotia")
    await expect(cards(page).first().locator("span[title='Distância em linha reta']")).toHaveCount(0)

    await page.getByRole("searchbox", { name: "Buscar por cidade ou endereço" }).fill("jundiai")
    await expect(cards(page)).toHaveCount(1)
    await expect(cards(page).first()).toContainText("Anhanguera")

    await page.getByRole("searchbox", { name: "Buscar por cidade ou endereço" }).fill("zzzz")
    await expect(page.getByText("Nada encontrado")).toBeVisible()

    // Sem posição: NENHUMA bounding box vai pro servidor.
    expect(siteRequests.length).toBeGreaterThan(0)
    for (const url of siteRequests) expect(url.searchParams.has("minLat")).toBe(false)
  })
})

test.describe("mapa (Leaflet) — lazy e sincronizado com a lista", () => {
  test.use({ geolocation: USER_POSITION, permissions: ["geolocation"] })

  test("mobile: Leaflet só é baixado ao abrir o modo Mapa; lista é o padrão", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const hosts = await stubTiles(context)
    const requested: string[] = []
    page.on("request", (req) => requested.push(req.url()))

    await loginAndGo(page, "/app")
    await page.getByRole("link", { name: "Mapa", exact: true }).click()
    await expect(page).toHaveURL(/\/app\/mapa$/)
    await expect(cards(page).first()).toBeVisible()
    expect(requested.filter((u) => /leaflet|StationsMap/i.test(u)), "Leaflet não pode carregar na lista nem na Home").toEqual([])

    await page.getByRole("button", { name: "Mapa", exact: true }).click()
    await expect(page.locator(".leaflet-container")).toBeVisible()
    await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible()
    expect(requested.some((u) => /leaflet|StationsMap/i.test(u))).toBe(true)

    await expect.poll(() => hosts.length).toBeGreaterThan(0)
    for (const host of hosts) expect(host).toBe("tile.openstreetmap.org") // default: um host só (o Carto exige chave)
    // Host(s) reais pedidos, pro ajuste do CSP (img-src):
    console.log("HOSTS DE TILES PEDIDOS:", [...new Set(hosts)].sort().join(", "))
  })

  test("desktop: mapa e lista lado a lado; tocar no marcador destaca o card e vice-versa", async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await stubTiles(context)
    await loginAndGo(page, "/app/mapa")

    const paulistaPin = page.locator('.leaflet-marker-icon[title^="Shopping Paulista"]')
    await expect(paulistaPin).toBeVisible()
    await expect(paulistaPin).toContainText("2") // livres no pino

    // marcador -> card
    await paulistaPin.click()
    await expect(page.locator('[data-station-id="st_paulista"]')).toHaveClass(/outline-primary/)

    // card -> marcador (e abre o detalhe)
    await page.locator('[data-station-id="st_pinheiros"]').getByRole("button", { name: /ver detalhes/ }).click()
    await expect(page.locator('.leaflet-marker-icon[title^="Estacionamento Pinheiros"] > div')).toHaveClass(/ring-primary/)
    await page.keyboard.press("Escape")

    // A bottom-nav e o sheet não ficam atrás do mapa (contexto de empilhamento do Leaflet contido).
    await expect(page.getByRole("navigation", { name: "Navegação do aplicativo" })).toBeVisible()
  })
})

for (const width of [320, 390]) {
  test(`bottom-nav com 5 abas em ${width}px: alvos ≥ 44px, sem overflow horizontal`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 })
    await loginAndGo(page, "/app")
    const links = page.getByRole("navigation", { name: "Navegação do aplicativo" }).getByRole("link")
    await expect(links).toHaveCount(5)
    await expect(links.nth(1)).toHaveText("Mapa")
    for (const link of await links.all()) {
      const box = await link.boundingBox()
      expect(box!.width).toBeGreaterThanOrEqual(44)
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    await page.getByRole("link", { name: "Mapa", exact: true }).click()
    await expect(page.getByRole("searchbox")).toBeVisible()
    const overflowMapa = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflowMapa).toBeLessThanOrEqual(0)
  })
}
