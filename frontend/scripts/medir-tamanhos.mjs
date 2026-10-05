#!/usr/bin/env node
/**
 * Mede o que a unificação visual pode inchar, no BUILD DE PRODUÇÃO (`dist/`): CSS global, JS por chunk, o precache do service worker
 * (`dist/sw.js`) e a lista de `modulepreload` do `dist/index.html` (o caminho crítico da landing). Tamanho BRUTO e GZIP (nível 9, o
 * mesmo que servidores costumam usar; o nginx do projeto usa o padrão 6 — por isso comparar SEMPRE com a mesma ferramenta, não com
 * números de outras).
 *
 * Uso (a partir de frontend/, depois de `npm run build`):
 *   node scripts/medir-tamanhos.mjs                         # imprime a tabela
 *   node scripts/medir-tamanhos.mjs --json e2e-visual/tamanhos-baseline.json   # grava o JSON
 *   node scripts/medir-tamanhos.mjs --comparar e2e-visual/tamanhos-baseline.json # diferença contra a baseline (sai com 1 se estourar orçamento)
 *
 * Orçamentos (política de 05/10/2026, aprovada pelo dono; substitui o "+40 KB no total do precache" da §3.11 de docs/DESIGN-SYSTEM-UNIFICACAO.md, que nasceu para uma
 * unificação visual e não para um produto que ganhou 20+ telas lazy). Aplicados no --comparar contra `e2e-visual/tamanhos-baseline.json`:
 *   1. CSS global gzip ≤ baseline + 1.500 B (bloqueia TODAS as rotas: continua apertado).
 *   2. modulepreload do index.html: nenhum chunk fora da baseline (por nome sem hash) e nunca mais chunks que a baseline.
 *   3. PRECACHE POR CHUNK (nome sem hash; JS e CSS de assets/, gzip nível 9):
 *        chunk CRÍTICO (está no modulepreload do index.html ou é `vendor-*`/`ui-kit`/`app-hooks`/`index`: carrega em quase toda rota): ≤ ceil(baseline × 1,03 + 512 B);
 *        chunk de ROTA/lazy (qualquer outro que já existia): ≤ ceil(baseline × 1,10 + 1.024 B);
 *        chunk NOVO (sem baseline): só se NÃO for crítico e ≤ 40 KB gzip.
 *      Estouro de UM chunk reprova com o nome dele (quem inchou a rota fica óbvio); o crescimento natural de uma tela não derruba a checagem das outras.
 *   4. Teto GERAL do precache: bruto e gzip ≤ baseline × 1,15 (rede de segurança contra "mil chunks pequenos").
 * A baseline é RE-ANCORADA a cada rodada que o dono aprovar (grave com --json e registre em e2e-visual/BASELINE.md); o histórico da A0 (04/10/2026) fica no campo `a0` do JSON.
 */
import { gzipSync } from "node:zlib"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}

if (!existsSync(path.join(dist, "sw.js"))) {
  console.error("dist/sw.js não existe: rode `npm run build` antes.")
  process.exit(2)
}

const medir = (arquivo) => {
  const buf = readFileSync(arquivo)
  return { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length }
}
const rel = (p) => p.split(path.sep).join("/")
const listar = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listar(path.join(dir, e.name)) : [path.join(dir, e.name)]))

const arquivos = listar(dist)
const porExt = (ext) => arquivos.filter((f) => f.endsWith(ext)).map((f) => ({ arquivo: rel(path.relative(dist, f)), ...medir(f) }))

const css = porExt(".css").sort((a, b) => b.raw - a.raw)
const js = porExt(".js").filter((f) => f.arquivo.startsWith("assets/")).sort((a, b) => b.raw - a.raw)

// CSS "global" = o que o index.html referencia com <link rel="stylesheet"> (bloqueia a renderização de TODAS as rotas).
const html = readFileSync(path.join(dist, "index.html"), "utf8")
const cssGlobal = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/([^"]+)"/g)].map((m) => m[1])
const modulepreload = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/([^"]+)"/g)].map((m) => m[1]).sort()
const scriptEntrada = [...html.matchAll(/<script[^>]+src="\/([^"]+)"/g)].map((m) => m[1])

