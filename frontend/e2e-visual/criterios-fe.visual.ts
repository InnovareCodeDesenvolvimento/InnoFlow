import { expect, test, type Page } from "@playwright/test"
// @ts-expect-error pngjs (dependência transitiva do `qrcode`) não traz tipos; só usamos PNG.sync.read
import { PNG } from "pngjs"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PASTA_AUTH, PERSONAS } from "./constantes"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * Critérios de ACEITE do REDESENHO da F-E (documento isolado do cartão, `pagamento-cartao.html`), medidos no navegador. Rodar:
 * `npx playwright test --config playwright.visual.config.ts criterios-fe` (cada viewport = um projeto). Grava `e2e-visual/.resultados/fe/*.json`.
 *
 *  A) ISOLAMENTO (SAQ A-EP) — o que o redesenho NÃO pode mudar: nenhuma requisição a outra origem (só 'self' e `data:`), os 4 campos que o script da Cielo lê continuam com as
 *     classes `bp-sop-*`, e nenhum CSS/JS do app principal (o único `<link rel=stylesheet>` e o único `<script>` são do próprio bundle `pagamento-cartao-*`).
 *  B) Visual — D1 moldura escura + miolo claro (amostragem de pixel), D2 UM CTA lima por estado, D3 mascote nos estados de espera/erro/sucesso, 1 h1, fonte do sistema,
 *     campos com raio de controle (14 px), sem rolagem horizontal a 375/768/1440.
 *  C) Teclado — percorre o Tab do formulário e prova que cada focável MUDA de aparência ao receber foco (contraste >= 3:1 entre o pixel com e sem foco).
 */

const LIMA = "rgb(97, 219, 36)"
const PASTA = "e2e-visual/.resultados/fe"

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

/** Abre a aba isolada PELO APP (handshake completo) e devolve a aba do formulário. */
async function abrirFormulario(page: Page): Promise<Page> {
  await prepararPagina(page)
  await page.goto("/app/carteira/cartoes", { waitUntil: "load" })
  await aguardarEstavel(page)
  const [popup] = await Promise.all([page.context().waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).first().click()])
  await popup.waitForLoadState("load")
  await expect(popup.getByRole("heading", { name: "Cadastrar cartão" })).toBeVisible()
  return popup
}

async function medirVisual(p: Page, estado: string, vp: string) {
  const png = PNG.sync.read(await p.screenshot({ fullPage: true, animations: "disabled" }))
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
  const m = await p.evaluate((limaCss) => {
    const visivel = (el: Element) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"
    }
    const botoes = [...document.querySelectorAll("button")].filter(visivel)
    const input = document.querySelector("input:not([type=hidden])") as HTMLElement | null
    return {
      h1: [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").trim()),
      ctasLima: botoes.filter((b) => getComputedStyle(b).backgroundColor === limaCss).map((b) => (b.textContent ?? "").trim()),
      imagens: [...document.querySelectorAll("img")].filter(visivel).map((i) => (i.currentSrc || i.src).slice(0, 20)),
      sobraHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      fonte: getComputedStyle(document.body).fontFamily,
      raioCampo: input ? getComputedStyle(input).borderTopLeftRadius : null,
      banda: !!document.querySelector(".pc-band"),
    }
  }, LIMA)
  gravar(`${vp}__${estado}`, { estado, viewport: vp, fracaoEscura: +(escuros / total).toFixed(3), fracaoClara: +(claros / total).toFixed(3), ...m })
  expect(m.h1.length, `exatamente um h1 em ${estado}`).toBe(1)
  expect(m.sobraHorizontal, `rolagem horizontal em ${estado} a ${vp}px`).toBe(0)
  expect(m.banda, `moldura escura de marca em ${estado}`).toBe(true)
  expect(escuros / total, `moldura escura visível em ${estado} a ${vp}px`).toBeGreaterThan(0.03)
  expect(claros / total, `miolo claro em ${estado} a ${vp}px`).toBeGreaterThan(0.3)
  expect(m.fonte, "fonte do sistema (sem webfont)").not.toMatch(/Inter/i)
  return m
}

