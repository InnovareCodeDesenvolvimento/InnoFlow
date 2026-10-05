import { expect, test } from "@playwright/test"
// @ts-expect-error pngjs (dependência transitiva do `qrcode`) não traz tipos; só usamos PNG.sync.read
import { PNG } from "pngjs"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * Critérios de ACEITE de um REDESENHO deliberado (F-B: Auth + Público), medidos no navegador — independentes dos E2E da Lyra (`e2e/design-system-fb.spec.ts`).
 * Rodar: `npx playwright test --config playwright.visual.config.ts criterios-fb` (cada viewport = um projeto). Grava `e2e-visual/.resultados/fb/<vp>__<tela>.json`.
 *
 *  A) D1 moldura escura + miolo claro (amostragem de PIXEL da captura), D2 CTA lima, D3 mascote presente, D4 sem texto de operador, sem rolagem horizontal.
 *  B) Teclado: percorre TODO o Tab da tela e prova que cada elemento focável MUDA de aparência ao receber foco, com contraste >= 3:1 entre o pixel com e sem foco (WCAG 1.4.11/2.4.7),
 *     que o foco não prende (cicla) e que a ordem de Tab segue a ordem visual de cima para baixo (sem saltos grandes para trás).
 *  C) CLS de /eletropostos <= 0,02 em 3 cargas.
 *  D) Fluxos: error boundary, QR -> login -> cadastro -> volta ao QR (?redirect=), redirect aberto recusado, Google (mock).
 */

const TELAS = [
  { id: "auth-login", path: "/login", operador: false },
  { id: "auth-cadastro", path: "/cadastro", operador: false },
  { id: "pub-eletropostos", path: "/eletropostos", operador: true },
  { id: "pub-qr-carregador", path: "/c/CP-VILA-NORTE-01", operador: true },
  { id: "pub-qr-conector", path: "/c/CP-VILA-NORTE-01/1", operador: true },
  { id: "pub-rota-inexistente", path: "/nao-existe-xyz", operador: false },
] as const

const LIMA = "rgb(97, 219, 36)"
const PASTA = "e2e-visual/.resultados/fb"

function lum(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contraste = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)

function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}

