import { expect, test } from "@playwright/test"
import path from "node:path"
import { PASTA_AUTH, PERSONAS } from "./constantes"
import { aguardarEstavel, fotografar, prepararPagina } from "./estabilizar"

/**
 * AUTOTESTE DO HARNESS (não roda em `npm run test:visual`; rode com `npx playwright test --config playwright.visual.config.ts sensibilidade`).
 * Injeta uma mutação de CSS em `/admin/dashboard` e confere se a comparação com a baseline a PEGA. Serve para o harness não virar teatro:
 * um limiar frouxo demais devolve "verde" para regressão real. `detecta: false` documenta o ponto cego MEDIDO (não é promessa de que ele
 * é aceitável: é o que o limiar atual não enxerga).
 */
const MUTACOES: Array<{ nome: string; css: string; detecta: boolean | Record<string, boolean> }> = [
  { nome: "controle-sem-mutacao", css: "", detecta: false },
  { nome: "cor-do-texto-secundario-um-degrau-mais-escuro", css: ".text-ink-subtle,.text-ink-soft{color:#7d8591!important}", detecta: true },
  { nome: "padding-de-1px-nos-botoes", css: "button{padding-top:calc(var(--x,0px) + 1px)!important}", detecta: true },
  { nome: "sombra-dos-cards-removida", css: ".card-premium,.card-elevated,.shadow-card{box-shadow:none!important}", detecta: true },
  // Pontos cegos medidos em 04/10/2026 (ver BASELINE.md): alteração minúscula em área pequena.
  { nome: "raio-de-2px-nos-cards (PONTO CEGO)", css: ".card-premium,.card-elevated{border-radius:1.125rem!important}", detecta: false },
  { nome: "um-tom-na-cor-primaria-de-um-botao (PONTO CEGO a 768/1440)", css: ".bg-primary{background-color:#2c6d92!important}", detecta: { "375": true, "768": false, "1440": false } },
]

test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.admin.arquivo}.json`) })

for (const m of MUTACOES) {
  test(`sensibilidade: ${m.nome}`, async ({ page }, info) => {
    await prepararPagina(page)
    await page.goto("/admin/dashboard", { waitUntil: "load" })
    await aguardarEstavel(page)
    if (m.css) await page.addStyleTag({ content: m.css })
    let detectou = false
    try {
      expect(await fotografar(page)).toMatchSnapshot("adm-dashboard.jpg")
    } catch {
      detectou = true
    }
    const esperado = typeof m.detecta === "boolean" ? m.detecta : m.detecta[info.project.name]
    expect(detectou, `mutação "${m.nome}" em ${info.project.name}px: detectou=${detectou}, esperado=${esperado}`).toBe(esperado)
  })
}
