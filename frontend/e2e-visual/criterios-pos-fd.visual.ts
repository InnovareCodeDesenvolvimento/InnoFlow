import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PASTA_AUTH, PERSONAS } from "./constantes"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * Régua do ACABAMENTO pós-F-D (Lyra, 05/10/2026), medida no navegador. Rodar: `npx playwright test --config playwright.visual.config.ts criterios-pos-fd`.
 * Grava `e2e-visual/.resultados/pos-fd/*.json`.
 *
 *  1) Drawer mobile do Admin (375/768) é um DIÁLOGO de verdade: role=dialog com nome, foco entra, Tab preso dentro, resto da página fora da árvore de acessibilidade
 *     (aria-hidden), Esc fecha, foco volta ao botão "Abrir menu", crescer a janela até lg fecha o diálogo.
 *  2) Folga de contraste: cores de estado e do accent medidas pelo CSS que o navegador carregou (razão calculada sobre o computed style, não sobre o arquivo).
 *  3) /app/sessao com sessão FAULTED: a resposta da consulta chega TARDE (atrasada de propósito em 900 ms para a corrida acontecer 100% das vezes, e não 1 em 40) — o que aparece
 *     antes dela tem a altura do bloco real e o CLS é 0.
 */

const PASTA = "e2e-visual/.resultados/pos-fd"
function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}
const auth = (p: keyof typeof PERSONAS) => path.join(PASTA_AUTH, `${PERSONAS[p].arquivo}.json`)

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test.describe("1) drawer mobile do Admin é um diálogo acessível", () => {
  test.use({ storageState: auth("admin") })

  test("role=dialog, foco entra e fica preso, resto aria-hidden, Esc fecha e devolve o foco", async ({ page }, info) => {
    const vw = page.viewportSize()!.width
    test.skip(vw >= 1024, "o drawer só existe abaixo de lg")
    await prepararPagina(page)
    await page.goto("/admin/dashboard", { waitUntil: "load" })
    await aguardarEstavel(page)

    const abrir = page.getByRole("button", { name: "Abrir menu" })
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(abrir).toHaveAttribute("aria-expanded", "false")
    await abrir.click()

    const dialogo = page.getByRole("dialog", { name: "Menu" })
    await expect(dialogo, "role=dialog com nome acessível").toBeVisible()
    await expect(dialogo).toHaveAttribute("role", "dialog")
    expect(await dialogo.getAttribute("aria-labelledby"), "nome vem do texto 'Menu' visível").toBeTruthy()

    // foco entrou no diálogo (o primeiro focável é "Fechar menu")
    const dentro = () => page.evaluate(() => !!document.activeElement?.closest("[role='dialog']"))
    expect(await dentro(), "foco entra ao abrir").toBe(true)
    await expect(page.getByRole("button", { name: "Fechar menu" })).toBeFocused()

    // o resto da página sai da árvore de acessibilidade
    const atras = await page.evaluate(() => {
      const main = document.querySelector("main")!
      const escondido = (el: Element | null) => {
        for (let n: Element | null = el; n; n = n.parentElement) if (n.getAttribute("aria-hidden") === "true" || (n as HTMLElement).inert) return true
        return false
      }
      return { main: escondido(main), header: escondido(document.querySelector("header")), dialogo: escondido(document.querySelector("[role='dialog']")) }
    })
    expect(atras.main, "<main> atrás do véu fica aria-hidden").toBe(true)
    expect(atras.header, "<header> atrás do véu fica aria-hidden").toBe(true)
    expect(atras.dialogo, "o diálogo em si NÃO fica escondido").toBe(false)

    // Tab (e Shift+Tab) nunca sai do diálogo: 40 voltas
    const foco: string[] = []
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(i % 4 === 3 ? "Shift+Tab" : "Tab")
      foco.push(await page.evaluate(() => (document.activeElement?.closest("[role='dialog']") ? "dialogo" : (document.activeElement?.tagName ?? "?") + " FORA")))
    }
    gravar(`${info.project.name}__drawer-foco`, { foco })
    expect(foco.filter((f) => f !== "dialogo"), "nenhum Tab escapa do diálogo").toEqual([])

    // Esc fecha e devolve o foco ao botão que abriu
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(abrir, "foco volta ao 'Abrir menu'").toBeFocused()
    await expect(abrir).toHaveAttribute("aria-expanded", "false")
    expect(await page.evaluate(() => !!document.querySelector("[aria-hidden='true'] main, main[aria-hidden='true']")), "a página volta à árvore de acessibilidade").toBe(false)

    // clique no véu fecha; navegar por um link fecha e a página nova NÃO fica escondida
    await abrir.click()
    await expect(dialogo).toBeVisible()
    await page.mouse.click(10, 10)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await abrir.click()
    await page.getByRole("dialog").getByRole("link", { name: "Sessões" }).first().click()
    await expect(page).toHaveURL(/\/admin\/sessoes/)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(await page.evaluate(() => (document.querySelector("main")?.closest("[aria-hidden='true']") ? "escondido" : "ok")), "depois de navegar o <main> volta à árvore").toBe("ok")
  })

  test("crescer a janela até lg com o diálogo aberto fecha o diálogo (não fica invisível travando o foco)", async ({ page }) => {
    const vw = page.viewportSize()!.width
    test.skip(vw >= 1024, "o drawer só existe abaixo de lg")
    await prepararPagina(page)
    await page.goto("/admin/dashboard", { waitUntil: "load" })
    await aguardarEstavel(page)
    await page.getByRole("button", { name: "Abrir menu" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(await page.evaluate(() => document.querySelectorAll("[aria-hidden='true'] main, main[aria-hidden='true']").length)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
function lum([r, g, b]: number[]): number {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const razao = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

test.describe("2) folga de contraste dos tokens de estado e do accent (CSS carregado)", () => {
  test("badge de aviso, accent/success sobre branco e sobre o fundo da página", async ({ page }) => {
    test.skip(page.viewportSize()!.width !== 1440, "tokens não dependem de largura; roda uma vez")
    await prepararPagina(page)
    await page.goto("/login", { waitUntil: "load" })
    await aguardarEstavel(page)
    const cores = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const rgb = (n: string) => root.getPropertyValue(n).trim().split(/\s+/).map(Number)
      return {
        w700: rgb("--color-warning-700"),
        w100: rgb("--color-warning-100"),
        w50: rgb("--color-warning-50"),
        a600: rgb("--color-accent-600"),
        a: rgb("--color-accent"),
        s600: rgb("--color-success-600"),
        s: rgb("--color-success"),
        branco: rgb("--color-surface"),
        fundo: rgb("--color-background"),
        muted: rgb("--color-muted"),
      }
    })
    const medidas = {
      "warning-700 / warning-100": razao(cores.w700, cores.w100),
      "warning-700 / warning-50": razao(cores.w700, cores.w50),
      "warning-700 / branco": razao(cores.w700, cores.branco),
      "accent-600 / branco": razao(cores.a600, cores.branco),
      "accent / branco": razao(cores.a, cores.branco),
      "success / branco": razao(cores.s, cores.branco),
      "success-600 / branco": razao(cores.s600, cores.branco),
      "accent-600 / fundo da página": razao(cores.a600, cores.fundo),
      "accent-600 / muted": razao(cores.a600, cores.muted),
    }
    gravar("contraste-tokens", medidas)
    expect(medidas["warning-700 / warning-100"], "badge de aviso").toBeGreaterThanOrEqual(5)
    expect(medidas["accent-600 / branco"], "accent-600 sobre branco").toBeGreaterThanOrEqual(5)
    expect(medidas["accent / branco"]).toBeGreaterThanOrEqual(5)
    expect(medidas["success / branco"]).toBeGreaterThanOrEqual(5)
    expect(medidas["accent-600 / fundo da página"], "accent-600 sobre #F9FAFB").toBeGreaterThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
/** Atrasa a consulta da sessão ativa (XHR do axios e fetch) para a "corrida" do 1º quadro acontecer SEMPRE. */
async function atrasarSessaoAtiva(page: Page, ms: number) {
  await page.addInitScript((atraso) => {
    const alvo = /\/api\/me\/sessions\/active/
    const open = XMLHttpRequest.prototype.open
    const send = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __atrasar?: boolean }, method: string, url: string | URL, ...resto: unknown[]) {
      this.__atrasar = alvo.test(String(url))
      return (open as (...a: unknown[]) => void).call(this, method, url, ...resto)
    } as typeof open
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __atrasar?: boolean }, corpo?: Document | XMLHttpRequestBodyInit | null) {
      if (this.__atrasar) setTimeout(() => send.call(this, corpo), atraso)
      else send.call(this, corpo)
    }
    const f = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      return alvo.test(url) ? new Promise((r) => setTimeout(r, atraso)).then(() => f(input, init)) : f(input, init)
    }
    const w = window as unknown as { __cls: number; __clsLog: Array<{ v: number; t: number }> }
    w.__cls = 0
    w.__clsLog = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean; startTime: number }>)
        if (!e.hadRecentInput) {
          w.__cls += e.value
          w.__clsLog.push({ v: +e.value.toFixed(4), t: Math.round(e.startTime) })
        }
    }).observe({ type: "layout-shift", buffered: true })
  }, ms)
}

