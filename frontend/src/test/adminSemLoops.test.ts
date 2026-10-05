import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Portão da F-D (docs/DESIGN-SYSTEM-UNIFICACAO.md §4): NENHUM loop contínuo nem entrada em sequência no Admin. O operador quer densidade, não espetáculo.
 * Varre o código do painel e só aceita as classes `animate-*` de infraestrutura: `animate-spin` (spinner de botão em carregamento), `animate-pulse` (esqueleto),
 * `animate-fade-in`/`animate-scale-in`/`animate-in`/`animate-out` (entrada de 150–200 ms do Dialog e do painel lateral de Carteiras). `animate-fade-in-up`, `stagger-*`, `animate-live-glow`, `-radar-ping`, `-float-soft` e afins são do PWA/landing.
 */
const ROOT = path.resolve(import.meta.dirname, "..")
const PASTAS = ["pages/Admin", "components/admin", "components/painel", "components/relatorios", "components/tariffAssignments", "components/chargePoints", "components/connectors"]
const PERMITIDAS = new Set(["animate-spin", "animate-pulse", "animate-fade-in", "animate-scale-in", "animate-in", "animate-out"])

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.(tsx|ts)$/.test(name)) out.push(full)
  }
}

describe("Admin sem loops nem entrada em sequência", () => {
  const arquivos: string[] = []
  for (const p of PASTAS) walk(path.join(ROOT, p), arquivos)

  it("varre o painel inteiro", () => {
    expect(arquivos.length).toBeGreaterThan(40)
  })

  it("só usa as classes animate-* permitidas e nenhum stagger", () => {
    const proibidas: string[] = []
    for (const file of arquivos) {
      // Comentários ficam de fora: eles citam as classes que NÃO se usam.
      const codigo = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      for (const m of codigo.matchAll(/(?<![\w-])(animate-[a-z0-9-]+|stagger-\d)(?![\w-])/g)) {
        if (!PERMITIDAS.has(m[1])) proibidas.push(`${path.relative(ROOT, file)}: ${m[1]}`)
      }
    }
    expect(proibidas).toEqual([])
  })
})
