import { expect, test } from "@playwright/test"
// @ts-expect-error pngjs (dependência transitiva do `qrcode`) não traz tipos; só usamos PNG.sync.read
import { PNG } from "pngjs"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PASTA_AUTH, PERSONAS } from "./constantes"
import { aguardarEstavel, prepararPagina } from "./estabilizar"
import { ROTAS } from "./rotas"

/**
 * Critérios de ACEITE do REDESENHO da F-D (Admin), medidos no navegador — independentes dos E2E da Lyra. Mesma régua de `criterios-fb`/`criterios-fc`, com a lista de telas DERIVADA de
 * `rotas.ts` (toda rota `adm-*`): rota nova do Admin entra aqui sozinha. Rodar: `npx playwright test --config playwright.visual.config.ts criterios-fd`
 * (cada viewport = um projeto). Grava `e2e-visual/.resultados/fd/<vp>__<tela>__*.json`.
 *
 *  A) D1 moldura escura (sidebar `.surface-dark`, a partir de lg) + miolo claro; D2 NO MÁXIMO UM CTA lima por tela (exatamente um nas listas com "Novo ..."); exatamente UM h1 e NENHUM
 *     heading no cabeçalho do shell (a Nova achou o título repetido header x PageHeader); sem rolagem horizontal da PÁGINA (a da tabela fica contida no card); tabelas legíveis (cabeçalho
 *     >= 11 px, linha >= 36 px, fonte do corpo >= 13 px, rolagem horizontal no próprio card); sem `animate-` fora da lista permitida.
 *  B) Teclado: percorre os primeiros 40 Tab e prova que cada focável MUDA de aparência ao receber foco (contraste >= 3:1 entre o pixel com e sem foco).
 *  C) Diálogo (Novo site): véu sem desfoque, raio de diálogo, botão de salvar em petróleo (nenhum lima dentro do diálogo), foco entra no diálogo e Esc devolve ao botão que o abriu.
 */

const TELAS = ROTAS.filter((r) => r.id.startsWith("adm-")) as Array<(typeof ROTAS)[number]>

const LIMA = "rgb(97, 219, 36)"
const PASTA = "e2e-visual/.resultados/fd"
/** Listas com ação principal "Novo ..." (D2: o CTA lima da tela). */
const COM_CTA_LIMA = new Set(["adm-sites", "adm-charge-points", "adm-connectors", "adm-tariffs", "adm-auth-tokens"])

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

