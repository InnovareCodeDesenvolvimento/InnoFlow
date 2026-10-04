import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * CATRACA do vocabulário "premium" de 17/09 (design system unificado, F-A — docs/DESIGN-SYSTEM-UNIFICACAO.md §3.10).
 *
 * As classes abaixo são DEPRECADAS (bloco "VOCABULÁRIO PREMIUM" do `src/index.css`, fora de `@layer`). Continuam funcionando como aliases
 * durante a migração, mas NÃO se cria uso novo: este teste conta as ocorrências em `src/pages` e `src/components` (fora `components/landing`,
 * que tem o vocabulário `lnd-*` próprio) e FALHA se a contagem SUBIR acima do número gravado aqui. Cada fase da migração (F-B…F-D) troca usos por
 * `<Card variant>` / `<Button variant>` / `IconBadge` / `EmptyState tone` e BAIXA os números; na F-F tudo chega a zero e o bloco é apagado.
 *
 * Ao BAIXAR a contagem, atualize o número abaixo no mesmo commit (o teste também falha se a contagem real ficar MENOR que a gravada, para a
 * catraca não "folgar": o número gravado é sempre o piso real). Nunca suba um número para fazer o teste passar — troque o uso novo pela variante.
 */

const ROOT = path.resolve(import.meta.dirname, "..")
const SCAN = ["pages", "components"]
const SKIP_DIRS = new Set([path.join(ROOT, "components", "landing")])

/** classe -> quantidade gravada (piso). `(?![\w-])` evita contar `card-premium` dentro de `card-premium-interactive`. */
const GRAVADO: Record<string, number> = {
  "card-premium": 28,
  "card-premium-interactive": 0,
  "btn-glow-primary": 7,
  "btn-glow-accent": 0,
  pressable: 21,
  "text-gradient-brand": 9,
  "shadow-tinted-primary": 5,
  "table-premium": 1,
  "animate-fade-in-up": 34,
  "animate-float-soft": 0,
  "animate-radar-ping": 1,
  "animate-live-glow": 1,
  "animate-pop-in": 2,
  "animate-sheet-up": 1,
}

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (SKIP_DIRS.has(full)) continue
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.(tsx|ts)$/.test(name)) out.push(full)
  }
}

function contar(): Record<string, number> {
  const files: string[] = []
  for (const d of SCAN) walk(path.join(ROOT, d), files)
  const counts: Record<string, number> = Object.fromEntries(Object.keys(GRAVADO).map((k) => [k, 0]))
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    for (const cls of Object.keys(GRAVADO)) {
      const re = new RegExp(`(?<![\\w-])${cls.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?![\\w-])`, "g")
      counts[cls] += (text.match(re) ?? []).length
    }
  }
  return counts
}

describe("catraca do vocabulário deprecado (só pode descer)", () => {
  const atual = contar()

  it.each(Object.keys(GRAVADO))("%s não cresce", (cls) => {
    expect(atual[cls], `${cls}: ${atual[cls]} usos, o teto gravado é ${GRAVADO[cls]}. Use a variante do componente (Card/Button/IconBadge/EmptyState) em vez de criar uso novo.`).toBeLessThanOrEqual(GRAVADO[cls])
  })

  it.each(Object.keys(GRAVADO))("%s: o número gravado é o piso real (baixou? atualize GRAVADO)", (cls) => {
    expect(atual[cls], `${cls}: a contagem real (${atual[cls]}) é MENOR que a gravada (${GRAVADO[cls]}). Atualize o número em GRAVADO para travar o ganho.`).toBe(GRAVADO[cls])
  })
})
