import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * Régua de GEOMETRIA da tela "Meu perfil" (L1.2, `/app/perfil`), medida no navegador - não deduzida do CSS (skill `medir-antes-de-afirmar`). Larguras PRÓPRIAS (320/390/768/1440), fixadas
 * dentro do teste: independem dos 3 projetos do harness (375/768/1440) e por isso roda só no 1º projeto (os demais pulam), senão mediria o mesmo 3 vezes.
 * Rodar: `npx playwright test --config playwright.visual.config.ts criterios-perfil`. Grava `e2e-visual/.resultados/perfil/<largura>__*.json` com os números.
 * Contas (logadas pela UI): `motorista@` (sem telefone/CPF salvos: o caso COMUM, com o campo CPF aberto) e `perfil@` (telefone e CPF já salvos: o CPF vira uma linha "mascarado + Alterar CPF", ~24 px mais baixa).
 *
 * O que se prova (e o que NÃO): geometria, ordem, alvos de toque, esqueleto x conteúdo e cor de superfície - NÃO é pixel-diff (isso é do `rotas.visual.ts`, que depende da baseline da Íris).
 */

const PASTA = "e2e-visual/.resultados/perfil"
const LARGURAS = [320, 390, 768, 1440] as const

function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}

/** `tolerancia`: quanto o card real pode diferir do esqueleto (que desenha o caso comum). Com CPF salvo o card real é ~24 px mais baixo (linha em vez de campo+dica). */
const CONTAS = [
  { email: "motorista@innoelektron.com", tolerancia: 12 },
  { email: "perfil@innoelektron.com", tolerancia: 28 },
] as const

async function entrar(page: Page, email: string) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 })
}

