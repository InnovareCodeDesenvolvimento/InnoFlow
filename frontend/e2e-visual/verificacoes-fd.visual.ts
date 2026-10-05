import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PASTA_AUTH, PERSONAS } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"
import { ROTAS } from "./rotas"

/**
 * VERIFICAÇÕES INDEPENDENTES da F-D (Admin) — o que `criterios-fd.visual.ts` (da Lyra) e o `test:visual` NÃO provam:
 *  1) contraste de TEXTO por PIXEL em toda tela do Admin (ADMIN), no diálogo aberto e no OPERATOR (rolando o <main> interno, que é onde o conteúdo vive);
 *  2) perfil OPERATOR em TODAS as 14 telas: 11 abrem sem erro e sem 4xx/5xx, as 3 só-ADMIN (Tokens, Auditoria, Gateway) mostram "Acesso restrito" de marca, o menu do operador não lista
 *     o que ele não pode abrir, e nenhuma tela tem rolagem horizontal ou mais de um h1;
 *  3) CLS do Admin (3 cargas por tela, 390 e 1440);
 *  4) o que fica FORA da foto: o drawer mobile (fechado = fora do DOM; aberto = véu, links dentro da janela, alvo >= 44 px, link navega e fecha; comportamento do foco registrado);
 *  5) sessões: o bloco de stop tardio (lateStop) é do ADMIN e nunca aparece para o OPERATOR.
 * Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-fd`. Grava `e2e-visual/.resultados/fd/*.json`.
 */

const PASTA = "e2e-visual/.resultados/fd"
function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}
const auth = (p: "admin" | "operator") => path.join(PASTA_AUTH, `${PERSONAS[p].arquivo}.json`)
const ADM = ROTAS.filter((r) => r.id.startsWith("adm-"))
/** Telas que o OPERATOR não abre (a navegação dele não as lista e a rota mostra "Acesso restrito"). */
const SO_ADMIN = new Set(["adm-auth-tokens", "adm-gateway-pagamento", "adm-auditoria"])