test.describe("3) /app/sessao (sessão FAULTED) com a consulta chegando tarde", () => {
  for (const persona of ["travado", "driver"] as const) {
    test.describe(persona, () => {
    test.use({ storageState: auth(persona) })
    test(`${persona}: o que aparece antes da resposta tem a altura do bloco real e o CLS é ~0`, async ({ page }) => {
      const vw = page.viewportSize()!.width
      await prepararPagina(page)
      await atrasarSessaoAtiva(page, 900)
      await page.goto("/app/sessao", { waitUntil: "load" })
      // amostrador: a cada quadro anota o que a tela mostra e a altura do bloco da página (1º filho do <main>)
      await page.evaluate(() => {
        const w = window as unknown as { __amostras: Array<{ t: number; h: number; estado: string }> }
        w.__amostras = []
        const tick = () => {
          const bloco = document.querySelector("main")?.firstElementChild as HTMLElement | null
          if (bloco) {
            const texto = document.body.innerText
            const estado = texto.includes("Parar recarga")
              ? "AO_VIVO"
              : texto.includes("Nenhuma recarga em andamento")
                ? "VAZIO"
                : bloco.querySelector(".skeleton")
                  ? "ESQUELETO"
                  : "OUTRO"
            const ultima = w.__amostras[w.__amostras.length - 1]
            const h = Math.round(bloco.getBoundingClientRect().height)
            if (!ultima || ultima.estado !== estado || ultima.h !== h) w.__amostras.push({ t: Math.round(performance.now()), h, estado })
          }
          requestAnimationFrame(tick)
        }
        tick()
      })
      const final = persona === "travado" ? "Parar recarga" : "Nenhuma recarga em andamento"
      await page.getByText(final).first().waitFor({ state: "visible", timeout: 20_000 })
      await page.waitForTimeout(600)
      const medido = await page.evaluate(() => {
        const w = window as unknown as { __cls: number; __clsLog: unknown[]; __amostras: Array<{ t: number; h: number; estado: string }> }
        const aviso = document.querySelector("main [role=status].mb-4") as HTMLElement | null
        return { cls: +w.__cls.toFixed(4), log: w.__clsLog, amostras: w.__amostras, alturaAviso: aviso ? Math.round(aviso.getBoundingClientRect().height) + 16 : 0 }
      })
      const amostras = medido.amostras
      const fim = amostras[amostras.length - 1]
      const antes = amostras.filter((a) => a.estado !== fim.estado)
      const depois = { cls: medido.cls, log: medido.log, alturaFinal: fim.h, estadoFinal: fim.estado, alturaAviso: medido.alturaAviso }
      gravar(`${vw}__sessao-${persona}`, { amostras, depois })
      if (persona === "travado") {
        expect(fim.estado, "a sessão FAULTED carregou").toBe("AO_VIVO")
        expect(antes.map((x) => x.estado), "NUNCA mostra 'Nenhuma recarga em andamento' enquanto a consulta ainda não respondeu").not.toContain("VAZIO")
        const esqueleto = antes.filter((x) => x.estado === "ESQUELETO").pop()
        expect(esqueleto, "aparece um esqueleto enquanto a consulta não responde").toBeTruthy()
        // o esqueleto tem a forma da sessão SEM o aviso de falha (o caso comum); com o aviso (FAULTED) o bloco real tem `alturaAviso` a mais
        const esperado = fim.h - depois.alturaAviso
        expect(Math.abs(esqueleto!.h - esperado), `esqueleto ${esqueleto!.h} px x bloco real sem aviso ${esperado} px (real com aviso ${fim.h})`).toBeLessThanOrEqual(4)
        expect(depois.cls, "CLS").toBeLessThanOrEqual(0.02)
      } else {
        // motorista SEM sessão: o esqueleto (alto) cede a um cartão mais baixo — o conteúdo diminui, nada ABAIXO dele se mexe
        expect(fim.estado).toBe("VAZIO")
        expect(depois.cls, "CLS").toBeLessThanOrEqual(0.02)
      }
    })
    })
  }
})
