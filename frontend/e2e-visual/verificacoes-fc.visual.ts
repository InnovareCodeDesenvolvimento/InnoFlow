import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PASTA_AUTH, PERSONAS, T0 } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"
import { ROTAS } from "./rotas"

/**
 * VERIFICAÇÕES INDEPENDENTES da F-C (PWA do motorista) — o que `criterios-fc.visual.ts` (da Lyra) e o `test:visual` NÃO provam:
 *  1) contraste de TEXTO por PIXEL (sobre degradê/vidro, onde o axe diz "incompleto"), incluindo os estados do fluxo de recarga;
 *  2) `html[data-area="driver"]` liga SÓ no shell do app: não vaza para público/auth/admin (carga direta E navegação SPA) e os raios de campo/botão/diálogo do Admin ficam como eram;
 *  3) o que está FORA da foto: trilho/barra de navegação fixos continuam na janela depois de rolar, o conteúdo não termina escondido atrás deles, o véu do Dialog cobre cabeçalho e navegação,
 *     o foco fica preso no diálogo e volta ao disparador; a rolagem do documento não passa por baixo;
 *  4) CLS do PWA logado (3 cargas por rota, 390 e 1440);
 *  5) mascote nunca sobre dado (nenhum <img> de mascote dentro de tabela/lista de dados) e o texto "Ao vivo" é único.
 * Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-fc`. Grava `e2e-visual/.resultados/fc/*.json`.
 */

