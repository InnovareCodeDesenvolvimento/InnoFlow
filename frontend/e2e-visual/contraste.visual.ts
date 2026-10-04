import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PASTA_AUTH, PERSONAS, type Persona } from "./constantes"
import { aguardarEstavel, prepararPagina } from "./estabilizar"
import { ROTAS } from "./rotas"

/**
 * Verificador automático de contraste WCAG AA (axe-core, regra `color-contrast`) nas MESMAS rotas e viewports da regressão visual.
 *
 * Duas funções:
 *  1. RELATÓRIO do estado atual: cada teste grava `e2e-visual/.resultados/contraste/<viewport>__<id>.json` com cada nó reprovado
 *     (cores, razão, tamanho da fonte) e quantos nós o axe NÃO conseguiu avaliar (`incomplete`: fundo em degradê/imagem/transparência —
 *     esses ficam FORA da garantia, e o relatório diz quantos são). `node scripts/relatorio-contraste.mjs` consolida em Markdown/JSON.
 *  2. CATRACA: compara a contagem de nós reprovados da rota×viewport com `e2e-visual/contraste-baseline.json`. Subiu => falha.
 *     Cada fase da unificação deve BAIXAR o número (regrave com `node scripts/relatorio-contraste.mjs --gravar` e revise o diff).
 *     Sem o arquivo de baseline o teste só relata (não falha).
 */
const PASTA_SAIDA = "e2e-visual/.resultados/contraste"
const ARQUIVO_BASELINE = "e2e-visual/contraste-baseline.json"
const baseline: Record<string, number> = existsSync(ARQUIVO_BASELINE) ? JSON.parse(readFileSync(ARQUIVO_BASELINE, "utf8")).contagens : {}

interface NoRuim {
  alvo: string
  html: string
  fg: string
  bg: string
  razao: number
  esperado: number
  fonte: string
}

async function medirContraste(page: Page): Promise<{ ruins: NoRuim[]; incompletos: number; motivosIncompletos: Record<string, number>; passaram: number }> {
  const r = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()
  const violacao = r.violations.find((v) => v.id === "color-contrast")
  const ruins: NoRuim[] = (violacao?.nodes ?? []).map((n) => {
    const d = (n.any.find((a) => a.id === "color-contrast")?.data ?? {}) as Record<string, unknown>
    return {
      alvo: n.target.join(" "),
      html: n.html.slice(0, 160),
      fg: String(d.fgColor ?? ""),
      bg: String(d.bgColor ?? ""),
      razao: Number(d.contrastRatio ?? 0),
      esperado: parseFloat(String(d.expectedContrastRatio ?? "4.5")) || 4.5,
      fonte: `${d.fontSize ?? "?"} / peso ${d.fontWeight ?? "?"}`,
    }
  })
  const nosIncompletos = r.incomplete.find((v) => v.id === "color-contrast")?.nodes ?? []
  const incompletos = nosIncompletos.length
  // POR QUE o axe não conseguiu avaliar (messageKey: bgImage = fundo com imagem/degradê, bgOverlap = sobreposto por outro elemento, pseudoContent, shortTextContent...).
  const motivosIncompletos: Record<string, number> = {}
  for (const n of nosIncompletos) {
    const chave = String((n.any.find((a) => a.id === "color-contrast")?.data as { messageKey?: string } | undefined)?.messageKey ?? "sem-motivo")
    motivosIncompletos[chave] = (motivosIncompletos[chave] ?? 0) + 1
  }
  const passaram = r.passes.find((v) => v.id === "color-contrast")?.nodes.length ?? 0
  return { ruins, incompletos, motivosIncompletos, passaram }
}

function registrar(projeto: string, id: string, rota: string, res: Awaited<ReturnType<typeof medirContraste>>) {
  mkdirSync(PASTA_SAIDA, { recursive: true })
  writeFileSync(
    path.join(PASTA_SAIDA, `${projeto}__${id}.json`),
    JSON.stringify({ viewport: projeto, id, rota, reprovados: res.ruins.length, incompletos: res.incompletos, motivosIncompletos: res.motivosIncompletos, aprovados: res.passaram, nos: res.ruins }, null, 1),
  )
  const chave = `${projeto}/${id}`
  if (chave in baseline) {
    expect(res.ruins.length, `nós com contraste < AA em ${chave} (baseline ${baseline[chave]}) — a unificação não pode PIORAR o contraste`).toBeLessThanOrEqual(baseline[chave])
  }
}

const personas: Persona[] = ["anon", "driver", "travado", "admin"]
for (const persona of personas) {
  test.describe(`contraste — ${persona}`, () => {
    test.use({ storageState: persona === "anon" ? { cookies: [], origins: [] } : path.join(PASTA_AUTH, `${PERSONAS[persona].arquivo}.json`) })
    for (const rota of ROTAS.filter((r) => r.persona === persona)) {
      test(`${rota.id}`, async ({ page }, info) => {
        await prepararPagina(page)
        await page.goto(rota.path, { waitUntil: "load" })
        await aguardarEstavel(page, rota.pronto)
        registrar(info.project.name, rota.id, rota.path, await medirContraste(page))
      })
    }
  })
}

test.describe("contraste — diálogo do admin aberto", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.admin.arquivo}.json`) })
  test("adm-dialogo-novo-site", async ({ page }, info) => {
    await prepararPagina(page)
    await page.goto("/admin/sites", { waitUntil: "load" })
    await aguardarEstavel(page)
    await page.getByRole("button", { name: "Novo site" }).first().click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await aguardarEstavel(page)
    registrar(info.project.name, "adm-dialogo-novo-site", "/admin/sites (diálogo)", await medirContraste(page))
  })
})
