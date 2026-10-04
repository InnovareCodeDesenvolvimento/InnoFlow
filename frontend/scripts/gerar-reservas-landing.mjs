#!/usr/bin/env node
/**
 * Gera `src/components/landing/landing-reserve.css`: a ALTURA RESERVADA de cada seção da landing que fica abaixo da
 * dobra (montadas depois, sob demanda — ver `BelowFold.tsx`).
 *
 * Por que existe: o conteúdo de baixo só é montado quando a pessoa rola. Se o espaço dele não estiver reservado, a
 * página nasce curta e, ao montar, o rodapé "pula" para milhares de pixels adiante (CLS 0,89 medido em rolagem real a 4x
 * de CPU; o Lighthouse não rola, então nunca vê isso). Com a altura reservada o documento já tem o tamanho certo, a
 * barra de rolagem não muda e nada é empurrado quando a seção entra.
 *
 * Como funciona: sobe a landing com TODAS as seções montadas (`/#recursos` monta tudo de uma vez), varre a largura da
 * janela de 320 a 1920 px de 10 em 10, mede a altura de cada seção e comprime em degraus (um degrau novo só quando a
 * altura muda mais de 2%). Cada valor é gravado 1,5% ABAIXO do medido: a seção real nunca fica menor que a reserva (sem
 * vão em branco) e cresce no máximo ~3,5% ao entrar.
 *
 * QUANDO RODAR: sempre que mudar texto, imagem ou layout de uma seção abaixo da dobra. O teste E2E
 * "alturas reservadas" (e2e/landing.spec.ts) falha se a reserva se afastar mais de 4% da altura real.
 *
 * Uso (a partir de frontend/, com a landing servida, ex.: `npx vite preview --port 4173`):
 *   node scripts/gerar-reservas-landing.mjs            # imprime a tabela medida
 *   node scripts/gerar-reservas-landing.mjs --write    # reescreve src/components/landing/landing-reserve.css
 *   node scripts/gerar-reservas-landing.mjs --port 5173 --write
 */
import { chromium } from "@playwright/test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const port = args.includes("--port") ? args[args.indexOf("--port") + 1] : "4173"
const write = args.includes("--write")
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** chave -> id da seção no DOM (a última, FinalCta, não tem id fixo: é a última `section` de `main`). */
const SLOTS = { tour: "como-funciona", op: "para-quem-opera", feat: "recursos", trust: "seguranca", faq: "perguntas", cta: null }
const THRESHOLD = 0.02
const SAFETY = 0.985

const browser = await chromium.launch()
// Duas páginas: com movimento normal e com `prefers-reduced-motion: reduce` (o botão "Pausar animação" do tour some e a
// seção fica ~8 px mais baixa). A reserva usa o MENOR valor entre as duas: nunca sobra vão em branco em nenhum dos modos.
const pages = []
for (const reducedMotion of ["no-preference", "reduce"]) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 900 }, serviceWorkers: "block", reducedMotion })
  const page = await ctx.newPage()
  await page.goto(`http://localhost:${port}/#recursos`)
  await page.waitForSelector("#perguntas", { timeout: 20000 })
  await page.waitForTimeout(3000)
  pages.push(page)
}

/** Mede todas as seções numa largura de janela (repete até duas leituras seguidas coincidirem: o layout assenta em etapas). */
async function measure(w) {
  const perPage = []
  for (const page of pages) {
    await page.setViewportSize({ width: w, height: 900 })
    const read = () =>
      page.evaluate((slots) => {
        const out = { w: innerWidth }
        const sections = [...document.querySelectorAll("main section")].filter((s) => !s.parentElement?.closest("section"))
        for (const [key, id] of Object.entries(slots)) {
          const el = id ? document.getElementById(id) : sections[sections.length - 1]
          out[key] = el ? el.getBoundingClientRect().height : null
        }
        return out
      }, SLOTS)
    let last = null
    let stable = null
    for (let i = 0; i < 8 && !stable; i++) {
      await page.waitForTimeout(120)
      const cur = await read()
      if (last && Object.keys(SLOTS).every((k) => Math.abs(cur[k] - last[k]) < 0.5)) stable = cur
      last = cur
    }
    perPage.push(stable ?? last)
  }
  // n = movimento normal, r = prefers-reduced-motion: reduce
  return { w: perPage[0].w, n: perPage[0], r: perPage[1] }
}