const PASTA = "e2e-visual/.resultados/fc"
function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}
const auth = (p: "driver" | "travado" | "admin") => path.join(PASTA_AUTH, `${PERSONAS[p].arquivo}.json`)
const PWA = ROTAS.filter((r) => r.id.startsWith("pwa-"))

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test.describe("1) contraste de texto por pixel", () => {
  for (const persona of ["driver", "travado"] as const) {
    test.describe(persona, () => {
      test.use({ storageState: auth(persona) })
      for (const tela of PWA.filter((r) => r.persona === persona)) {
        test(`${tela.id}`, async ({ page }, info) => {
          await prepararPagina(page)
          await page.goto(tela.path, { waitUntil: "load" })
          await aguardarEstavel(page, tela.pronto)
          const r = await medirContrastePixel(page)
          gravar(`${info.project.name}__${tela.id}__contraste-pixel`, r)
          expect(r.textos, `nenhum texto medido em ${tela.id}`).toBeGreaterThan(3)
          expect(r.reprovados, `texto abaixo do limiar AA por pixel em ${tela.id} a ${info.project.name}px`).toEqual([])
        })
      }
    })
  }

  test.describe("estados do fluxo de recarga (conectando, ao vivo, diálogo, recibo)", () => {
    test.use({ storageState: auth("driver") })
    test("contraste por pixel em cada estado", async ({ page }, info) => {
      await prepararPagina(page)
      await page.goto("/c/CP-VILA-NORTE-01/1", { waitUntil: "load" })
      await page.getByRole("button", { name: "Iniciar recarga" }).click()
      await expect(page).toHaveURL(/\/app\/sessao/)
      await expect(page.getByText("Conectando ao carregador…")).toBeVisible()
      const resultados: Record<string, Awaited<ReturnType<typeof medirContrastePixel>>> = {}
      await aguardarEstavel(page, { spinnerEhConteudo: true })
      resultados.conectando = await medirContrastePixel(page)
      await page.clock.setFixedTime(new Date(T0.getTime() + 125_000))
      await expect(page.getByText(/0,24/).first()).toBeVisible({ timeout: 30_000 })
      await aguardarEstavel(page)
      resultados.aoVivo = await medirContrastePixel(page)
      await page.getByRole("button", { name: "Parar recarga" }).first().click()
      await expect(page.getByRole("dialog").getByText("Parar a recarga agora?")).toBeVisible()
      resultados.dialogo = await medirContrastePixel(page)
      await page.getByRole("dialog").getByRole("button", { name: "Parar recarga" }).click()
      await page.clock.setFixedTime(new Date(T0.getTime() + 135_000))
      await expect(page).toHaveURL(/\/app\/sessoes\/.+/, { timeout: 30_000 })
      await expect(page.getByText("Recarga concluída")).toBeVisible()
      await aguardarEstavel(page)
      resultados.recibo = await medirContrastePixel(page)
      gravar(`${info.project.name}__fluxo__contraste-pixel`, resultados)
      for (const [estado, r] of Object.entries(resultados)) expect(r.reprovados, `contraste por pixel no estado "${estado}"`).toEqual([])
    })
  })

  test.describe("Pix (seletor, QR pendente, sucesso e expirado)", () => {
    test.use({ storageState: auth("driver") })
    async function ate(page: Page, depoisMs?: number) {
      await prepararPagina(page)
      await page.goto("/app/carteira/adicionar", { waitUntil: "load" })
      await aguardarEstavel(page)
      const r = { valor: await medirContrastePixel(page) }
      await page.getByText(/R\$\s*50,00/).first().click()
      await page.getByRole("button", { name: "Gerar código Pix" }).click()
      await expect(page.getByText("Aguardando pagamento")).toBeVisible({ timeout: 15_000 })
      await aguardarEstavel(page, { spinnerEhConteudo: true }) // "Aguardando pagamento" tem spinner: é o estado
      return { r, depoisMs }
    }
    test("seletor, pendente e sucesso", async ({ page }, info) => {
      const { r } = await ate(page)
      const resultados: Record<string, Awaited<ReturnType<typeof medirContrastePixel>>> = { ...r, pendente: await medirContrastePixel(page) }
      await page.clock.setFixedTime(new Date(T0.getTime() + 60_000)) // o mock "paga" depois de ~8 s de relógio
      await expect(page.getByText("Saldo adicionado!")).toBeVisible({ timeout: 30_000 })
      await aguardarEstavel(page)
      resultados.sucesso = await medirContrastePixel(page)
      gravar(`${info.project.name}__pix__contraste-pixel`, resultados)
      for (const [estado, x] of Object.entries(resultados)) expect(x.reprovados, `contraste por pixel no Pix "${estado}"`).toEqual([])
    })
    test("expirado", async ({ page }, info) => {
      await ate(page)
      await page.clock.setFixedTime(new Date(T0.getTime() + 40 * 60_000)) // o mock expira o Pix quando `agora >= expiresAt` (30 min)
      await expect(page.getByText("O Pix expirou")).toBeVisible({ timeout: 30_000 })
      await aguardarEstavel(page, { spinnerEhConteudo: true })
      const x = await medirContrastePixel(page)
      gravar(`${info.project.name}__pix-expirado__contraste-pixel`, x)
      expect(x.reprovados, "contraste por pixel no Pix expirado").toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 2) "escopo data-area não vaza" foi REMOVIDO na F-D: o escopo `data-area="driver"` acabou de propósito (decisões D1-D7), então os raios 12/20 px do Admin e do público deixaram de existir. Não há mais o que cobrir: o atributo deixou de existir.

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test.describe("3) o que fica FORA da foto: navegação fixa, véu do diálogo, foco preso", () => {
  test.use({ storageState: auth("travado") })

  test("depois de rolar até o fim, a navegação segue dentro da janela e o fim do conteúdo não fica atrás dela", async ({ page }, info) => {
    const vp = page.viewportSize()!
    await prepararPagina(page)
    await page.goto("/app/mapa", { waitUntil: "load" }) // a rota mais longa do app (lista de ~16 eletropostos): sem rolagem real o teste não prova nada
    await aguardarEstavel(page)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(250)
    const m = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Navegação do aplicativo"]') as HTMLElement
      const cabecalho = document.querySelector("header") as HTMLElement
      const rn = nav.getBoundingClientRect()
      const rh = cabecalho.getBoundingClientRect()
      const conteudo = [...document.querySelectorAll("main *")].filter((e) => e.children.length === 0 && (e.textContent ?? "").trim() && e.getBoundingClientRect().height > 0)
      const ultimo = conteudo.map((e) => e.getBoundingClientRect().bottom).sort((a, b) => b - a)[0]
      return { navPos: getComputedStyle(nav).position, headerPos: getComputedStyle(cabecalho).position, nav: { x: rn.x, y: rn.y, w: rn.width, h: rn.height }, header: { y: rh.y, h: rh.height }, fimDoConteudo: ultimo, rolou: window.scrollY }
    })
    gravar(`${info.project.name}__nav-apos-rolar`, m)
    expect(m.rolou, "a página rolou de verdade").toBeGreaterThan(300)
    expect(m.navPos).toBe("fixed")
    expect(m.nav.x, "navegação dentro da janela (esquerda)").toBeGreaterThanOrEqual(0)
    expect(m.nav.x + m.nav.w, "navegação dentro da janela (direita)").toBeLessThanOrEqual(vp.width + 1)
    expect(m.nav.y + m.nav.h, "navegação dentro da janela (baixo)").toBeLessThanOrEqual(vp.height + 1)
    expect(m.header.y, "cabeçalho colado no topo depois de rolar").toBeLessThanOrEqual(0.5)
    if (vp.width < 1024) expect(m.fimDoConteudo, "o último texto não pode ficar atrás da barra de baixo").toBeLessThanOrEqual(m.nav.y + 1)
    else expect(m.nav.w, "trilho lateral estreito (não cobre o conteúdo)").toBeLessThanOrEqual(110)
  })

  test("Dialog de parar recarga: o véu cobre a janela inteira (inclui cabeçalho e navegação), o foco fica preso e volta ao disparador, Esc fecha", async ({ page }, info) => {
    const vp = page.viewportSize()!
    await prepararPagina(page)
    await page.goto("/app/sessao", { waitUntil: "load" })
    await aguardarEstavel(page)
    // sessão FAULTED do travado@ tem o botão de encerrar; usa o diálogo de confirmação de lá
    const disparador = page.getByRole("button", { name: /Encerrar|Parar/ }).first()
    await expect(disparador).toBeVisible()
    await disparador.focus()
    await page.keyboard.press("Enter")
    const dialogo = page.getByRole("dialog")
    await expect(dialogo).toBeVisible()
    const m = await page.evaluate(() => {
      const veu = document.querySelector(".dialog-scrim") as HTMLElement | null
      const rv = veu?.getBoundingClientRect()
      const nav = document.querySelector('nav[aria-label="Navegação do aplicativo"]') as HTMLElement
      const cab = document.querySelector("header") as HTMLElement
      const topo = (el: HTMLElement) => {
        const r = el.getBoundingClientRect()
        const alvo = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 20))
        return { dentroDoVeuOuDialogo: !!alvo && (alvo === veu || !!alvo.closest("[role='dialog']") || !!alvo.closest(".dialog-scrim")), alvo: alvo ? alvo.tagName.toLowerCase() + "." + String((alvo as HTMLElement).className).slice(0, 40) : null }
      }
      return {
        veu: rv ? { x: rv.x, y: rv.y, w: rv.width, h: rv.height, cor: getComputedStyle(veu!).backgroundColor, blur: getComputedStyle(veu!).backdropFilter } : null,
        sobreNav: topo(nav),
        sobreCabecalho: topo(cab),
        overflowBody: getComputedStyle(document.body).overflow,
        raio: getComputedStyle(document.querySelector("[role='dialog']")!).borderTopLeftRadius,
      }
    })
    gravar(`${info.project.name}__dialogo-veu`, m)
    expect(m.veu, "véu presente (.dialog-scrim)").not.toBeNull()
    expect(m.veu!.x).toBeLessThanOrEqual(0)
    expect(m.veu!.y).toBeLessThanOrEqual(0)
    expect(m.veu!.w).toBeGreaterThanOrEqual(vp.width)
    expect(m.veu!.h).toBeGreaterThanOrEqual(vp.height)
    expect(m.veu!.cor, "véu do PWA = noite translúcido").toMatch(/^rgba\(6, 22, 33, 0\.6/)
    expect(m.veu!.blur, "véu do PWA sem desfoque").toMatch(/none|^$/)
    expect(m.sobreNav.dentroDoVeuOuDialogo, `a navegação fica por baixo do véu (${m.sobreNav.alvo})`).toBe(true)
    expect(m.sobreCabecalho.dentroDoVeuOuDialogo, `o cabeçalho fica por baixo do véu (${m.sobreCabecalho.alvo})`).toBe(true)
    // foco preso: 12 Tabs e Shift+Tabs nunca saem do diálogo
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab")
      expect(await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']")), `foco saiu do diálogo no Tab ${i + 1}`).toBe(true)
    }
    await page.keyboard.press("Escape")
    await expect(dialogo).toBeHidden()
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim()), "o foco volta ao disparador").toMatch(/Encerrar|Parar/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test.describe("4) CLS do PWA logado", () => {
  for (const largura of [390, 1440]) {
    test.describe(`${largura}px`, () => {
      for (const persona of ["driver", "travado"] as const) {
        test.describe(persona, () => {
          test.use({ storageState: auth(persona) })
          test("3 cargas por rota", async ({ page }) => {
            await page.setViewportSize({ width: largura, height: largura === 390 ? 844 : 900 })
            await prepararPagina(page)
            const saida: Record<string, number[]> = {}
            for (const tela of PWA.filter((r) => r.persona === persona)) {
              saida[tela.id] = []
              for (let i = 0; i < 3; i++) {
                await page.addInitScript(() => {
                  const w = window as unknown as { __cls: number; __clsOn?: boolean }
                  if (w.__clsOn) return
                  w.__clsOn = true
                  w.__cls = 0
                  new PerformanceObserver((list) => {
                    for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value
                  }).observe({ type: "layout-shift", buffered: true })
                })
                await page.goto(tela.path, { waitUntil: "load" })
                await aguardarEstavel(page, tela.pronto)
                await page.waitForTimeout(700)
                saida[tela.id].push(+(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toFixed(4))
              }
            }
            gravar(`${largura}__${persona}__cls`, saida)
            const recibos = Object.entries(saida).filter(([id]) => id.startsWith("pwa-recibo"))
            for (const [id, v] of recibos) expect(Math.max(...v), `CLS do ${id} a ${largura}px`).toBe(0)
            for (const [id, v] of Object.entries(saida)) expect(Math.max(...v), `CLS de ${id} a ${largura}px`).toBeLessThanOrEqual(0.02)
          })
        })
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test.describe("5) mascote nunca sobre dado; 'Ao vivo' único", () => {
  test.use({ storageState: auth("travado") })
  for (const tela of PWA.filter((r) => r.persona === "travado")) {
    test(`${tela.id}: nenhum mascote dentro de tabela/lista de dados/valores`, async ({ page }) => {
      await prepararPagina(page)
      await page.goto(tela.path, { waitUntil: "load" })
      await aguardarEstavel(page, tela.pronto)
      const ruins = await page.evaluate(() =>
        [...document.querySelectorAll("img")]
          .filter((i) => /mascote/i.test(i.currentSrc || i.src) || (i.currentSrc || i.src).startsWith("data:image/webp"))
          .filter((i) => !!i.closest("table, [data-dado], ul[role='list'] li, dl") || !!i.parentElement?.parentElement?.querySelector("[data-valor]"))
          .map((i) => i.outerHTML.slice(0, 80)),
      )
      expect(ruins).toEqual([])
    })
  }

  for (const id of ["pwa-recibo-fechada-pelo-servidor", "pwa-recibo-stop-nao-confirmado-carteira", "pwa-recibo-stop-nao-confirmado-cartao"]) {
    test(`${id}: o motorista NUNCA vê o stop tardio (lateStop é só do admin) nem R$ 0,00 no lugar de "em confirmação"`, async ({ page }) => {
      const tela = PWA.find((r) => r.id === id)!
      await prepararPagina(page)
      await page.goto(tela.path, { waitUntil: "load" })
      await aguardarEstavel(page, tela.pronto)
      const corpo = await page.locator("body").innerText()
      expect(corpo).not.toMatch(/StopTransaction tardio|stop tardio|lateStop/i)
      if (id.includes("nao-confirmado")) {
        expect(corpo, "sessão em confirmação não mostra total").not.toMatch(/R\$\s*0,00/)
        expect(corpo).not.toContain("Recarga concluída")
      }
    })
  }

  test("sessão ao vivo: o texto 'Ao vivo' aparece uma vez só", async ({ browser }) => {
    const contexto = await browser.newContext({ storageState: auth("driver"), locale: "pt-BR", timezoneId: "America/Sao_Paulo", viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })
    const page = await contexto.newPage()
    await prepararPagina(page)
    await page.goto("/c/CP-VILA-NORTE-01/1", { waitUntil: "load" })
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await page.clock.setFixedTime(new Date(T0.getTime() + 125_000))
    await expect(page.getByText(/0,24/).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Ao vivo", { exact: true })).toHaveCount(1)
    await contexto.close()
  })
})