test.describe("A) D1/D2/D3/D4 e rolagem horizontal", () => {
  for (const tela of TELAS) {
    test(`${tela.id}`, async ({ page }, info) => {
      await prepararPagina(page)
      await page.goto(tela.path, { waitUntil: "load" })
      await aguardarEstavel(page)
      const vp = info.project.name

      const png = PNG.sync.read(await page.screenshot({ fullPage: true, animations: "disabled" }))
      let escuros = 0
      let claros = 0
      let total = 0
      for (let y = 0; y < png.height; y += 4)
        for (let x = 0; x < png.width; x += 4) {
          const o = (y * png.width + x) * 4
          const L = lum(png.data[o], png.data[o + 1], png.data[o + 2])
          total++
          if (L < 0.15) escuros++
          else if (L > 0.6) claros++
        }

      const m = await page.evaluate((limaCss) => {
        const visivel = (el: Element) => {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0
        }
        const ctasLima = [...document.querySelectorAll("a,button")].filter((e) => visivel(e) && getComputedStyle(e).backgroundColor === limaCss).map((e) => (e.textContent ?? "").trim() || (e.getAttribute("aria-label") ?? ""))
        const mascotes = [...document.querySelectorAll("img")].filter((i) => visivel(i) && /mascote/i.test(i.currentSrc || i.src) ).length
        const mascotesInline = [...document.querySelectorAll("img")].filter((i) => visivel(i) && (i.currentSrc || i.src).startsWith("data:image/webp")).length
        const texto = document.body.innerText
        const estourados = [...document.querySelectorAll("body *")]
          .filter((e) => visivel(e) && e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest("[aria-hidden='true']"))
          .slice(0, 5)
          .map((e) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).slice(0, 40)} right=${Math.round(e.getBoundingClientRect().right)}`)
        return {
          ctasLima,
          mascotes,
          mascotesInline,
          surfaceDark: document.querySelectorAll(".surface-dark").length,
          sobraHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          viewportLargura: window.innerWidth,
          estourados,
          textoOperador: (texto.match(/painel administrativo|multi-?operador|operadores|administrativ[oa]/gi) ?? []).slice(0, 5),
          mencionaOperador: /operador/i.test(texto),
          h1: [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").trim()),
        }
      }, LIMA)

      const resultado = { tela: tela.id, viewport: vp, fracaoEscura: +(escuros / total).toFixed(3), fracaoClara: +(claros / total).toFixed(3), ...m }
      gravar(`${vp}__${tela.id}__criterios`, resultado)

      expect(m.sobraHorizontal, `rolagem horizontal em ${tela.id} a ${vp}px`).toBe(0)
      expect(m.estourados, `elementos além da borda direita em ${tela.id} a ${vp}px`).toEqual([])
      // /c/<id> sem conector é o SELETOR de conector (nenhuma ação a executar ainda): sem CTA lima é correto; o CTA aparece ao escolher o conector.
      if (tela.id !== "pub-qr-carregador") expect(m.ctasLima.length, `CTA lima em ${tela.id} a ${vp}px`).toBeGreaterThanOrEqual(1)
      expect(m.surfaceDark, `moldura escura (.surface-dark) em ${tela.id}`).toBeGreaterThanOrEqual(1)
      expect(resultado.fracaoEscura, `moldura escura visível em ${tela.id} a ${vp}px`).toBeGreaterThan(0.05)
      if (tela.id !== "pub-rota-inexistente") expect(resultado.fracaoClara, `miolo claro em ${tela.id} a ${vp}px`).toBeGreaterThan(0.1)
      expect(m.textoOperador, `texto de operador/painel administrativo em ${tela.id}`).toEqual([])
      // D3 (§3.9): mascote em auth, QR e 404/erro. A lista pública de eletropostos NÃO está na tabela do D3 (registrado, não exigido).
      if (tela.id !== "pub-eletropostos") expect(m.mascotes + m.mascotesInline, `mascote em ${tela.id} a ${vp}px`).toBeGreaterThanOrEqual(1)
    })
  }
})

test.describe("B) teclado e foco", () => {
  for (const tela of TELAS) {
    test(`${tela.id}`, async ({ page }, info) => {
      await prepararPagina(page)
      await page.goto(tela.path, { waitUntil: "load" })
      await aguardarEstavel(page)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)

      type Passo = { tag: string; nome: string; x: number; y: number; yDoc: number; w: number; h: number; mudou: number; contrasteMax: number }
      const passos: Passo[] = []
      const vistos = new Set<string>()
      let ciclou = false
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab")
        const el = await page.evaluate(() => {
          const a = document.activeElement as HTMLElement | null
          if (!a || a === document.body) return null
          const r = a.getBoundingClientRect()
          const id = `${a.tagName}|${a.getAttribute("href") ?? ""}|${a.getAttribute("name") ?? ""}|${(a.textContent ?? "").trim().slice(0, 30)}|${Math.round(r.x)},${Math.round(r.y + window.scrollY)}`
          return { id, tag: a.tagName.toLowerCase(), nome: a.getAttribute("aria-label") || (a.textContent ?? "").trim().slice(0, 40) || a.getAttribute("name") || a.getAttribute("type") || "", x: r.x, y: r.y, w: r.width, h: r.height, yDoc: r.y + window.scrollY }
        })
        if (!el) {
          ciclou = true
          break
        }
        if (vistos.has(el.id)) {
          ciclou = true
          break
        }
        vistos.add(el.id)
        const M = 8
        const clip = { x: Math.max(0, Math.floor(el.x - M)), y: Math.max(0, Math.floor(el.y - M)), width: Math.ceil(el.w + 2 * M), height: Math.ceil(el.h + 2 * M) }
        const vpw = page.viewportSize()!.width
        const vph = page.viewportSize()!.height
        clip.width = Math.min(clip.width, vpw - clip.x)
        clip.height = Math.min(clip.height, vph - clip.y)
        if (clip.width <= 0 || clip.height <= 0 || el.y < 0 || el.y > vph) {
          passos.push({ tag: el.tag, nome: el.nome, x: el.x, y: el.y, yDoc: el.yDoc, w: el.w, h: el.h, mudou: -1, contrasteMax: -1 })
          continue
        }
        const comFoco = PNG.sync.read(await page.screenshot({ clip, animations: "disabled" }))
        await page.evaluate(() => (document.activeElement as HTMLElement).blur())
        const semFoco = PNG.sync.read(await page.screenshot({ clip, animations: "disabled" }))
        // devolve o foco ao MESMO elemento (o blur zerou o ponto de partida do Tab; refocalizar por script mantém o :focus-visible, pois a última interação foi o teclado)
        await page.evaluate((id) => {
          const cand = [...document.querySelectorAll<HTMLElement>("a,button,input,select,textarea,[tabindex]")].find((e) => {
            const r = e.getBoundingClientRect()
            return `${e.tagName}|${e.getAttribute("href") ?? ""}|${e.getAttribute("name") ?? ""}|${(e.textContent ?? "").trim().slice(0, 30)}|${Math.round(r.x)},${Math.round(r.y + window.scrollY)}` === id
          })
          cand?.focus({ preventScroll: true })
        }, el.id)
        let mudou = 0
        let cMax = 1
        for (let k = 0; k < comFoco.data.length; k += 4) {
          const dr = Math.abs(comFoco.data[k] - semFoco.data[k]) + Math.abs(comFoco.data[k + 1] - semFoco.data[k + 1]) + Math.abs(comFoco.data[k + 2] - semFoco.data[k + 2])
          if (dr > 24) {
            mudou++
            const c = contraste(lum(comFoco.data[k], comFoco.data[k + 1], comFoco.data[k + 2]), lum(semFoco.data[k], semFoco.data[k + 1], semFoco.data[k + 2]))
            if (c > cMax) cMax = c
          }
        }
        passos.push({ tag: el.tag, nome: el.nome, x: Math.round(el.x), y: Math.round(el.y), yDoc: Math.round(el.yDoc), w: Math.round(el.w), h: Math.round(el.h), mudou, contrasteMax: +cMax.toFixed(2) })
      }
      gravar(`${info.project.name}__${tela.id}__teclado`, { tela: tela.id, viewport: info.project.name, ciclou, focaveis: passos.length, passos })

      expect(passos.length, `nenhum elemento focável por Tab em ${tela.id}`).toBeGreaterThan(0)
      expect(ciclou, `o foco não prendeu nem passou de 40 Tabs em ${tela.id}`).toBe(true)
      const sem = passos.filter((p) => p.mudou >= 0 && (p.mudou === 0 || p.contrasteMax < 3))
      expect(sem, `elementos sem indicador de foco visível (mudança de pixels com contraste >= 3:1) em ${tela.id}`).toEqual([])
      // ordem: nenhum Tab pode saltar mais de uma "tela" para cima (ordem visual quebrada)
      const saltosParaCima = passos.filter((p, i) => i > 0 && p.yDoc < passos[i - 1].yDoc - 300)
      expect(saltosParaCima, `ordem de Tab voltando muito para cima em ${tela.id}`).toEqual([])
    })
  }
})

test.describe("C) CLS de /eletropostos", () => {
  test("3 cargas, deslocamento acumulado <= 0,02", async ({ page }, info) => {
    const valores: number[] = []
    for (let i = 0; i < 3; i++) {
      await page.addInitScript(() => {
        const w = window as unknown as { __cls: number }
        w.__cls = 0
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value
        }).observe({ type: "layout-shift", buffered: true })
      })
      await page.goto("/eletropostos", { waitUntil: "load" })
      await expect(page.getByRole("heading", { level: 1, name: "Eletropostos" })).toBeVisible()
      await expect(page.locator("[data-station-id]").first()).toBeVisible()
      await page.waitForTimeout(1500)
      valores.push(await page.evaluate(() => (window as unknown as { __cls: number }).__cls))
    }
    gravar(`${info.project.name}__cls-eletropostos`, { valores })
    for (const v of valores) expect(v).toBeLessThanOrEqual(0.02)
  })
})

test.describe("D) fluxos", () => {
  test("RouteError: boundary de marca, 'Tentar de novo', e sair limpa o erro", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mock:sites-malformed", "1"))
    await page.goto("/eletropostos")
    const alerta = page.getByRole("alert")
    await expect(alerta).toContainText("Não foi possível abrir esta tela")
    await expect(page.getByRole("button", { name: "Tentar de novo" })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    // a tela de erro NÃO é uma página em branco nem mostra a pilha/mensagem técnica
    const corpo = await page.locator("body").innerText()
    // (a mensagem técnica do erro aparece só em DEV, `import.meta.env.DEV` em RouteErrorView; pilha e caminhos de arquivo nunca)
    expect(corpo).not.toMatch(/node_modules|\.tsx|\n\s+at /i)
    await page.evaluate(() => localStorage.removeItem("mock:sites-malformed"))
    await page.getByRole("link", { name: "Voltar ao início" }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test("QR anônimo -> login -> cadastro preserva ?redirect e, criada a conta, volta ao carregador", async ({ page }) => {
    const QR = "/c/CP-VILA-NORTE-01/1"
    await page.goto(QR)
    await page.getByRole("link", { name: "Entrar para carregar" }).click()
    await expect(page).toHaveURL(new RegExp(`/login\\?redirect=${encodeURIComponent(QR).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
    await page.getByRole("link", { name: "Cadastre-se" }).click()
    await expect(page).toHaveURL(new RegExp(`/cadastro\\?redirect=${encodeURIComponent(QR).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
    const email = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`
    await page.getByLabel("Nome").fill("Motorista FB")
    await page.getByLabel("E-mail").fill(email)
    await page.getByLabel("Senha").fill("senha1234")
    await page.getByRole("button", { name: "Criar conta" }).click()
    await expect(page).toHaveURL(new RegExp(`${QR.replace(/\//g, "\\/")}$`))
    await expect(page.getByRole("button", { name: "Iniciar recarga" })).toBeVisible()
  })

  test("login com ?redirect volta ao carregador; redirect aberto (//host e https://host) é recusado e cai em /app", async ({ page }) => {
    const QR = "/c/CP-VILA-NORTE-01/1"
    await page.goto(`/login?redirect=${encodeURIComponent(QR)}`)
    await page.getByLabel("E-mail").fill("motorista@innoelektron.com")
    await page.getByLabel("Senha").fill("senha1234")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page).toHaveURL(new RegExp(`${QR.replace(/\//g, "\\/")}$`))

    for (const malvado of ["//evil.example/x", "https://evil.example/x", "javascript:alert(1)"]) {
      await page.evaluate(() => localStorage.clear())
      await page.goto(`/login?redirect=${encodeURIComponent(malvado)}`)
      await page.getByLabel("E-mail").fill("motorista@innoelektron.com")
      await page.getByLabel("Senha").fill("senha1234")
      await page.getByRole("button", { name: "Entrar" }).click()
      await expect(page, `redirect ${malvado}`).toHaveURL(/localhost:\d+\/app/)
      expect(new URL(page.url()).hostname).toBe("localhost")
    }
  })

  // Era `test.fail` (achado da Íris: `safeRedirect` só recusava "//"; com "/\evil.example" o navegador lê "\\" como "/" e o app navegava para `/evil.example`, mesma origem, 404).
  // Corrigido na F-C: `lib/authRedirect.ts` recusa "\\" e caracteres de controle/TAB/LF/CR; o `?redirect` hostil é ignorado e cai em /app.
  test("redirect com barra invertida ou caractere de controle é ignorado (cai em /app)", async ({ page }) => {
    await page.goto(`/login?redirect=${encodeURIComponent("/\\evil.example")}`)
    await page.getByLabel("E-mail").fill("motorista@innoelektron.com")
    await page.getByLabel("Senha").fill("senha1234")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page).toHaveURL(/localhost:\d+\/app/, { timeout: 4000 })
  })

  test("Google (mock): em /login e em /cadastro entra e respeita o ?redirect", async ({ page }) => {
    const QR = "/c/CP-VILA-NORTE-01/1"
    for (const rota of ["/login", "/cadastro"]) {
      await page.evaluate(() => localStorage.clear()).catch(() => undefined)
      await page.goto(`${rota}?redirect=${encodeURIComponent(QR)}`)
      await page.getByRole("button", { name: /Continuar com o Google/ }).click()
      await expect(page, rota).toHaveURL(new RegExp(`${QR.replace(/\//g, "\\/")}$`))
    }
  })
})
