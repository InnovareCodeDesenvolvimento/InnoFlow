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
 * Orçamentos (docs/DESIGN-SYSTEM-UNIFICACAO.md §3.11), aplicados no --comparar:
 *   CSS global gzip ≤ baseline + 2.500 B · precache bruto ≤ baseline + 40 KB · modulepreload do index.html sem chunk novo.
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
  const cssAgora = soma(resultado.cssGlobal, "gzip")
  const cssBase = soma(base.cssGlobal, "gzip")
  console.log(`\nCSS global gzip: ${cssBase} -> ${cssAgora} (${cssAgora - cssBase >= 0 ? "+" : ""}${cssAgora - cssBase} B; orçamento +2500 B)`)
  if (cssAgora - cssBase > 2500) falhas.push("CSS global gzip acima do orçamento (+2.500 B)")
  const preAgora = resultado.precache.raw
  const preBase = base.precache.raw
  console.log(`Precache bruto: ${preBase} -> ${preAgora} (${preAgora - preBase >= 0 ? "+" : ""}${preAgora - preBase} B; orçamento +40960 B)`)
  if (preAgora - preBase > 40 * 1024) falhas.push("Precache acima do orçamento (+40 KB)")
  // Os nomes têm hash: compara pelo "nome sem hash" (assets/landing-AbC123.js -> assets/landing-.js).
  const semHash = (n) => n.replace(/-[\w-]{8}\./, "-.")
  const antes = new Set(base.modulepreloadIndexHtml.map((x) => semHash(x.arquivo)))
  const novos = resultado.modulepreloadIndexHtml.map((x) => semHash(x.arquivo)).filter((n) => !antes.has(n))
  console.log(`modulepreload do index.html: ${base.modulepreloadIndexHtml.length} -> ${modulepreload.length}${novos.length ? `  NOVOS: ${novos.join(", ")}` : ""}`)
  if (novos.length) falhas.push(`modulepreload ganhou chunk(s): ${novos.join(", ")}`)
  if (falhas.length) {
    console.error("\nORÇAMENTO ESTOURADO:\n- " + falhas.join("\n- "))
    process.exit(1)
  }
  console.log("\nOrçamentos respeitados.")
}
