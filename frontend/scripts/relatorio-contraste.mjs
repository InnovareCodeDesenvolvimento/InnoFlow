#!/usr/bin/env node
/**
 * Consolida `e2e-visual/.resultados/contraste/*.json` (gerados por `npm run test:contraste`) em:
 *   e2e-visual/CONTRASTE-ESTADO-ATUAL.md   — relatório legível (por combinação de cores e por rota×viewport)
 *   e2e-visual/contraste-baseline.json     — com --gravar: contagem por rota×viewport, a CATRACA lida pelo teste
 * Uso: node scripts/relatorio-contraste.mjs [--gravar]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pasta = path.join(root, "e2e-visual/.resultados/contraste")
if (!existsSync(pasta)) {
  console.error("Sem resultados: rode `npm run test:contraste` antes.")
  process.exit(2)
}
const itens = readdirSync(pasta)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(pasta, f), "utf8")))
itens.sort((a, b) => a.id.localeCompare(b.id) || Number(a.viewport) - Number(b.viewport))

const contagens = Object.fromEntries(itens.map((i) => [`${i.viewport}/${i.id}`, i.reprovados]))
if (process.argv.includes("--gravar")) {
  writeFileSync(
    path.join(root, "e2e-visual/contraste-baseline.json"),
    JSON.stringify({ geradoEm: new Date().toISOString(), regra: "axe color-contrast (WCAG 2 AA); nº de nós reprovados por viewport/rota", contagens }, null, 2) + "\n",
  )
  console.log("gravado e2e-visual/contraste-baseline.json")
}

// Por combinação (fg, bg, fonte): onde aparece e quantos nós.
const combos = new Map()
for (const i of itens)
  for (const n of i.nos) {
    const k = `${n.fg} sobre ${n.bg} · ${n.fonte} · razão ${n.razao} (mín ${n.esperado})`
    const c = combos.get(k) ?? { nos: 0, rotas: new Set() }
    c.nos++
    c.rotas.add(i.id)
    combos.set(k, c)
  }

// Por classe de cor de texto (o que a Lyra de fato edita): extrai `text-white/NN`, `text-ink-*` etc. do HTML do nó.
const porClasse = new Map()
for (const i of itens)
  for (const n of i.nos) {
    const cls = (n.html.match(/text-(?:white\/\d+|ink-[a-z]+|primary-\d+|accent-\d+|warning-\d+|danger-\d+)/) ?? ["(sem classe de cor no trecho)"])[0]
    const c = porClasse.get(cls) ?? { nos: 0, min: 99, max: 0, rotas: new Set() }
    c.nos++
    c.min = Math.min(c.min, n.razao)
    c.max = Math.max(c.max, n.razao)
    c.rotas.add(i.id)
    porClasse.set(cls, c)
  }

// Por que o axe não avaliou (messageKey) e em quais páginas — a LISTA do que precisa de cálculo manual.
const motivosInc = new Map()
for (const i of itens)
  for (const [m, q] of Object.entries(i.motivosIncompletos ?? {})) {
    const c = motivosInc.get(m) ?? { nos: 0, rotas: new Map() }
    c.nos += q
    c.rotas.set(i.id, (c.rotas.get(i.id) ?? 0) + q)
    motivosInc.set(m, c)
  }

const total = itens.reduce((a, i) => a + i.reprovados, 0)
const incompletos = itens.reduce((a, i) => a + i.incompletos, 0)
const aprovados = itens.reduce((a, i) => a + i.aprovados, 0)
const linhas = ["# Contraste AA — estado atual (axe-core `color-contrast`)", ""]
linhas.push(`Gerado por \`scripts/relatorio-contraste.mjs\` a partir de \`npm run test:contraste\`. ${itens.length} medições (rota × viewport).`, "")
linhas.push(`- Nós **reprovados**: ${total} · nós **aprovados**: ${aprovados} · nós **que o axe NÃO conseguiu avaliar** (fundo em degradê/imagem/vidro): ${incompletos}.`)
linhas.push(
  "- **Garante:** nenhum texto avaliado pelo axe, fora dos reprovados abaixo, tem razão < 4,5:1 (3:1 para texto grande). **Não garante:** os `incompletos` (principalmente a landing escura e o vidro) não foram avaliados.",
  "",
)
linhas.push("## Combinações reprovadas (agrupadas)", "", "| Cores (fg sobre bg) · fonte · razão | Nós | Rotas |", "|---|---:|---|")
for (const [k, c] of [...combos.entries()].sort((a, b) => b[1].nos - a[1].nos))
  linhas.push(`| ${k} | ${c.nos} | ${[...c.rotas].slice(0, 6).join(", ")}${c.rotas.size > 6 ? ` +${c.rotas.size - 6}` : ""} |`)
linhas.push("", "## Por classe de cor de texto (extraída do HTML do nó)", "", "| Classe | Nós | Razão (mín–máx) | Rotas |", "|---|---:|---|---|")
for (const [k, c] of [...porClasse.entries()].sort((a, b) => b[1].nos - a[1].nos))
  linhas.push(`| \`${k}\` | ${c.nos} | ${c.min}–${c.max} | ${[...c.rotas].slice(0, 5).join(", ")}${c.rotas.size > 5 ? ` +${c.rotas.size - 5}` : ""} |`)
linhas.push("", "## Nós que o axe NÃO conseguiu avaliar (`incomplete`) — por motivo", "", "| Motivo (messageKey do axe) | Nós | Onde (rota: nós, as 6 maiores) |", "|---|---:|---|")
for (const [m, c] of [...motivosInc.entries()].sort((a, b) => b[1].nos - a[1].nos))
  linhas.push(`| ${m} | ${c.nos} | ${[...c.rotas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, q]) => `${r}: ${q}`).join(", ")} |`)
linhas.push("", "## Por rota × viewport (reprovados / incompletos)", "", "| Rota | 375 | 768 | 1440 |", "|---|---:|---:|---:|")
for (const id of [...new Set(itens.map((i) => i.id))]) {
  const cel = (v) => {
    const i = itens.find((x) => x.id === id && x.viewport === v)
    return i ? `${i.reprovados} / ${i.incompletos}` : "-"
  }
  linhas.push(`| ${id} | ${cel("375")} | ${cel("768")} | ${cel("1440")} |`)
}
writeFileSync(path.join(root, "e2e-visual/CONTRASTE-ESTADO-ATUAL.md"), linhas.join("\n") + "\n")
console.log(`reprovados ${total} · aprovados ${aprovados} · incompletos ${incompletos} -> e2e-visual/CONTRASTE-ESTADO-ATUAL.md`)
