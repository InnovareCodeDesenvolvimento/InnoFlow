import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * VERIFICAÇÕES do ONBOARDING (tour do mascote + checklist + "Rever tour" em Meu perfil) nos 3 viewports do harness. NÃO grava baseline: produz (a) números e (b) capturas para REVISÃO HUMANA
 * em `e2e-visual/.resultados/onboarding/`. Quem decide se um estado vira baseline é a Íris (lista no relatório da Lyra).
 *  1) CONTRASTE do texto do balão por conta exata: o balão é `.surface-dark` com fundo SÓLIDO (`--color-surface`), então cor de texto x fundo composto das camadas é exato (sem degradê);
 *     o axe `color-contrast` precisa dar 0 reprovados e 0 incompletos DENTRO do balão.
 *  2) O tour passa pelos estados: boas-vindas, passo ancorado, passo com alvo ausente (centralizado) e fim, com `reducedMotion: "reduce"` do harness (a versão estática).
 *  3) Checklist "Primeiros passos" e a seção "Ajuda" do Meu perfil: contraste axe + captura.
 * O harness liga o interruptor `innoflow:onboarding:off` em todo contexto (ver `constantes.ts`); aqui o desligamos com `storageState` vazio para o tour abrir como na 1ª visita real.
 * Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-onboarding --update-snapshots=none`.
 */

test.use({ storageState: { cookies: [], origins: [] } })

const PASTA = "e2e-visual/.resultados/onboarding"
function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}

async function entrar(page: Page, email: string, semTour = false) {
  await prepararPagina(page)
  if (semTour) {
    // 1ª visita já concluída para poder fotografar a tela de fundo / o checklist sem o tour por cima
    await page.addInitScript(() => {
      for (const id of ["user_admin:admin", "user_driver:driver"]) {
        localStorage.setItem(`innoflow:tour:v1:${id}`, JSON.stringify({ version: 1, status: "completed", at: "2026-10-04T00:00:00.000Z" }))
      }
    })
  }
  await page.goto("/login", { waitUntil: "load" })
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 })
}

async function esperarBalao(page: Page) {
  await expect(page.locator("[data-tour-balloon][data-ready]")).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(500)
}

interface Medida {
  texto: string
  razao: number
  fonte: number
  negrito: boolean
  limiar: number
}

/** Contraste exato de cada texto do balão: cor do texto x fundo composto das camadas (de baixo para cima, começando no branco). */
async function contrasteDoBalao(page: Page): Promise<Medida[]> {
  return page.evaluate(() => {
    type C = { r: number; g: number; b: number; a: number }
    const parse = (s: string): C | null => {
      const m = s.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return { r, g, b, a }
    }
    const over = (top: C, bottom: C): C => {
      const a = top.a + bottom.a * (1 - top.a)
      const mix = (x: number, y: number) => (x * top.a + y * bottom.a * (1 - top.a)) / a
      return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
    }
    const lum = ({ r, g, b }: C) => {
      const f = (v: number) => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const fundoDe = (el: Element): C => {
      const camadas: C[] = []
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor)
        if (c && c.a > 0) {
          camadas.push(c)
          if (c.a === 1) break
        }
      }
      return camadas.reverse().reduce<C>((base, c) => over(c, base), { r: 255, g: 255, b: 255, a: 1 })
    }
    const out: { texto: string; razao: number; fonte: number; negrito: boolean; limiar: number }[] = []
    const balao = document.querySelector("[data-tour-balloon]")!
    for (const el of Array.from(balao.querySelectorAll("*"))) {
      const proprio = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()).map((n) => n.textContent!.trim()).join(" ")
      if (!proprio) continue
      const cs = getComputedStyle(el)
      const bg = fundoDe(el)
      const fg0 = parse(cs.color)
      if (!fg0) continue
      const fg = over(fg0, bg)
      const l1 = lum(fg)
      const l2 = lum(bg)
      const fonte = parseFloat(cs.fontSize)
      const negrito = parseInt(cs.fontWeight, 10) >= 700
      out.push({ texto: proprio.slice(0, 40), razao: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), fonte, negrito, limiar: fonte >= 24 || (fonte >= 18.66 && negrito) ? 3 : 4.5 })
    }
    return out
  })
}

async function verificarEstado(page: Page, projeto: string, estado: string) {
  await esperarBalao(page)
  const medidas = await contrasteDoBalao(page)
  expect(medidas.length, `textos medidos no balão (${estado})`).toBeGreaterThan(3)
  const ruins = medidas.filter((m) => m.razao < m.limiar)
  const axe = await new AxeBuilder({ page }).include("[data-tour-balloon]").withRules(["color-contrast"]).analyze()
  // `elmPartiallyObscuring`: nos balões GRANDES (boas-vindas/fim) o axe diz que não consegue avaliar o título e o texto, embora nenhum elemento os cubra (`elementsFromPoint` numa grade sobre os
  // dois devolve só eles mesmos; medido). Esses nós ficam cobertos pela CONTA EXATA acima (fundo sólido); qualquer OUTRO motivo de "incompleto" reprova.
  const incompletos = (axe.incomplete.find((v) => v.id === "color-contrast")?.nodes ?? []).filter(
    (n) => (n.any.find((a) => a.id === "color-contrast")?.data as { messageKey?: string } | undefined)?.messageKey !== "elmPartiallyObscuring",
  ).length
  gravar(`${projeto}__${estado}`, { menor: Math.min(...medidas.map((m) => m.razao)), medidas, reprovadosAxe: axe.violations.length, incompletosAxe: incompletos })
  await page.screenshot({ path: path.join(PASTA, `${projeto}__${estado}.png`) })
  expect(ruins, `texto do balão abaixo do AA (${estado}, ${projeto}px)`).toEqual([])
  expect(axe.violations, `axe color-contrast no balão (${estado})`).toEqual([])
  expect(incompletos, `axe não conseguiu avaliar ${incompletos} nó(s) do balão (${estado})`).toBe(0)
}

test.describe("onboarding: balão do tour (motorista)", () => {
  test("boas-vindas, passo ancorado, alvo ausente (centralizado) e fim", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "motorista@innoelektron.com")
    await verificarEstado(page, p, "motorista-1-boas-vindas")
    await page.getByRole("button", { name: "Vamos lá" }).click()
    await page.waitForTimeout(400)
    await verificarEstado(page, p, "motorista-2-mapa-ancorado")
    await page.getByRole("button", { name: "Próximo" }).click() // QR: está na Home, existe
    await page.waitForTimeout(400)
    await verificarEstado(page, p, "motorista-3-qr")
    for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Próximo" }).click()
    await page.waitForTimeout(400)
    await verificarEstado(page, p, "motorista-7-perfil")
    await page.getByRole("button", { name: "Próximo" }).click()
    await verificarEstado(page, p, "motorista-8-fim")
  })
})

test.describe("onboarding: balão do tour (painel)", () => {
  test("boas-vindas, menu, passo de rota (só 1440), atalhos e fim", async ({ page }, info) => {
    const p = info.project.name
    const largo = (info.project.use.viewport?.width ?? 0) >= 1024
    await entrar(page, "admin@innoelektron.com")
    await verificarEstado(page, p, "admin-1-boas-vindas")
    await page.getByRole("button", { name: "Vamos lá" }).click()
    await page.waitForTimeout(400)
    await verificarEstado(page, p, "admin-2-menu")
    await page.getByRole("button", { name: "Próximo" }).click()
    await page.waitForTimeout(400)
    await verificarEstado(page, p, largo ? "admin-3-dashboard" : "admin-3-atalhos")
    if (largo) {
      for (let i = 0; i < 9; i++) await page.getByRole("button", { name: "Próximo" }).click() // Sites…Configurações
      await page.waitForTimeout(500)
      await verificarEstado(page, p, "admin-12-atalhos")
    }
  })
})

test.describe("onboarding: checklist e Rever tour", () => {
  test("card 'Primeiros passos' do Dashboard (ADMIN): contraste e captura", async ({ page }, info) => {
    await entrar(page, "admin@innoelektron.com", true)
    const card = page.getByRole("region", { name: "Primeiros passos" })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await aguardarEstavel(page)
    const axe = await new AxeBuilder({ page }).include("[data-tour-checklist]").withTags(["wcag2a", "wcag2aa"]).analyze()
    expect(axe.violations).toEqual([])
    // `bgOverlap` no título do card: as manchas decorativas do herói (`BrandBackdrop`, `overflow-hidden` no pai) têm retângulo que o axe soma ao do título, mas não aparecem fora do herói
    // (elementsFromPoint sobre o título devolve só ele; medido). Qualquer OUTRO motivo de contraste "incompleto" reprova.
    const incompletos = axe.incomplete.filter((v) => v.id === "color-contrast").flatMap((v) => v.nodes).filter((n) => (n.any[0]?.data as { messageKey?: string } | undefined)?.messageKey !== "bgOverlap")
    expect(incompletos.map((n) => n.html)).toEqual([])
    await card.screenshot({ path: path.join(PASTA, `${info.project.name}__checklist.png`) })
  })

  test("Meu perfil (motorista) com a seção 'Ajuda' e o botão Rever tour: contraste e captura", async ({ page }, info) => {
    await entrar(page, "motorista@innoelektron.com", true)
    await page.getByRole("link", { name: /^Meu perfil/ }).click()
    const botao = page.getByRole("button", { name: "Rever tour" })
    await expect(botao).toBeVisible({ timeout: 20_000 })
    await aguardarEstavel(page)
    expect((await botao.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
    expect(axe.violations).toEqual([])
    await page.screenshot({ path: path.join(PASTA, `${info.project.name}__perfil-ajuda.png`), fullPage: true })
  })
})
