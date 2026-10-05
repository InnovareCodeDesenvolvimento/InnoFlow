import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { TOUR_DEFINITIONS } from "./tourScripts"
import { TOUR_VERSIONS } from "./tourMeta"

const read = (name: string) => readFileSync(path.resolve(import.meta.dirname, name), "utf8")

/**
 * O tour é um chunk LAZY: quem entra com o shell (PWA/Admin) — `TourProvider`, `tourContext`, `OnboardingChecklist` — NÃO pode importar o overlay, o balão, o mascote nem o roteiro de textos
 * de forma estática, senão o bundler os põe no chunk do shell (ou num compartilhado) e o "carregue depois da primeira pintura" deixa de valer. A prova de bundle está em `scripts/medir-tamanhos.mjs`;
 * este teste barra a regressão no código-fonte, antes do build.
 */
describe("o tour fica fora do caminho do shell", () => {
  const PESADOS = /from "\.\/(OnboardingTour|TourBalloon|TourMascot|tourScripts|tourDom|tourGeometry|tourLogic)"/

  it.each(["TourProvider.tsx", "tourContext.ts", "tourMeta.ts", "tourNav.ts", "onboardingStorage.ts"])("%s não importa o tour pesado de forma estática", (file) => {
    expect(read(file)).not.toMatch(PESADOS)
  })

  it("o TourProvider importa o overlay SÓ por import() dinâmico", () => {
    const src = read("TourProvider.tsx")
    expect(src).toMatch(/lazy\(\(\) => import\("\.\/OnboardingTour"\)\)/)
    expect(src).not.toMatch(/^import .* from "\.\/OnboardingTour"/m)
  })

  it("a versão do roteiro tem fonte única (tourMeta) e as definições a usam", () => {
    for (const [id, def] of Object.entries(TOUR_DEFINITIONS)) expect(def.version).toBe(TOUR_VERSIONS[id as keyof typeof TOUR_VERSIONS])
  })

  it("o overlay NÃO importa o checklist e o checklist NÃO importa o overlay (cada um no seu chunk)", () => {
    expect(read("OnboardingTour.tsx")).not.toMatch(/OnboardingChecklist|useAdminChecklist/)
    expect(read("OnboardingChecklist.tsx")).not.toMatch(/from "\.\/(OnboardingTour|TourBalloon|tourScripts)"/)
  })
})
