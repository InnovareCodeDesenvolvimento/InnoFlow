#!/usr/bin/env node
/**
 * Linha de base de DESEMPENHO: roda `medir-lighthouse.mjs` (mediana de N rodadas, Lighthouse mobile, build de produção + vite preview)
 * para cada rota e grava um JSON estruturado — o que `medir-lighthouse.mjs` sozinho só imprime.
 *
 * Uso (a partir de frontend/, DEPOIS de `npm run build`):
 *   node scripts/medir-linha-de-base.mjs --json e2e-visual/lighthouse-baseline.json            # / /login /cadastro /eletropostos /app
 *   node scripts/medir-linha-de-base.mjs --paths / /login --runs 5 --json saida.json
 *   node scripts/medir-linha-de-base.mjs --comparar e2e-visual/lighthouse-baseline.json --json depois.json   # imprime a diferença de medianas
 *
 * `/app` exige LOGIN. O build de produção não tem o MSW (só existe em dev) e não há API aqui, então o Lighthouse vê o redirecionamento
 * para `/login`: o número de `/app` é, na prática, o de `/login` pós-redirect. Está medido e rotulado `redireciona-para-login`; NÃO é a
 * performance da tela do motorista logado (isso exigiria backend ou um build com mocks).
 */
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d
}
const runs = opt("runs", "5")
const iPaths = args.indexOf("--paths")
const paths = iPaths >= 0 ? args.slice(iPaths + 1).slice(0, args.slice(iPaths + 1).findIndex((x) => x.startsWith("--")) >= 0 ? args.slice(iPaths + 1).findIndex((x) => x.startsWith("--")) : undefined) : ["/", "/login", "/cadastro", "/eletropostos", "/app"]

const resultado = { geradoEm: new Date().toISOString(), rodadas: Number(runs), maquina: { cpus: os.cpus().length, cpu: os.cpus()[0]?.model, platform: process.platform }, rotas: {} }
for (const p of paths) {
  const label = `base${p.replace(/\//g, "_") || "_raiz"}`
  console.log(`\n>>> ${p}`)
  const r = spawnSync("node", ["scripts/medir-lighthouse.mjs", "--no-build", "--path", p, "--runs", runs, "--label", label, "--all-categories"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  })
  const out = r.stdout + r.stderr
  process.stdout.write(out)
  const medianas = {}
  for (const m of out.matchAll(/^\s{2}(perf|FCP|LCP|TBT|SI|CLS|bytes|dom|bench|a11y|seo|bp)\s+([\d.]+)\s+\[([\d.]+)\.\.([\d.]+)\]/gm))
    medianas[m[1]] = { mediana: Number(m[2]), min: Number(m[3]), max: Number(m[4]) }
  const lcp = [...out.matchAll(/LCP-el (.*)$/gm)].map((m) => m[1].trim())
  resultado.rotas[p] = {
    nota: p === "/app" ? "redireciona-para-login (sem backend/MSW no build de produção): NÃO é a tela do motorista logado" : undefined,
    medianas,
    elementoLcp: [...new Set(lcp)],
  }
}
const saida = opt("json", undefined)
if (saida) {
  writeFileSync(path.resolve(root, saida), JSON.stringify(resultado, null, 2) + "\n")
  console.log(`\ngravado: ${saida}`)
}
const comparar = opt("comparar", undefined)
if (comparar) {
  const base = JSON.parse(readFileSync(path.resolve(root, comparar), "utf8"))
  console.log("\n== diferença de medianas (agora - baseline) ==")
  for (const [p, v] of Object.entries(resultado.rotas)) {
    const b = base.rotas[p]?.medianas
    if (!b) continue
    const d = (k) => (v.medianas[k] && b[k] ? `${k} ${b[k].mediana} -> ${v.medianas[k].mediana}` : "")
    console.log(`${p.padEnd(14)} ${["perf", "LCP", "TBT", "CLS", "bytes"].map(d).join("  ")}   (bench ${b.bench?.mediana} -> ${v.medianas.bench?.mediana})`)
  }
}
