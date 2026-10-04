#!/usr/bin/env node
/**
 * Mede a performance de uma rota do frontend em BUILD DE PRODUCAO (vite build + vite preview) com Lighthouse mobile
 * (preset padrao: Moto G Power emulado, 4x de CPU, rede 4G lenta simulada) e imprime a MEDIANA e a FAIXA de N rodadas.
 *
 * Por que N rodadas: o TBT e bimodal neste ambiente (uma rodada pega a tarefa do Lighthouse num instante, a seguinte
 * nao), entao UMA rodada nao diz nada. Compare sempre mediana + faixa, e olhe o `benchmarkIndex` (velocidade da CPU
 * da maquina): se ele mudar muito entre duas sessoes, os numeros nao sao comparaveis.
 *
 * Uso (a partir de frontend/):
 *   node scripts/medir-lighthouse.mjs                      # build + preview + 5 rodadas em "/"
 *   node scripts/medir-lighthouse.mjs --label depois       # rotulo dos arquivos de saida
 *   node scripts/medir-lighthouse.mjs --runs 7 --no-build  # reaproveita o dist/ atual
 *   node scripts/medir-lighthouse.mjs --path /login        # outra rota (controle: o que e custo fixo do ambiente)
 *   node scripts/medir-lighthouse.mjs --assets             # guarda trace + artefatos (-G) para abrir no DevTools
 *   node scripts/medir-lighthouse.mjs --no-preview --port 4173   # ja ha um servidor de producao nessa porta
 *   node scripts/medir-lighthouse.mjs --all-categories     # tambem acessibilidade, SEO e boas praticas
 *
 * Saida: JSONs em <tmp>/lh-<label>/ (ou --out). Requer Chrome instalado (CHROME_PATH sobrescreve a deteccao) e rede
 * para o `npx lighthouse` na primeira vez. Nao altera nada do projeto alem do dist/ (quando faz o build).
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback
}

if (flag("help") || flag("h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*
/, "").replace(/^\/\*\*?
?/, ""))
  process.exit(0)
}

const runs = Number(opt("runs", "5"))
const port = Number(opt("port", "4173"))
const label = opt("label", "medida")
// Git Bash (MSYS) converte "/login" em "C:/Program Files/Git/login" ao passar argumento: desfaz isso.
const urlPathRaw = opt("path", "/").replace(/^[A-Za-z]:[\/]Program Files[\/]Git/, "")
const urlPath = urlPathRaw.startsWith("/") ? urlPathRaw : `/${urlPathRaw}`
const outDir = path.resolve(opt("out", path.join(tmpdir(), `lh-${label}`)))
const categories = flag("all-categories") ? "performance,accessibility,seo,best-practices" : "performance"
const isWin = process.platform === "win32"

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]
  return candidates.find((c) => existsSync(c))
}

const chrome = findChrome()
if (!chrome) {
  console.error("Chrome nao encontrado. Defina CHROME_PATH.")
  process.exit(2)
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function waitFor(url, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* servidor ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`servidor nao respondeu em ${url}`)
}

if (!flag("no-build") && !flag("no-preview")) {
  console.log("> vite build (producao)...")
  const b = spawnSync("npx", ["vite", "build"], { cwd: root, stdio: "inherit", shell: isWin })
  if (b.status !== 0) process.exit(b.status ?? 1)
}

let server = null
if (!flag("no-preview")) {
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore", shell: isWin })
}
const stop = () => {
  if (!server) return
  if (isWin) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" })
  else server.kill()
}
process.on("exit", stop)
process.on("SIGINT", () => process.exit(130))

const target = `http://localhost:${port}${urlPath}`
await waitFor(target)
mkdirSync(outDir, { recursive: true })
console.log(`> ${runs} rodadas Lighthouse mobile em ${target}  (saida: ${outDir})`)

const rows = []
for (let i = 1; i <= runs; i++) {
  const file = path.join(outDir, `${label}-${i}.json`)
  const lhArgs = [
    "-y",
    "lighthouse@13",
    target,
    "--quiet",
    `--only-categories=${categories}`,
    `--chrome-flags=--headless=new --no-sandbox`,
    "--output=json",
    `--output-path=${file}`,
  ]
  if (flag("assets")) lhArgs.push("-G", "-A=" + path.join(outDir, `${label}-${i}-assets`))
  const r = spawnSync("npx", lhArgs, { cwd: root, shell: isWin, env: { ...process.env, CHROME_PATH: chrome }, stdio: "ignore" })
  if (!existsSync(file)) {
    console.error(`rodada ${i} falhou (status ${r.status})`)
    continue
  }
  const j = JSON.parse(readFileSync(file, "utf8"))
  const a = j.audits
  const lcpEl = a["lcp-breakdown-insight"]?.details?.items?.find((x) => x.type === "node")?.selector ?? "?"
  const row = {
    perf: Math.round(j.categories.performance.score * 100),
    a11y: j.categories.accessibility ? Math.round(j.categories.accessibility.score * 100) : null,
    seo: j.categories.seo ? Math.round(j.categories.seo.score * 100) : null,
    bp: j.categories["best-practices"] ? Math.round(j.categories["best-practices"].score * 100) : null,
    FCP: Math.round(a["first-contentful-paint"].numericValue),
    LCP: Math.round(a["largest-contentful-paint"].numericValue),
    TBT: Math.round(a["total-blocking-time"].numericValue),
    SI: Math.round(a["speed-index"].numericValue),
    CLS: Number(a["cumulative-layout-shift"].numericValue.toFixed(3)),
    bytes: Math.round(a["total-byte-weight"].numericValue / 1024),
    dom: a["dom-size-insight"]?.details?.items?.[0]?.value?.value ?? a["dom-size"]?.numericValue ?? 0,
    bench: j.environment?.benchmarkIndex ? Math.round(j.environment.benchmarkIndex) : 0,
    lcpEl,
  }
  rows.push(row)
  console.log(
    `  ${label} #${i}: perf ${row.perf}  FCP ${row.FCP}  LCP ${row.LCP}  TBT ${row.TBT}  SI ${row.SI}  CLS ${row.CLS}  KiB ${row.bytes}  DOM ${row.dom}  bench ${row.bench}  LCP-el ${lcpEl.slice(0, 60)}`,
  )
}

if (rows.length) {
  const keys = ["perf", "FCP", "LCP", "TBT", "SI", "CLS", "bytes", "dom", "bench", ...(flag("all-categories") ? ["a11y", "seo", "bp"] : [])]
  console.log(`\n=== ${label}: ${rows.length} rodadas (mediana [min..max]) ===`)
  for (const k of keys) {
    const xs = rows.map((r) => r[k])
    console.log(`  ${k.padEnd(6)} ${String(median(xs)).padStart(7)}  [${Math.min(...xs)}..${Math.max(...xs)}]`)
  }
}
stop()
process.exit(0)