// Precache do Workbox: entradas `{url:"...",revision:...}` do sw.js (e arquivos `workbox-*.js` que o sw importa, contados à parte).
const sw = readFileSync(path.join(dist, "sw.js"), "utf8")
const precacheUrls = [...new Set([...sw.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1]))].sort()
const precache = precacheUrls.map((u) => {
  const f = path.join(dist, u)
  return existsSync(f) ? { arquivo: u, ...medir(f) } : { arquivo: u, raw: 0, gzip: 0, ausente: true }
})
const soma = (xs, k) => xs.reduce((a, x) => a + x[k], 0)

const resultado = {
  geradoEm: new Date().toISOString(),
  metodo: "gzip nível 9 (node:zlib) sobre os arquivos de dist/",
  cssGlobal: cssGlobal.map((a) => ({ arquivo: a, ...medir(path.join(dist, a)) })),
  cssTodos: css,
  jsTotal: { arquivos: js.length, raw: soma(js, "raw"), gzip: soma(js, "gzip") },
  jsEntrada: scriptEntrada.map((a) => ({ arquivo: a, ...medir(path.join(dist, a)) })),
  modulepreloadIndexHtml: modulepreload.map((a) => ({ arquivo: a, ...medir(path.join(dist, a)) })),
  jsPorChunk: js,
  precache: { entradas: precache.length, raw: soma(precache, "raw"), gzip: soma(precache, "gzip"), itens: precache, swJs: medir(path.join(dist, "sw.js")) },
}

const fmt = (n) => String(n).padStart(9)
const linha = (x) => `${fmt(x.raw)} B  ${fmt(x.gzip)} B gz  ${x.arquivo}`
console.log("== CSS global (bloqueia a renderização de todas as rotas) ==")
resultado.cssGlobal.forEach((x) => console.log(linha(x)))
console.log("\n== CSS (todos) ==")
css.forEach((x) => console.log(linha(x)))
console.log(`\n== JS por chunk (${js.length} arquivos; total ${soma(js, "raw")} B / ${soma(js, "gzip")} B gz) ==`)
js.forEach((x) => console.log(linha(x)))
console.log(`\n== modulepreload do index.html (${modulepreload.length}) ==`)
resultado.modulepreloadIndexHtml.forEach((x) => console.log(linha(x)))
console.log(`\n== Precache do sw.js: ${precache.length} entradas, ${resultado.precache.raw} B bruto / ${resultado.precache.gzip} B gzip (sw.js em si: ${resultado.precache.swJs.raw} B) ==`)

const saida = opt("json")
if (saida) {
  writeFileSync(path.resolve(root, saida), JSON.stringify(resultado, null, 2) + "\n")
  console.log(`\ngravado: ${saida}`)
}