test.describe("Admin", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.admin.arquivo}.json`) })

  test.describe("A) D1/D2, um h1, sem título duplicado, tabelas legíveis", () => {
    for (const tela of TELAS) {
      test(`${tela.id}`, async ({ page }, info) => {
        await prepararPagina(page)
        await page.goto(tela.path, { waitUntil: "load" })
        await aguardarEstavel(page, tela.pronto)
        const vp = info.project.name
        const vw = page.viewportSize()!.width

        const png = PNG.sync.read(await page.screenshot({ animations: "disabled" }))
        let claros = 0
        let total = 0
        for (let y = 0; y < png.height; y += 4)
          for (let x = 0; x < png.width; x += 4) {
            const o = (y * png.width + x) * 4
            total++
            if (lum(png.data[o], png.data[o + 1], png.data[o + 2]) > 0.6) claros++
          }

        const m = await page.evaluate((limaCss) => {
          const visivel = (el: Element) => {
            const r = el.getBoundingClientRect()
            const cs = getComputedStyle(el)
            return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0
          }
          const ctasLima = [...document.querySelectorAll("a,button")]
            .filter((e) => visivel(e) && getComputedStyle(e).backgroundColor === limaCss)
            .map((e) => (e.textContent ?? "").trim() || (e.getAttribute("aria-label") ?? ""))
          const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
            .filter(visivel)
            .map((h) => ({ nivel: h.tagName, texto: (h.textContent ?? "").trim(), noHeader: !!h.closest("header") && !h.closest("main") }))
          const h1 = headings.filter((h) => h.nivel === "H1").map((h) => h.texto)
          const duplicados = headings.filter((h, i) => headings.findIndex((o) => o.texto === h.texto) !== i).map((h) => h.texto)
          const main = document.querySelector("main")
          const tabelas = [...document.querySelectorAll("table")]
            .filter((t) => visivel(t) && !t.classList.contains("sr-only") && !t.closest(".sr-only"))
            .map((t) => {
              const wrap = t.parentElement as HTMLElement
              const th = t.querySelector("th")
              const td = t.querySelector("tbody td")
              const linhas = [...t.querySelectorAll("tbody tr")].slice(0, 12)
              return {
                colunas: t.querySelectorAll("thead th").length,
                thPx: th ? parseFloat(getComputedStyle(th).fontSize) : null,
                tdPx: td ? parseFloat(getComputedStyle(td).fontSize) : null,
                menorLinha: linhas.length ? Math.min(...linhas.map((r) => r.getBoundingClientRect().height)) : null,
                envoltorioRola: getComputedStyle(wrap).overflowX === "auto" || getComputedStyle(wrap).overflowX === "scroll",
                envoltorioDentro: wrap.getBoundingClientRect().right <= window.innerWidth + 1,
              }
            })
          return {
            ctasLima,
            headings,
            h1,
            duplicados,
            headingNoHeader: headings.filter((h) => h.noHeader).map((h) => h.texto),
            surfaceDark: document.querySelectorAll(".surface-dark").length,
            sobraPagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            sobraMain: main ? main.scrollWidth - main.clientWidth : 0,
            tabelas,
            textoOperadorNaTela: false,
          }
        }, LIMA)

        gravar(`${vp}__${tela.id}__criterios`, { tela: tela.id, viewport: vp, fracaoClara: +(claros / total).toFixed(3), ...m })

        expect(m.sobraPagina, `rolagem horizontal da PÁGINA em ${tela.id} a ${vp}px`).toBe(0)
        expect(m.sobraMain, `rolagem horizontal do miolo em ${tela.id} a ${vp}px (a da tabela fica contida no card)`).toBeLessThanOrEqual(1)
        expect(m.h1.length, `exatamente um h1 em ${tela.id}: ${m.h1.join(" | ")}`).toBe(1)
        expect(m.headingNoHeader, `heading dentro do <header> do shell em ${tela.id} (título repetido)`).toEqual([])
        expect(m.duplicados, `headings com texto repetido em ${tela.id}`).toEqual([])
        if (vw >= 1024) expect(m.surfaceDark, `moldura escura (sidebar .surface-dark) em ${tela.id}`).toBeGreaterThanOrEqual(1)
        expect(claros / total, `miolo claro em ${tela.id} a ${vp}px`).toBeGreaterThan(0.25)
        expect(m.ctasLima.length, `mais de um CTA lima em ${tela.id}: ${m.ctasLima.join(" | ")}`).toBeLessThanOrEqual(1)
        if (COM_CTA_LIMA.has(tela.id)) expect(m.ctasLima.length, `CTA lima em ${tela.id}`).toBe(1)
        for (const [i, t] of m.tabelas.entries()) {
          expect(t.thPx, `cabeçalho de tabela ${i} legível em ${tela.id}`).toBeGreaterThanOrEqual(11)
          expect(t.tdPx, `corpo de tabela ${i} legível em ${tela.id}`).toBeGreaterThanOrEqual(13)
          if (t.menorLinha !== null) expect(t.menorLinha, `linha de tabela ${i} baixa demais em ${tela.id}`).toBeGreaterThanOrEqual(36)
          expect(t.envoltorioRola, `tabela ${i} sem rolagem horizontal no próprio card em ${tela.id}`).toBe(true)
          expect(t.envoltorioDentro, `tabela ${i} vazando da janela em ${tela.id}`).toBe(true)
        }
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
            return {
              id,
              tag: a.tagName.toLowerCase(),
              nome: a.getAttribute("aria-label") || (a.textContent ?? "").trim().slice(0, 40) || a.getAttribute("name") || a.getAttribute("type") || "",
              x: r.x,
              y: r.y,
              w: r.width,
              h: r.height,
              yDoc: r.y + window.scrollY,
            }
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
          const clip = {
            x: Math.max(0, Math.floor(el.x - M)),
            y: Math.max(0, Math.floor(el.y - M)),
            width: Math.ceil(el.w + 2 * M),
            height: Math.ceil(el.h + 2 * M),
          }
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
              return (
                `${e.tagName}|${e.getAttribute("href") ?? ""}|${e.getAttribute("name") ?? ""}|${(e.textContent ?? "").trim().slice(0, 30)}|${Math.round(r.x)},${Math.round(r.y + window.scrollY)}` ===
                id
              )
            })
            cand?.focus({ preventScroll: true })
          }, el.id)
          let mudou = 0
          let cMax = 1
          for (let k = 0; k < comFoco.data.length; k += 4) {
            const dr =
              Math.abs(comFoco.data[k] - semFoco.data[k]) +
              Math.abs(comFoco.data[k + 1] - semFoco.data[k + 1]) +
              Math.abs(comFoco.data[k + 2] - semFoco.data[k + 2])
            if (dr > 24) {
              mudou++
              const c = contraste(
                lum(comFoco.data[k], comFoco.data[k + 1], comFoco.data[k + 2]),
                lum(semFoco.data[k], semFoco.data[k + 1], semFoco.data[k + 2]),
              )
              if (c > cMax) cMax = c
            }
          }
          passos.push({
            tag: el.tag,
            nome: el.nome,
            x: Math.round(el.x),
            y: Math.round(el.y),
            yDoc: Math.round(el.yDoc),
            w: Math.round(el.w),
            h: Math.round(el.h),
            mudou,
            contrasteMax: +cMax.toFixed(2),
          })
        }
        gravar(`${info.project.name}__${tela.id}__teclado`, { tela: tela.id, viewport: info.project.name, ciclou, focaveis: passos.length, passos })

        expect(passos.length, `nenhum elemento focável por Tab em ${tela.id}`).toBeGreaterThan(0)
        const sem = passos.filter((p) => p.mudou >= 0 && (p.mudou === 0 || p.contrasteMax < 3))
        expect(sem, `elementos sem indicador de foco visível (mudança de pixels com contraste >= 3:1) em ${tela.id}`).toEqual([])
      })
    }
  })

  test.describe("C) diálogo de formulário", () => {
    test("Novo site: véu sem desfoque, raio de diálogo, salvar em petróleo (nenhum lima), foco entra e Esc devolve", async ({ page }) => {
      await prepararPagina(page)
      await page.goto("/admin/sites", { waitUntil: "load" })
      await aguardarEstavel(page)
      const abrir = page.getByRole("button", { name: "Novo site" }).first()
      await abrir.click()
      const dialog = page.getByRole("dialog")
      await expect(dialog).toBeVisible()
      const m = await page.evaluate((limaCss) => {
        const d = document.querySelector('[role="dialog"]') as HTMLElement
        const scrim = document.querySelector(".dialog-scrim") as HTMLElement
        const botoes = [...d.querySelectorAll("button")]
        const salvar = botoes.find((b) => /criar site|salvar/i.test(b.textContent ?? ""))
        return {
          scrimFiltro: getComputedStyle(scrim).backdropFilter,
          raio: getComputedStyle(d).borderTopLeftRadius,
          limaNoDialogo: botoes.filter((b) => getComputedStyle(b).backgroundColor === limaCss).length,
          salvarBg: salvar ? getComputedStyle(salvar).backgroundColor : null,
          focoDentro: d.contains(document.activeElement),
          campos: [...d.querySelectorAll("input")].map((i) => getComputedStyle(i).borderTopLeftRadius),
        }
      }, LIMA)
      expect(m.scrimFiltro).toBe("none")
      expect(m.raio).toBe("24px")
      expect(m.limaNoDialogo).toBe(0)
      expect(m.salvarBg).toBe("rgb(41, 105, 142)")
      expect(m.focoDentro).toBe(true)
      expect(new Set(m.campos)).toEqual(new Set(["14px"]))
      await page.keyboard.press("Escape")
      await expect(dialog).toBeHidden()
      await expect(abrir).toBeFocused()
    })
  })
})
