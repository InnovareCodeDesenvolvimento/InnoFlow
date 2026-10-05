import { expect, test } from "@playwright/test"
// @ts-expect-error pngjs (dependência transitiva do `qrcode`) não traz tipos; só usamos PNG.sync.read
import { PNG } from "pngjs"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PASTA_AUTH, PERSONAS } from "./constantes"
import { aguardarEstavel, prepararPagina } from "./estabilizar"
import { ROTAS } from "./rotas"

/**
 * Critérios de ACEITE do REDESENHO da F-C (PWA do motorista), medidos no navegador — independentes dos E2E da Lyra (`e2e/design-system-fc.spec.ts`). Mesma régua de
 * `criterios-fb.visual.ts`, com a lista de telas DERIVADA de `rotas.ts` (toda rota `pwa-*`, com a persona certa): rota nova do PWA entra aqui sozinha.
 * Rodar: `npx playwright test --config playwright.visual.config.ts criterios-fc` (cada viewport = um projeto). Grava `e2e-visual/.resultados/fc/<vp>__<tela>__*.json`.
 *
 *  A) D1 moldura escura (cabeçalho + navegação = `.surface-dark`) + miolo claro, D2 NO MÁXIMO UM CTA lima por tela, D3 mascote nos vazios de primeiro uso, D4 sem texto de operador,
 *     sem rolagem horizontal, e a navegação inteira DENTRO da janela (o que `test:visual` não vê quando algo sai da tela): 5 destinos, alvo >= 44 px, trilho >= lg.
 *  B) Teclado: percorre o Tab da tela e prova que cada focável MUDA de aparência ao receber foco (contraste >= 3:1 entre o pixel com e sem foco), que o foco cicla e que a ordem de
 *     Tab não volta mais de uma "tela" para cima.
 */

const TELAS = ROTAS.filter((r) => r.id.startsWith("pwa-")) as Array<(typeof ROTAS)[number]>

const LIMA = "rgb(97, 219, 36)"
const THEME = "rgb(14, 42, 58)"
const PASTA = "e2e-visual/.resultados/fc"
/** Telas com vazio de primeiro uso (D3 §3.9): o mascote de 64 px acompanha. */
const COM_MASCOTE = new Set(["pwa-inicio", "pwa-sessao-vazia", "pwa-historico-vazio", "pwa-cartoes"])
/** Telas cuja ação principal é um CTA lima (as demais — sessão travada, recibos — não têm CTA além do destrutivo/links). */
const COM_CTA_LIMA = new Set(["pwa-inicio", "pwa-mapa", "pwa-carteira", "pwa-carteira-adicionar", "pwa-cartoes"])

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

