import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * CATRACA do vocabulário "premium" de 17/09 — ENCERRADA na F-F do design system unificado (05/10/2026): todas as contagens chegaram a ZERO e o CSS legado foi apagado do
 * `src/index.css`. O teste continua porque agora ele guarda o contrário: uma classe apagada que reaparece num `className` ficaria SEM estilo nenhum (silenciosamente), então
 * qualquer uso é falha. Substitutos: `<Card variant>`, `<Button variant>`, `IconBadge`, `EmptyState tone`, `.press`, e as animações de marca do `tailwind.config.js`
 * (`animate-enter`, `-pop`, `-sheet`, `-radar`, `-live`). Ver `frontend/DESIGN-SYSTEM.md`.
 *
 * Varre `src/pages`, `src/components` (a landing inclusive: o mock do celular usa `lnd-mock-*`) e `src/pagamento-cartao`, e confere que `index.css` não define mais nenhuma delas.
 */

const ROOT = path.resolve(import.meta.dirname, "..")
const SCAN = ["pages", "components", "pagamento-cartao"]

const APAGADAS = [
  "card-premium",
  "card-premium-interactive",
  "btn-glow-primary",
  "btn-glow-accent",
  "pressable",
  "text-gradient-brand",
  "shadow-tinted-primary",
  "table-premium",
  "animate-fade-in-up",
  "animate-float-soft",
  "animate-radar-ping",
  "animate-live-glow",
  "animate-pop-in",
  "animate-sheet-up",
  "stagger-1",
  "stagger-2",
  "stagger-3",
  "stagger-4",
]

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx|ts|css)$/.test(name) && !/\.test\.(tsx|ts)$/.test(name)) out.push(full)
  }
}

const re = (cls: string) => new RegExp(`(?<![\\w-])${cls.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?![\\w-])`, "g")

describe("vocabulário deprecado: zerado (a catraca virou guarda)", () => {
  const arquivos: string[] = []
  for (const d of SCAN) walk(path.join(ROOT, d), arquivos)

  it("varre o app inteiro", () => {
    expect(arquivos.length).toBeGreaterThan(150)
  })

  it.each(APAGADAS)("%s: nenhum uso em className nem CSS de componente", (cls) => {
    const achados: string[] = []
    for (const file of arquivos) {
      // Comentários ficam de fora: eles citam o que foi apagado.
      const codigo = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      if (re(cls).test(codigo)) achados.push(path.relative(ROOT, file))
    }
    expect(achados, `${cls} foi APAGADA do CSS; use o componente/classe novos (ver DESIGN-SYSTEM.md)`).toEqual([])
  })

  it("index.css não define mais nenhuma delas", () => {
    const css = readFileSync(path.join(ROOT, "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    const definidas = APAGADAS.filter((cls) => new RegExp(`\\.${cls.replace(/[-]/g, "\\-")}(?![\\w-])`).test(css))
    expect(definidas).toEqual([])
  })
})