test.describe("A) isolamento do documento (SAQ A-EP)", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.driver.arquivo}.json`) })

  test("só requisições da mesma origem ou data:, bundle próprio e as 4 classes bp-sop-* intactas", async ({ page }, info) => {
    const popupUrls: string[] = []
    page.context().on("page", (pop) => pop.on("request", (r) => popupUrls.push(r.url())))
    const popup = await abrirFormulario(page)
    await popup.waitForLoadState("networkidle")
    const origem = new URL(popup.url()).origin
    const externas = popupUrls.filter((u) => !u.startsWith(origem) && !u.startsWith("data:") && !u.startsWith("blob:"))
    expect(externas, "requisição a outra origem a partir do documento isolado").toEqual([])

    const dom = await popup.evaluate(() => ({
      folhas: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href")),
      scripts: [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")),
      sop: ["bp-sop-cardnumber", "bp-sop-cardholdername", "bp-sop-cardexpirationdate", "bp-sop-cardcvv", "bp-sop-cardcvvc"].map(
        (c) => document.querySelectorAll("." + c).length,
      ),
      estilosInline: document.querySelectorAll("style").length,
    }))
    gravar(`${info.project.name}__isolamento`, { externas, ...dom, requisicoes: popupUrls.length })
    // Em dev o Vite injeta o CSS como <style>/módulos; no build (preview) é um <link> do próprio bundle. Nos dois casos NADA de `index-*`/`landing*`/`ui-kit*`.
    for (const href of [...dom.folhas, ...dom.scripts])
      expect(href ?? "", "recurso estranho ao bundle isolado").not.toMatch(/index-|landing|ui-kit|vendor-|app-hooks/)
    expect(dom.sop, "campos lidos pelo script da Cielo (número, nome, validade, CVV, CVVc)").toEqual([1, 1, 1, 1, 1])
  })
})

test.describe("B) visual por estado", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.driver.arquivo}.json`) })

  test("sem opener (URL aberta direto): mascote, 1 h1 e sem CTA", async ({ page }, info) => {
    await prepararPagina(page)
    await page.goto("/pagamento-cartao.html", { waitUntil: "load" })
    await expect(page.getByRole("heading", { level: 1 })).toContainText("não pode ser aberta diretamente")
    const m = await medirVisual(page, "sem-opener", info.project.name)
    expect(m.imagens.some((s) => s.startsWith("data:image/webp"))).toBe(true) // mascote como data URI
    expect(m.ctasLima).toEqual([])
  })

  test("formulário: UM CTA lima ('Salvar cartão'), campos de 14 px, mascote só na moldura", async ({ page }, info) => {
    const popup = await abrirFormulario(page)
    const m = await medirVisual(popup, "formulario", info.project.name)
    expect(m.ctasLima).toEqual(["Salvar cartão"])
    expect(m.raioCampo).toBe("14px")
    expect(m.imagens.every((s) => s.startsWith("data:image/webp"))).toBe(true)
  })

  test("validado: mascote com check, UM CTA lima ('Fechar')", async ({ page }, info) => {
    const popup = await abrirFormulario(page)
    await popup.getByLabel("Número do cartão").fill("4111111111111111")
    await popup.getByLabel("Nome impresso no cartão").fill("CARLA MOTORISTA")
    await popup.getByLabel("Mês").fill("12")
    await popup.getByLabel("Ano").fill(String(new Date().getFullYear() + 3))
    await popup.getByLabel("CVV").fill("123")
    await popup.getByRole("button", { name: "Salvar cartão" }).click()
    await expect(popup.getByText("Cartão validado")).toBeVisible({ timeout: 8000 })
    const m = await medirVisual(popup, "validado", info.project.name)
    expect(m.ctasLima).toEqual(["Fechar"])
    await expect(popup.locator(".pc-hero-check")).toBeVisible()
  })
})

test.describe("C) teclado", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.driver.arquivo}.json`) })

  test("cada campo e o botão mudam de aparência ao receber foco (>= 3:1) e a ordem de Tab é a visual", async ({ page }, info) => {
    const popup = await abrirFormulario(page)
    await popup.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await popup.mouse.move(0, 0)
    type Passo = { nome: string; y: number; x: number; mudou: number; contrasteMax: number }
    const passos: Passo[] = []
    for (let i = 0; i < 7; i++) {
      await popup.keyboard.press("Tab")
      const el = await popup.evaluate(() => {
        const a = document.activeElement as HTMLElement | null
        if (!a || a === document.body) return null
        const r = a.getBoundingClientRect()
        return {
          sel: a.id ? `[id="${a.id}"]` : a.tagName.toLowerCase(),
          nome: a.getAttribute("aria-label") || (a.id ? document.querySelector(`label[for="${a.id}"]`)?.textContent : "") || (a.textContent ?? "").trim(),
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
        }
      })
      if (!el) break
      const M = 8
      const clip = {
        x: Math.max(0, Math.floor(el.x - M)),
        y: Math.max(0, Math.floor(el.y - M)),
        width: Math.ceil(el.w + 2 * M),
        height: Math.ceil(el.h + 2 * M),
      }
      const vpw = popup.viewportSize()!.width
      const vph = popup.viewportSize()!.height
      clip.width = Math.min(clip.width, vpw - clip.x)
      clip.height = Math.min(clip.height, vph - clip.y)
      if (clip.width <= 0 || clip.height <= 0) continue
      const comFoco = PNG.sync.read(await popup.screenshot({ clip, animations: "disabled" }))
      await popup.evaluate(() => (document.activeElement as HTMLElement).blur())
      const semFoco = PNG.sync.read(await popup.screenshot({ clip, animations: "disabled" }))
      await popup.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.focus(), el.sel) // devolve o foco ao MESMO elemento (a última interação foi o teclado: o :focus-visible se mantém)
      let mudou = 0
      let cMax = 1
      for (let k = 0; k < comFoco.data.length; k += 4) {
        const dr =
          Math.abs(comFoco.data[k] - semFoco.data[k]) +
          Math.abs(comFoco.data[k + 1] - semFoco.data[k + 1]) +
          Math.abs(comFoco.data[k + 2] - semFoco.data[k + 2])
        if (dr > 24) {
          mudou++
          cMax = Math.max(
            cMax,
            contraste(lum(comFoco.data[k], comFoco.data[k + 1], comFoco.data[k + 2]), lum(semFoco.data[k], semFoco.data[k + 1], semFoco.data[k + 2])),
          )
        }
      }
      passos.push({ nome: String(el.nome).slice(0, 30), y: Math.round(el.y), x: Math.round(el.x), mudou, contrasteMax: +cMax.toFixed(2) })
    }
    gravar(`${info.project.name}__teclado`, passos)
    expect(passos.length, "focáveis percorridos").toBeGreaterThanOrEqual(5)
    expect(
      passos.filter((p) => p.mudou === 0 || p.contrasteMax < 3),
      "sem indicador de foco visível",
    ).toEqual([])
    // ordem visual: de cima para baixo (a linha Mês/Ano/CVV é da esquerda para a direita)
    for (let i = 1; i < passos.length; i++) expect(passos[i].y >= passos[i - 1].y - 2, `Tab voltou para cima em ${passos[i].nome}`).toBe(true)
  })
})