for (const persona of ["driver", "travado"] as const) {
  test.describe(`PWA — ${persona}`, () => {
    test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS[persona].arquivo}.json`) })
    const telas = TELAS.filter((t) => t.persona === persona)

    test.describe("A) D1/D2/D3/D4, rolagem horizontal e navegação dentro da janela", () => {
      for (const tela of telas) {
        test(`${tela.id}`, async ({ page }, info) => {
          await prepararPagina(page)
          await page.goto(tela.path, { waitUntil: "load" })
          await aguardarEstavel(page, tela.pronto)
          const vp = info.project.name
          const vw = page.viewportSize()!.width
          const vh = page.viewportSize()!.height

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
            const mascotes = [...document.querySelectorAll("img")].filter((i) => visivel(i) && (/mascote/i.test(i.currentSrc || i.src) || (i.currentSrc || i.src).startsWith("data:image/webp"))).length
            const nav = document.querySelector('nav[aria-label="Navegação do aplicativo"]')
            const links = nav ? [...nav.querySelectorAll("a")].map((a) => a.getBoundingClientRect()) : []
            const header = document.querySelector("header")
            const estourados = [...document.querySelectorAll("body *")]
              .filter((e) => visivel(e) && e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest("[aria-hidden='true']") && !e.closest(".leaflet-container"))
              .slice(0, 5)
              .map((e) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).slice(0, 40)} right=${Math.round(e.getBoundingClientRect().right)}`)
            const texto = document.body.innerText
            return {
              ctasLima,
              mascotes,
              surfaceDark: document.querySelectorAll(".surface-dark").length,
              sobraHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              estourados,
              navegacao: links.map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })),
              headerBg: header ? getComputedStyle(header).backgroundColor : null,
              area: document.documentElement.dataset.area ?? null,
              textoOperador: (texto.match(/painel administrativo|multi-?operador|operadores|administrativ[oa]/gi) ?? []).slice(0, 5),
              h1: [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").trim()),
            }
          }, LIMA)

          gravar(`${vp}__${tela.id}__criterios`, { tela: tela.id, viewport: vp, fracaoEscura: +(escuros / total).toFixed(3), fracaoClara: +(claros / total).toFixed(3), ...m })

          expect(m.sobraHorizontal, `rolagem horizontal em ${tela.id} a ${vp}px`).toBe(0)
          expect(m.estourados, `elementos além da borda direita em ${tela.id} a ${vp}px`).toEqual([])
          expect(m.area, `o escopo transitório data-area acabou na F-D (${tela.id})`).toBeNull()
          expect(m.headerBg, `cabeçalho = theme-color em ${tela.id}`).toBe(THEME)
          expect(m.surfaceDark, `moldura escura (cabeçalho + navegação) em ${tela.id}`).toBeGreaterThanOrEqual(2)
          expect(escuros / total, `moldura escura visível em ${tela.id} a ${vp}px`).toBeGreaterThan(0.03)
          expect(claros / total, `miolo claro em ${tela.id} a ${vp}px`).toBeGreaterThan(0.1)
          // D2: no máximo UM CTA lima por tela (e ao menos um onde a tela tem ação principal).
          expect(m.ctasLima.length, `mais de um CTA lima em ${tela.id}: ${m.ctasLima.join(" | ")}`).toBeLessThanOrEqual(1)
          if (COM_CTA_LIMA.has(tela.id)) expect(m.ctasLima.length, `CTA lima em ${tela.id}`).toBe(1)
          if (COM_MASCOTE.has(tela.id)) expect(m.mascotes, `mascote no vazio de ${tela.id}`).toBeGreaterThanOrEqual(1)
          expect(m.textoOperador, `texto de operador em ${tela.id}`).toEqual([])
          expect(m.h1.length, `exatamente um h1 em ${tela.id}`).toBe(1)

          // Navegação inteira dentro da janela, 5 destinos, alvo de toque >= 44 px (o que a foto da página não mostra: fixed fora do documento).
          expect(m.navegacao.length, `5 destinos de navegação em ${tela.id}`).toBe(5)
          for (const r of m.navegacao) {
            expect(r.x, `aba fora da janela (esquerda) em ${tela.id} a ${vp}px`).toBeGreaterThanOrEqual(0)
            expect(r.x + r.w, `aba fora da janela (direita) em ${tela.id} a ${vp}px`).toBeLessThanOrEqual(vw + 1)
            expect(r.y + r.h, `aba fora da janela (baixo) em ${tela.id} a ${vp}px`).toBeLessThanOrEqual(vh + 1) // +1: y e altura chegam arredondados separadamente
            expect(r.w, `alvo de toque (largura) em ${tela.id}`).toBeGreaterThanOrEqual(44)
            expect(r.h, `alvo de toque (altura) em ${tela.id}`).toBeGreaterThanOrEqual(44)
          }
          // >= lg: trilho lateral (todas as abas na mesma coluna); < lg: barra embaixo (todas na mesma linha).
          if (vw >= 1024) expect(new Set(m.navegacao.map((r) => r.x)).size, `trilho: abas na mesma coluna em ${tela.id}`).toBe(1)
          else expect(new Set(m.navegacao.map((r) => r.y)).size, `barra: abas na mesma linha em ${tela.id}`).toBe(1)
        })
      }
    })

    test.describe("B) teclado e foco", () => {
      for (const tela of telas) {
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
          // O mapa tem dezenas de focáveis (cards + marcadores): 40 Tabs não fecham o ciclo; o resto da régua (indicador de foco, ordem) vale igual.
        if (tela.id !== "pwa-mapa") expect(ciclou, `o foco não prendeu nem passou de 40 Tabs em ${tela.id}`).toBe(true)
          const sem = passos.filter((p) => p.mudou >= 0 && (p.mudou === 0 || p.contrasteMax < 3))
          expect(sem, `elementos sem indicador de foco visível (mudança de pixels com contraste >= 3:1) em ${tela.id}`).toEqual([])
          // ordem: nenhum Tab pode saltar mais de uma "tela" para cima (ordem visual quebrada)
          // A partir de lg a navegação é o TRILHO lateral (x < 100), que vem DEPOIS do conteúdo na ordem do DOM (no celular ela é a barra de baixo): o salto de volta ao topo para entrar nele é esperado.
        const vwTab = page.viewportSize()!.width
        const saltosParaCima = passos.filter((p, i) => i > 0 && p.yDoc < passos[i - 1].yDoc - 300 && !(vwTab >= 1024 && p.x < 100))
          // O mapa a partir de lg é uma coluna `sticky` à direita: o yDoc dela depende da rolagem do momento, então a comparação de altura não vale lá.
        if (!(tela.id === "pwa-mapa" && vwTab >= 1024)) expect(saltosParaCima, `ordem de Tab voltando muito para cima em ${tela.id}`).toEqual([])
        })
      }
    })
  })
}
