import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/** O catálogo `/__ds` é DEV-ONLY: a rota só existe sob `import.meta.env.DEV` (o `import()` colapsa no build) e `src/dev/**` sai do `content` do Tailwind em produção. */
const ROOT = path.resolve(import.meta.dirname, "..", "..")
const ler = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8")

describe("catálogo do design system fora do build", () => {
  it("a rota e o lazy import só existem em DEV", () => {
    const app = ler("src/App.tsx")
    expect(app).toMatch(/import\.meta\.env\.DEV\s*\?\s*lazy\(\(\) => import\("@\/dev\/DesignSystemCatalog"\)\)\s*:\s*null/)
    expect(app).toMatch(/DesignSystemCatalog\s*&&/)
  })

  it("src/dev sai do conteúdo do Tailwind em produção", () => {
    expect(ler("tailwind.config.js")).toMatch(/src\/dev/)
  })

  it("nenhum módulo do app importa o catálogo", () => {
    const app = ler("src/App.tsx")
    expect((app.match(/DesignSystemCatalog/g) ?? []).length).toBeGreaterThan(0)
    expect(ler("src/main.tsx")).not.toMatch(/DesignSystemCatalog/)
  })
})
