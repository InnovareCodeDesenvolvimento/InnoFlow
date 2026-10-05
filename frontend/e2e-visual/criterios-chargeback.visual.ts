import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { aguardarEstavel, prepararPagina } from "./estabilizar"
import { medirContrastePixel } from "./contraste-pixel"

/**
 * Régua do BLOQUEIO DO CARTÃO POR CHARGEBACK (L1.8) no app do motorista, medida no navegador (skill `medir-antes-de-afirmar`): aviso dentro da janela, sem rolagem horizontal,
 * na ordem certa em relação ao botão de ação, alvos de toque >= 44 px e contraste de TEXTO por pixel (independente do axe). NÃO é pixel-diff e NÃO grava baseline.
 * Larguras próprias (320/390/768/1440) fixadas no teste: roda só no 1º projeto. Conta `chargeback@` (mock; backend real NÃO provado).
 * Rodar: `npx playwright test --config playwright.visual.config.ts criterios-chargeback --update-snapshots=none`. Grava números e capturas em `e2e-visual/.resultados/chargeback/`.
 */

const PASTA = "e2e-visual/.resultados/chargeback"
const LARGURAS = [320, 390, 768, 1440] as const
const TELAS = [
  { id: "cartoes", url: "/app/carteira/cartoes", ancora: "Meus cartões", botao: null },
  { id: "carteira", url: "/app/carteira", ancora: "Carteira", botao: /Adicionar saldo/ },
  { id: "adicionar", url: "/app/carteira/adicionar", ancora: "Adicionar saldo", botao: /Gerar código Pix/ },
  { id: "recarga", url: "/c/CP-VILA-NORTE-01/1", ancora: null, botao: /Iniciar recarga/ },
] as const

async function entrar(page: Page) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill("chargeback@innoelektron.com")
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 })
}

test.describe("Chargeback - régua de geometria e contraste", () => {
  for (const largura of LARGURAS)
    for (const tela of TELAS) {
      test(`${largura}px - ${tela.id}`, async ({ page }, info) => {
        test.skip(info.project.name !== "375", "medida em larguras próprias: roda uma vez só")
        mkdirSync(PASTA, { recursive: true })
        await page.setViewportSize({ width: largura, height: largura >= 1440 ? 900 : 844 })
        await prepararPagina(page)
        await entrar(page)
        // O estado do mock vive na página: navegação INTERNA (history) em vez de `page.goto`, que zeraria a conta.
        await page.evaluate((url) => {
          window.history.pushState({}, "", url)
          window.dispatchEvent(new PopStateEvent("popstate"))
        }, tela.url)
        await page.getByTestId(tela.id === "carteira" ? "cartoes-indisponivel" : "card-eligibility-notice").waitFor({ state: "visible", timeout: 20_000 })
        await aguardarEstavel(page)

        const m = await page.evaluate((botaoSrc) => {
          type Caixa = { x: number; y: number; w: number; h: number }
          const caixa = (el: Element | null): Caixa | null => {
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height }
          }
          const visivel = (el: Element) => {
            const r = el.getBoundingClientRect()
            const cs = getComputedStyle(el)
            return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"
          }
          const aviso = document.querySelector('[data-testid="card-eligibility-notice"]') ?? document.querySelector('[data-testid="cartoes-indisponivel"]')
          const botao = botaoSrc ? ([...document.querySelectorAll("main a, main button")].find((e) => new RegExp(botaoSrc).test(e.textContent ?? "")) ?? null) : null
          const alvos = [...document.querySelectorAll("main a, main button, main input:not([type=radio]):not([type=checkbox])")]
            .filter(visivel)
            .map((e) => ({ nome: (e.getAttribute("aria-label") ?? e.textContent ?? e.tagName).trim().slice(0, 40), h: Math.round(e.getBoundingClientRect().height * 10) / 10, w: Math.round(e.getBoundingClientRect().width * 10) / 10 }))
          const paragrafos = [...(aviso?.querySelectorAll("p") ?? [])].map((p) => ({ texto: (p.textContent ?? "").trim(), truncado: p.scrollWidth > p.clientWidth + 1, caixa: caixa(p) }))
          return {
            aviso: caixa(aviso),
            botao: caixa(botao),
            paragrafos,
            alvos,
            nomesGoogle: [...document.querySelectorAll("main button")].filter((b) => /Google/.test(b.textContent ?? "")).length,
            sobraHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            estourados: [...document.querySelectorAll("body *")].filter((e) => visivel(e) && e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest("[aria-hidden='true']")).slice(0, 5).map((e) => `${e.tagName.toLowerCase()} right=${Math.round(e.getBoundingClientRect().right)}`),
          }
        }, tela.botao ? tela.botao.source : null)

        const contraste = await medirContrastePixel(page)
        writeFileSync(path.join(PASTA, `${largura}__${tela.id}.json`), JSON.stringify({ largura, tela: tela.id, ...m, contraste: { textos: contraste.textos, menor: contraste.menor, reprovados: contraste.reprovados, piores: contraste.piores.slice(0, 3) } }, null, 1))
        await page.screenshot({ path: path.join(PASTA, `${largura}__${tela.id}.png`), fullPage: true, animations: "disabled" })

        // Aviso: dentro da janela, sem estouro, sem texto cortado.
        expect(m.aviso, "aviso presente").not.toBeNull()
        expect(m.sobraHorizontal, `rolagem horizontal a ${largura}px`).toBe(0)
        expect(m.estourados, `elementos além da borda direita a ${largura}px`).toEqual([])
        expect(m.aviso!.x, "aviso à esquerda da janela").toBeGreaterThanOrEqual(0)
        expect(m.aviso!.x + m.aviso!.w, "aviso além da direita").toBeLessThanOrEqual(largura + 0.5)
        for (const p of m.paragrafos) expect(p.truncado, `texto cortado: ${p.texto}`).toBe(false)
        // Nunca manda quem tem chargeback "entrar com o Google".
        expect(m.nomesGoogle).toBe(0)
        // Ordem: o aviso vem antes do botão de ação da tela (o botão não troca de lugar nem some).
        if (m.botao) {
          if (tela.id !== "carteira") expect(m.aviso!.y, "aviso antes do botão de ação").toBeLessThan(m.botao.y)
          expect(m.botao.h, "botão de ação >= 44 px").toBeGreaterThanOrEqual(44)
        }
        // Alvos de toque (PWA: >= 44 px de altura nos controles de conteúdo; o cabeçalho/menu do shell fica fora desta régua (o logo de 28 px é do shell, não desta mudança)).
        // Abaixo de `sm` (640) é 44 px; de `sm` em diante o design system usa 40/32 (ponteiro fino): `Input` mede 42 px a 768/1440, igual às outras telas de formulário.
        for (const a of m.alvos) expect(a.h, `alvo "${a.nome}" a ${largura}px`).toBeGreaterThanOrEqual(largura < 640 ? 44 : 40)
        // Contraste de TEXTO por pixel: nenhum reprovado.
        expect(contraste.reprovados.map((r) => `${r.texto} ${r.pior.toFixed(2)}:1 (< ${r.limiar})`)).toEqual([])
      })
    }
})