const comparar = opt("comparar")
if (comparar) {
  const base = JSON.parse(readFileSync(path.resolve(root, comparar), "utf8"))
  const falhas = []
  const semHash = (n) => n.replace(/-[\w-]{8}\.(js|css)$/, "-.$1")
  const KB = 1024
  const cssAgora = soma(resultado.cssGlobal, "gzip")
  const cssBase = soma(base.cssGlobal, "gzip")
  console.log(`\nCSS global gzip: ${cssBase} -> ${cssAgora} (${cssAgora - cssBase >= 0 ? "+" : ""}${cssAgora - cssBase} B; orçamento +1500 B)`)
  if (cssAgora - cssBase > 1500) falhas.push("CSS global gzip acima do orçamento (+1.500 B)")

  // 2. modulepreload
  const antesMp = new Set(base.modulepreloadIndexHtml.map((x) => semHash(x.arquivo)))
  const novosMp = resultado.modulepreloadIndexHtml.map((x) => semHash(x.arquivo)).filter((n) => !antesMp.has(n))
  console.log(`modulepreload do index.html: ${base.modulepreloadIndexHtml.length} -> ${modulepreload.length}${novosMp.length ? `  NOVOS: ${novosMp.join(", ")}` : ""}`)
  if (novosMp.length) falhas.push(`modulepreload ganhou chunk(s): ${novosMp.join(", ")}`)
  if (modulepreload.length > base.modulepreloadIndexHtml.length) falhas.push(`modulepreload passou de ${base.modulepreloadIndexHtml.length} para ${modulepreload.length} chunks`)

  // 3. precache por chunk
  const porChunk = (itens) => {
    const m = new Map()
    for (const x of itens) {
      if (!/^assets\/.*\.(js|css)$/.test(x.arquivo)) continue
      const k = semHash(x.arquivo)
      const a = m.get(k) ?? { raw: 0, gzip: 0 }
      a.raw += x.raw
      a.gzip += x.gzip
      m.set(k, a)
    }
    return m
  }
  const cBase = porChunk(base.precache.itens)
  const cAgora = porChunk(resultado.precache.itens)
  const critico = (k) => antesMp.has(k) || /^assets\/(vendor-|ui-kit|app-hooks|index-)/.test(k)
  const linhas = []
  for (const [k, v] of cAgora) {
    const b = cBase.get(k)
    let limite
    let classe
    if (!b) {
      classe = "NOVO"
      limite = critico(k) ? 0 : 40 * KB
    } else if (critico(k)) {
      classe = "crítico"
      limite = Math.ceil(b.gzip * 1.03 + 512)
    } else {
      classe = "rota"
      limite = Math.ceil(b.gzip * 1.1 + 1024)
    }
    const estourou = v.gzip > limite
    if (estourou) falhas.push(`chunk ${k} (${classe}): ${b ? b.gzip : 0} -> ${v.gzip} B gzip, limite ${limite}`)
    linhas.push({ k, classe, base: b?.gzip ?? 0, agora: v.gzip, limite, estourou })
  }
  const sumiram = [...cBase.keys()].filter((k) => !cAgora.has(k))
  console.log(`\nPrecache por chunk (gzip): ${linhas.length} chunks; ${linhas.filter((l) => l.classe === "NOVO").length} novos, ${sumiram.length} sumiram, ${linhas.filter((l) => l.estourou).length} acima do limite`)
  for (const l of linhas.filter((x) => x.estourou || x.classe === "NOVO" || x.agora - x.base > 0.05 * Math.max(x.base, 1) + 512).sort((a, b) => b.agora - b.base - (a.agora - a.base)).slice(0, 25))
    console.log(`  ${l.estourou ? "ESTOUROU" : "        "} ${l.classe.padEnd(7)} ${String(l.base).padStart(7)} -> ${String(l.agora).padStart(7)} B (limite ${l.limite})  ${l.k}`)

  // 4. teto geral
  const preAgora = resultado.precache.raw
  const preBase = base.precache.raw
  const gzAgora = resultado.precache.gzip
  const gzBase = base.precache.gzip
  console.log(`Precache bruto: ${preBase} -> ${preAgora} (${((preAgora / preBase - 1) * 100).toFixed(1)}%; teto +15%) · gzip: ${gzBase} -> ${gzAgora} (${((gzAgora / gzBase - 1) * 100).toFixed(1)}%; teto +15%)`)
  if (preAgora > preBase * 1.15) falhas.push(`Precache bruto acima de +15% (${preBase} -> ${preAgora})`)
  if (gzAgora > gzBase * 1.15) falhas.push(`Precache gzip acima de +15% (${gzBase} -> ${gzAgora})`)

  if (falhas.length) {
    console.error("\nORÇAMENTO ESTOURADO:\n- " + falhas.join("\n- "))
    process.exit(1)
  }
  console.log("\nOrçamentos respeitados.")
}