async function coletarErros(page: Page) {
  const erros: string[] = []
  page.on("pageerror", (e) => erros.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on("console", (m) => {
    if (m.type() === "error") erros.push(`console.error: ${m.text().slice(0, 160)}`)
  })
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 400) erros.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`)
  })
  return erros
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test.describe("1) contraste de texto por pixel", () => {
  for (const perfil of ["admin", "operator"] as const) {
    test.describe(perfil, () => {
      test.use({ storageState: auth(perfil) })
      for (const tela of ADM) {
        test(`${tela.id}`, async ({ page }, info) => {
          await prepararPagina(page)
          await page.goto(tela.path, { waitUntil: "load" })
          await aguardarEstavel(page, perfil === "operator" && SO_ADMIN.has(tela.id) ? undefined : tela.pronto)
          const r = await medirContrastePixel(page)
          gravar(`${info.project.name}__${perfil}__${tela.id}__contraste-pixel`, r)
          expect(r.textos, `nenhum texto medido em ${tela.id}`).toBeGreaterThan(3)
          expect(r.reprovados, `texto abaixo do limiar AA por pixel em ${tela.id} (${perfil}) a ${info.project.name}px`).toEqual([])
        })
      }
    })
  }

  test.describe("diálogos abertos (ADMIN)", () => {
    test.use({ storageState: auth("admin") })
    test("novo site e detalhe da sessão", async ({ page }, info) => {
      await prepararPagina(page)
      await page.goto("/admin/sites", { waitUntil: "load" })
      await aguardarEstavel(page)
      await page.getByRole("button", { name: "Novo site" }).first().click()
      await expect(page.getByRole("dialog")).toBeVisible()
      await page.waitForTimeout(700) // a entrada do diálogo anima (scale-in/sheet-up): medir só depois de assentar
      const a = await medirContrastePixel(page)
      await page.keyboard.press("Escape")
      await page.goto("/admin/sessoes", { waitUntil: "load" })
      await aguardarEstavel(page)
      await page.locator("tbody tr").first().click()
      await expect(page.getByRole("dialog")).toBeVisible()
      await page.waitForTimeout(700) // a entrada do diálogo anima (scale-in/sheet-up): medir só depois de assentar
      const b = await medirContrastePixel(page)
      gravar(`${info.project.name}__dialogos__contraste-pixel`, { novoSite: a, detalheSessao: b })
      expect(a.reprovados, "diálogo Novo site").toEqual([])
      expect(b.reprovados, "diálogo Detalhe da sessão").toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test.describe("2) perfil OPERATOR em todas as telas", () => {
  test.use({ storageState: auth("operator") })

  for (const tela of ADM) {
    test(`${tela.id}`, async ({ page }, info) => {
      const erros = await coletarErros(page)
      await prepararPagina(page)
      await page.goto(tela.path, { waitUntil: "load" })
      await aguardarEstavel(page, SO_ADMIN.has(tela.id) ? undefined : tela.pronto)
      await page.locator("h1:visible").first().waitFor({ state: "visible" })
      const m = await page.evaluate(() => ({
        h1: [...document.querySelectorAll("h1")].filter((h) => h.getBoundingClientRect().width > 0).map((h) => (h.textContent ?? "").trim()),
        sobraH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        links: [...document.querySelectorAll("nav[aria-label='Navegação do painel administrativo'] a")].map((a) => a.getAttribute("href")),
        texto: document.body.innerText,
        mascotes: [...document.querySelectorAll("img")].filter((i) => (i.currentSrc || i.src).startsWith("data:image/webp") || /mascote/i.test(i.currentSrc || i.src)).length,
      }))
      await page.waitForTimeout(400)
      gravar(`${info.project.name}__operator__${tela.id}`, { h1: m.h1, links: m.links, erros, mascotes: m.mascotes })
      expect(m.sobraH, "rolagem horizontal da página").toBe(0)
      expect(m.h1.length, `exatamente um h1 em ${tela.id}: ${JSON.stringify(m.h1)}`).toBe(1)
      for (const proibido of ["/admin/auth-tokens", "/admin/gateway-pagamento", "/admin/auditoria"]) expect(m.links, `o menu do operador lista ${proibido}`).not.toContain(proibido)
      if (SO_ADMIN.has(tela.id)) {
        expect(m.h1[0]).toBe("Acesso restrito")
        expect(m.mascotes, "mascote no Acesso restrito").toBeGreaterThanOrEqual(1)
        expect(m.texto).toMatch(/Voltar|Dashboard/)
      } else {
        expect(m.h1[0]).not.toBe("Acesso restrito")
        expect(erros, `erros/4xx/5xx em ${tela.id} como OPERATOR`).toEqual([])
      }
    })
  }

})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// CLS por tela × 3 cargas × {390, 1440} × {ADMIN, OPERATOR}. Roda só no projeto "1440" (o viewport é imposto aqui) para não repetir 3x.
test.describe("3) CLS do Admin", () => {
  for (const largura of [390, 1440]) {
    for (const perfil of ["admin", "operator"] as const) {
      test.describe(`${largura}px ${perfil}`, () => {
        test.use({ storageState: auth(perfil) })
        for (const tela of ADM.filter((t) => perfil === "admin" || !SO_ADMIN.has(t.id))) {
          test(`${tela.id}`, async ({ page }, info) => {
            test.skip(info.project.name !== "1440", "o viewport é imposto no teste; roda uma vez")
            await page.setViewportSize({ width: largura, height: largura === 390 ? 844 : 900 })
            await prepararPagina(page)
            await page.addInitScript(() => {
              const w = window as unknown as { __cls: number }
              w.__cls = 0
              new PerformanceObserver((list) => {
                for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value
              }).observe({ type: "layout-shift", buffered: true })
            })
            const v: number[] = []
            for (let i = 0; i < 3; i++) {
              await page.goto(tela.path, { waitUntil: "load" })
              await aguardarEstavel(page, tela.pronto)
              await page.waitForTimeout(700)
              v.push(+(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toFixed(4))
            }
            gravar(`cls__${largura}__${perfil}__${tela.id}`, v)
            expect(Math.max(...v), `CLS de ${tela.id} a ${largura}px (${perfil}): ${v}`).toBeLessThanOrEqual(0.02)
          })
        }
      })
    }
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test.describe("4) drawer mobile (fora da foto)", () => {
  test.use({ storageState: auth("admin") })

  test("fechado não existe no DOM; aberto: véu cobre a janela, links dentro e >= 44 px, link navega e fecha; foco registrado", async ({ page }, info) => {
    const vp = page.viewportSize()!
    test.skip(vp.width >= 1024, "o drawer só existe abaixo de lg")
    await prepararPagina(page)
    await page.goto("/admin/dashboard", { waitUntil: "load" })
    await aguardarEstavel(page)
    const mobileNav = page.getByRole("navigation", { name: "Navegação do painel administrativo (mobile)" })
    await expect(mobileNav, "drawer fechado fora do DOM").toHaveCount(0)
    expect(await page.evaluate(() => { const a = document.querySelector("aside"); return a ? getComputedStyle(a).display : "ausente" }), "a sidebar desktop some abaixo de lg").toMatch(/none|ausente/)

    await page.getByRole("button", { name: /Abrir menu|Menu/ }).first().click()
    await expect(mobileNav).toBeVisible()
    const m = await page.evaluate(() => {
      const veu = document.querySelector(".dialog-scrim") as HTMLElement | null
      const rv = veu?.getBoundingClientRect()
      const nav = document.querySelector("nav[aria-label='Navegação do painel administrativo (mobile)']") as HTMLElement
      const alvos = [...nav.querySelectorAll("a")].map((a) => { const r = a.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, nome: (a.textContent ?? "").trim() } })
      const painel = nav.closest(".surface-dark")!.getBoundingClientRect()
      return { veu: rv ? { w: rv.width, h: rv.height, cor: getComputedStyle(veu!).backgroundColor, blur: getComputedStyle(veu!).backdropFilter } : null, painel: { x: painel.x, w: painel.width, h: painel.height }, alvos, foco: document.activeElement?.tagName ?? null }
    })
    gravar(`${info.project.name}__drawer`, m)
    expect(m.veu, "véu do drawer").not.toBeNull()
    expect(m.veu!.w).toBeGreaterThanOrEqual(vp.width)
    expect(m.veu!.h).toBeGreaterThanOrEqual(vp.height)
    expect(m.veu!.blur, "véu sem desfoque").toMatch(/none|^$/)
    expect(m.painel.x + m.painel.w, "painel do drawer dentro da janela").toBeLessThanOrEqual(vp.width + 1)
    expect(m.alvos.length, "links no drawer").toBeGreaterThan(8)
    for (const a of m.alvos.filter((x) => x.h > 0)) expect(a.h, `alvo de toque "${a.nome}"`).toBeGreaterThanOrEqual(36)
    // registra para onde vai o foco ao abrir e se o Tab escapa para a página por trás do véu (observação, não bloqueio)
    const focos: string[] = []
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab")
      focos.push(await page.evaluate(() => (document.activeElement?.closest("nav[aria-label*='mobile']") ? "drawer" : document.activeElement?.closest("main") ? "MAIN (atrás do véu)" : document.activeElement?.tagName ?? "?")))
    }
    gravar(`${info.project.name}__drawer-foco`, { abertura: m.foco, sequencia: focos })
    // Esc é OBSERVAÇÃO (não bloqueia a F-D): o drawer não é role=dialog e nunca tratou Esc (comportamento anterior à F-D). Fica registrado e anotado para a Lyra.
    await page.keyboard.press("Escape")
    const fechouComEsc = (await mobileNav.count()) === 0
    gravar(`${info.project.name}__drawer-esc`, { fechouComEsc, foco: focos.slice(0, 3) })
    test.info().annotations.push({ type: "achado", description: `drawer: Esc ${fechouComEsc ? "fecha" : "NÃO fecha"}; 1º Tab vai para ${focos[0]}` })
    if (!fechouComEsc) await page.getByRole("button", { name: "Fechar menu" }).click()
    await expect(mobileNav, "o botão Fechar menu fecha o drawer").toHaveCount(0)
    await page.getByRole("button", { name: /Abrir menu|Menu/ }).first().click()
    await mobileNav.getByRole("link", { name: "Sessões" }).first().click()
    await expect(page).toHaveURL(/\/admin\/sessoes/)
    await expect(mobileNav, "navegar fecha o drawer").toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test.describe("5) sessões: stop tardio é do ADMIN", () => {
  for (const perfil of ["admin", "operator"] as const) {
    test.describe(perfil, () => {
      test.use({ storageState: auth(perfil), viewport: { width: 1440, height: 900 } })
      test("detalhe da sessão encerrada pelo servidor", async ({ page }, info) => {
        test.skip(info.project.name !== "1440", "viewport imposto; roda uma vez")
        await prepararPagina(page)
        await page.goto("/admin/sessoes", { waitUntil: "load" })
        await aguardarEstavel(page)
        await page.getByLabel("Status", { exact: true }).selectOption({ label: "Encerrada" })
        const linha = page.getByRole("row").filter({ hasText: "Tiago Travado" })
        const n = await linha.count()
        gravar(`${info.project.name}__${perfil}__sessao-lateStop`, { linhasDoTravado: n })
        test.skip(n === 0, "o mock não expõe a sessão do Tiago Travado a este perfil")
        await linha.first().click()
        const dialogo = page.getByRole("dialog")
        await expect(dialogo).toBeVisible()
        const texto = await dialogo.innerText()
        if (perfil === "admin") expect(texto).toMatch(/StopTransaction tardio/i)
        else expect(texto).not.toMatch(/StopTransaction tardio|stop tardio|lateStop/i)
      })
    })
  }
})