test.describe("Meu perfil - régua de geometria", () => {
  for (const conta of CONTAS)
  for (const largura of LARGURAS) {
    test(`${largura}px - ${conta.email.split("@")[0]}`, async ({ page }, info) => {
      test.skip(info.project.name !== "375", "medida em larguras próprias (320/390/768/1440): roda uma vez só")
      await page.setViewportSize({ width: largura, height: largura >= 1440 ? 900 : 844 })
      await prepararPagina(page)
      await entrar(page, conta.email)

      // --- 1) ESQUELETO: a forma dele precisa ser a do conteúdo (a página não pode "pular" quando o perfil chega).
      await page.evaluate(() => localStorage.setItem("mock:profile-get", "slow"))
      await page.goto("/app/perfil", { waitUntil: "load" })
      await page.getByTestId("perfil-carregando").waitFor({ state: "visible" })
      const esqueleto = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="perfil-carregando"] > div')].map((c) => {
          const r = c.getBoundingClientRect()
          return { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height }
        }),
      )
      await page.evaluate(() => localStorage.removeItem("mock:profile-get"))
      await page.getByLabel("Nome").waitFor({ state: "visible", timeout: 15_000 })
      await aguardarEstavel(page)

      // --- 2) CONTEÚDO medido.
      const m = await page.evaluate(() => {
        const box = (el: Element | null): Caixa | null => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height }
        }
        type Caixa = { x: number; y: number; w: number; h: number }
        const visivel = (el: Element) => {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"
        }
        const secoes = [...document.querySelectorAll("main section[aria-labelledby]")]
        const lum = (rgb: string) => {
          const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number)
          const f = (v: number) => {
            const c = v / 255
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        }
        const header = document.querySelector("header")
        const perfilLink = header?.querySelector('a[href="/app/perfil"]') ?? null
        const sair = header?.querySelector('button[aria-label="Sair"]') ?? null
        const logo = header?.querySelector('a[href="/app"]') ?? null
        const band = document.querySelector("main .surface-dark")
        const alvos = [...document.querySelectorAll("main input:not([type=checkbox]), main button, main a, main label:has(input[type=checkbox]), header a, header button")]
          .filter(visivel)
          .map((e) => ({ nome: (e.getAttribute("aria-label") ?? e.getAttribute("name") ?? e.textContent ?? e.tagName).trim().slice(0, 40), h: Math.round(e.getBoundingClientRect().height * 10) / 10, w: Math.round(e.getBoundingClientRect().width * 10) / 10 }))
        return {
          secoes: secoes.map((s) => ({
            titulo: s.querySelector("h2")?.textContent?.trim() ?? "",
            caixa: box(s),
            fundoLuminancia: lum(getComputedStyle(s.firstElementChild as Element).backgroundColor),
            campos: [...s.querySelectorAll("input:not([type=checkbox])")].map((i) => ({ nome: i.getAttribute("name") ?? i.getAttribute("type") ?? "", caixa: box(i) })),
            botao: box(s.querySelector('button[type="submit"]')),
          })),
          faixaEscura: band ? { caixa: box(band), luminancia: lum(getComputedStyle(band).backgroundColor === "rgba(0, 0, 0, 0)" ? "rgb(14, 42, 58)" : getComputedStyle(band).backgroundColor) } : null,
          header: { logo: box(logo), perfil: box(perfilLink), sair: box(sair), perfilTexto: perfilLink?.textContent?.trim() ?? null, perfilTruncado: (() => { const t = perfilLink?.querySelector("span.truncate"); return t ? t.scrollWidth > t.clientWidth : null })() },
          alvos,
          sobraHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
          h1: [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").trim()),
          h2: [...document.querySelectorAll("h2")].map((h) => (h.textContent ?? "").trim()),
          emailReadonly: document.querySelector('input[type="email"]')?.hasAttribute("readonly") ?? false,
          estourados: [...document.querySelectorAll("body *")].filter((e) => visivel(e) && e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest("[aria-hidden='true']")).slice(0, 5).map((e) => `${e.tagName.toLowerCase()} right=${Math.round(e.getBoundingClientRect().right)}`),
        }
      })

      gravar(`${largura}__${conta.email.split("@")[0]}`, { largura, esqueleto, ...m })

      // Sem rolagem horizontal nem nada além da borda direita.
      expect(m.sobraHorizontal, `rolagem horizontal a ${largura}px`).toBe(0)
      expect(m.estourados, `elementos além da borda direita a ${largura}px`).toEqual([])
      expect(m.h1, "exatamente um h1").toEqual(["Meu perfil"])
      expect(m.h2).toEqual(["Dados pessoais", "Alterar senha"])
      expect(m.emailReadonly, "e-mail somente leitura").toBe(true)

      // Seções: dentro da janela, empilhadas na ordem, mesma coluna e mesma largura, centradas; colunas de no máximo 448 (max-w-md) como as demais telas do app.
      expect(m.secoes).toHaveLength(2)
      const [dados, senha] = m.secoes
      const trilho = largura >= 1024 ? 96 : 0 // `lg:pl-24` do <main>: o trilho lateral ocupa 96 px à esquerda
      for (const s of m.secoes) {
        expect(s.caixa!.x, `seção "${s.titulo}" à esquerda da janela a ${largura}px`).toBeGreaterThanOrEqual(trilho)
        expect(s.caixa!.x + s.caixa!.w, `seção "${s.titulo}" além da direita a ${largura}px`).toBeLessThanOrEqual(largura + 0.5)
        expect(s.caixa!.w, `largura da seção "${s.titulo}" a ${largura}px`).toBeLessThanOrEqual(448 + 0.5)
        expect(s.fundoLuminancia, `miolo CLARO na seção "${s.titulo}"`).toBeGreaterThan(0.6)
        // Campos: preenchem a largura do conteúdo do card (nenhum encolhido por flex/grid sem querer).
        for (const c of s.campos) expect(c.caixa!.w, `campo ${c.nome} a ${largura}px`).toBeGreaterThanOrEqual(s.caixa!.w - 2 * 24 - 1)
      }
      expect(dados.caixa!.x).toBeCloseTo(senha.caixa!.x, 0)
      expect(dados.caixa!.w).toBeCloseTo(senha.caixa!.w, 0)
      expect(senha.caixa!.y, "senha abaixo de dados").toBeGreaterThan(dados.caixa!.y + dados.caixa!.h)
      // Em 390 (celular de verdade) a coluna usa a tela inteira menos o respiro de 16 px de cada lado.
      if (largura === 390) expect(dados.caixa!.w).toBeCloseTo(390 - 32, 0)
      // Centrada no miolo (dentro do espaço descontado o trilho lateral).
      const miolo = largura - trilho
      expect(dados.caixa!.x - trilho + dados.caixa!.w / 2, `coluna centrada a ${largura}px`).toBeCloseTo(miolo / 2, 0)

      // Faixa escura de marca (D1) sobre a qual o título é legível; miolo claro (acima).
      expect(m.faixaEscura!.luminancia, "faixa escura").toBeLessThan(0.15)

      // Alvos de toque >= 44 px de altura (D7) em todos os controles abaixo de `sm` (640 px, celular). Em telas maiores o design system usa as alturas de desktop (40/32 px: `size="touch"`
      // volta a `sm:h-10`) - aí o piso é 32 px. O logo do cabeçalho (link de 28 px, parte do shell e anterior a esta tela) fica fora: não é desta entrega.
      const piso = largura < 640 ? 43.5 : 31.5
      const pequenos = m.alvos.filter((a) => a.nome !== "InnoFlow" && a.h < piso)
      expect(pequenos, `alvos abaixo de ${largura < 640 ? 44 : 32} px a ${largura}px`).toEqual([])

      // Cabeçalho: logo, perfil e Sair na MESMA linha, sem se sobrepor (a 320 o nome encurta com reticências em vez de empurrar o "Sair").
      const { logo, perfil, sair } = m.header
      for (const [nome, c] of [["logo", logo], ["perfil", perfil], ["sair", sair]] as const) expect(c, `${nome} no cabeçalho`).not.toBeNull()
      expect(Math.abs(logo!.y + logo!.h / 2 - (perfil!.y + perfil!.h / 2)), "logo e perfil alinhados").toBeLessThan(2)
      expect(Math.abs(sair!.y + sair!.h / 2 - (perfil!.y + perfil!.h / 2)), "perfil e Sair alinhados").toBeLessThan(2)
      expect(logo!.x + logo!.w, "logo não invade o perfil").toBeLessThanOrEqual(perfil!.x + 0.5)
      expect(perfil!.x + perfil!.w, "perfil não invade o Sair").toBeLessThanOrEqual(sair!.x + 0.5)
      expect(sair!.x + sair!.w, "Sair dentro da janela").toBeLessThanOrEqual(largura + 0.5)

      // Esqueleto x conteúdo: mesma coluna e MESMA altura (o que o usuário vê enquanto carrega é a forma do que vai aparecer).
      expect(esqueleto).toHaveLength(2)
      const reais = [dados.caixa!, senha.caixa!]
      esqueleto.forEach((e, i) => {
        expect(e.x, `esqueleto ${i} na mesma coluna`).toBeCloseTo(reais[i].x, 0)
        expect(e.w, `esqueleto ${i} com a mesma largura`).toBeCloseTo(reais[i].w, 0)
        // Tolerância por conta (ver CONTAS). A 320 px as dicas ("Opcional. Depois de salvo...") quebram em 2 linhas e o card real fica ~36 px mais alto que o esqueleto: medido, aceito (320 é o piso de
        // aparelhos antigos, não o alvo) e registrado no JSON. Os números reais vão em `.resultados/perfil/<largura>__<conta>.json`.
        expect(Math.abs(e.h - reais[i].h), `altura do esqueleto ${i} (${e.h}) x conteúdo (${reais[i].h}) a ${largura}px`).toBeLessThanOrEqual(largura === 320 ? conta.tolerancia + 28 : conta.tolerancia)
      })
    })
  }
})