// 1) varredura grossa (10 em 10 px) e, onde a altura muda (> 0,3% em qualquer seção), varredura fina (1 em 1 px) —
//    os pontos de quebra do layout (640, 768, 1024...) e as quebras de linha mudam a altura em larguras exatas, e a
//    reserva tem que acertar o pixel (entre 1023 e 1024 px a altura de uma seção muda em centenas de px).
const coarse = []
for (let w = 320; w <= 1920; w += 10) coarse.push(await measure(w))
const samples = []
for (let i = 0; i < coarse.length; i++) {
  samples.push(coarse[i])
  const next = coarse[i + 1]
  if (next && Object.keys(SLOTS).some((k) => ["n", "r"].some((m) => Math.abs(next[m][k] - coarse[i][m][k]) / coarse[i][m][k] > 0.003))) {
    for (let w = coarse[i].w + 1; w < next.w; w++) samples.push(await measure(w))
  }
}

// 2) degraus por seção: um degrau novo quando a altura se afasta mais de THRESHOLD da referência dele (a 1ª altura do
//    degrau); o valor gravado é o MENOR do degrau, com margem de segurança — nunca maior que a altura real.
function buildSteps(mode, key) {
  const steps = []
  let cur = null
  for (const s of samples) {
    const v = s[mode][key]
    if (v == null) throw new Error(`seção "${key}" não encontrada em ${s.w}px`)
    if (!cur || Math.abs(v - cur.measured) / cur.measured > THRESHOLD) {
      cur = { w: s.w, measured: v, v: Math.floor(v * SAFETY) }
      steps.push(cur)
    } else {
      cur.v = Math.min(cur.v, Math.floor(v * SAFETY))
    }
  }
  return steps
}
const stepsByKey = {}
const reduceByKey = {}
for (const key of Object.keys(SLOTS)) {
  stepsByKey[key] = buildSteps("n", key)
  // Só gera o bloco de movimento reduzido para a seção que de fato muda de altura nesse modo (> 1% em alguma largura).
  if (samples.some((s) => Math.abs(s.r[key] - s.n[key]) / s.n[key] > 0.01)) reduceByKey[key] = buildSteps("r", key)
}
await browser.close()

let css = `/*
 * GERADO por frontend/scripts/gerar-reservas-landing.mjs — NÃO editar à mão.
 * Altura reservada (min-height) do espaço de cada seção abaixo da dobra, por largura de janela, para a página não mudar
 * de tamanho quando as seções entram (ver o cabeçalho do script). Regerar quando o conteúdo/layout delas mudar.
 * (As propriedades comuns de .lnd-slot ficam em landing.css.)
 */
`
const report = []
for (const key of Object.keys(SLOTS)) {
  const steps = stepsByKey[key]
  report.push(`${key}: ${steps.map((s) => `${s.w}:${s.v}`).join(" ")}`)
  // Uma regra por linha (o arquivo vai no CSS crítico da landing: cada byte conta).
  css += `
/* ${key} (${SLOTS[key] ?? "último <section> de main"}) */
.lnd-slot-${key} { min-height: ${steps[0].v}px; }
`
  for (const s of steps.slice(1)) css += `@media (min-width: ${s.w}px) { .lnd-slot-${key} { min-height: ${s.v}px; } }
`
}
// Movimento reduzido: depois de TODAS as regras normais (mesma especificidade, vence a última).
for (const [key, steps] of Object.entries(reduceByKey)) {
  report.push(`${key} (reduce): ${steps.map((s) => `${s.w}:${s.v}`).join(" ")}`)
  css += `
/* ${key}: com prefers-reduced-motion a seção é mais baixa (sem o botão "Pausar animação") */
`
  css += `@media (prefers-reduced-motion: reduce) { .lnd-slot-${key} { min-height: ${steps[0].v}px; } }
`
  for (const s of steps.slice(1)) css += `@media (prefers-reduced-motion: reduce) and (min-width: ${s.w}px) { .lnd-slot-${key} { min-height: ${s.v}px; } }
`
}
console.log(report.join("\n"))
if (write) {
  const file = path.join(root, "src/components/landing/landing-reserve.css")
  writeFileSync(file, css)
  console.log(`\nescrito: ${file} (${css.length} bytes)`)
}
