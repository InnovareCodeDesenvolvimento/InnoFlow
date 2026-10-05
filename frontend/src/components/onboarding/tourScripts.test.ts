import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { getAdminNav } from "@/components/admin/adminNav"
import { summarizeNav } from "./tourNav"
import { resolveSteps } from "./tourLogic"
import { BACKUPS_NAV_HREF, TOUR_DEFINITIONS, tourIdForRole, type TourContext, type TourDefinition } from "./tourScripts"

const SRC = path.resolve(import.meta.dirname, "../..")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === "mocks" || name === "dev" ? [] : sourceFiles(full)
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [full] : []
  })
}

/** Nomes de `data-tour` que EXISTEM no código: literais `data-tour="x"` + os gerados a partir de rotas (`nav-*` do Admin, `app-nav-*` do PWA). */
function existingTargets(): Set<string> {
  const found = new Set<string>()
  for (const file of sourceFiles(SRC)) {
    for (const m of readFileSync(file, "utf8").matchAll(/data-tour="([a-z0-9-]+)"/g)) found.add(m[1])
  }
  // `nav-<rota>`: SidebarNav gera `nav-${href sem /admin/}` para todo item do menu.
  for (const item of getAdminNav("ADMIN").flatMap((g) => g.items)) found.add(`nav-${item.href.replace("/admin/", "")}`)
  // `app-nav-<rota>`: o shell do PWA gera a partir de NAV_ITEMS.
  const layout = readFileSync(path.join(SRC, "pages/App/Layout.tsx"), "utf8")
  for (const m of layout.matchAll(/href: "(\/app[a-z/]*)"/g)) found.add(`app-nav-${m[1] === "/app" ? "inicio" : m[1].replace("/app/", "")}`)
  return found
}

function ctxFor(role: "ADMIN" | "OPERATOR" | "DRIVER", isWide: boolean): TourContext {
  const nav = summarizeNav(role === "DRIVER" ? [] : getAdminNav(role))
  return { role, isWide, navHrefs: nav.hrefs, navLabels: nav.labels, navGroups: nav.groups }
}

const ALL: TourDefinition[] = Object.values(TOUR_DEFINITIONS)

describe("roteiros do tour", () => {
  it.each(ALL)("$id: boas-vindas primeiro, fim por último, ids únicos, textos preenchidos", (def) => {
    expect(def.steps[0].kind).toBe("welcome")
    expect(def.steps[def.steps.length - 1].kind).toBe("finish")
    const ids = def.steps.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const ctx = ctxFor(def.id === "driver" ? "DRIVER" : def.id === "operator" ? "OPERATOR" : "ADMIN", true)
    for (const step of resolveSteps(def, ctx)) {
      expect(step.title.trim().length).toBeGreaterThan(3)
      expect(step.body.trim().length).toBeGreaterThan(20)
      expect(`${step.title} ${step.body}`).not.toMatch(/undefined|\[object|TODO/i)
      // Texto de balão é para ler em segundos: nada de parágrafo.
      expect(step.body.length).toBeLessThan(260)
    }
  })

  it("todo alvo (data-tour) citado pelos roteiros existe no código do shell", () => {
    const existing = existingTargets()
    const missing: string[] = []
    for (const def of ALL) {
      for (const step of def.steps) {
        for (const name of [step.target, step.targetNarrow]) {
          // `nav-backups` é o único que PODE não existir: o passo é inerte até a tela existir (ver `requiresNavHref`).
          if (name && !existing.has(name) && name !== "nav-backups") missing.push(`${def.id}:${step.id}->${name}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it("cada passo de menu do painel exige a rota do próprio alvo (o filtro e o alvo não podem divergir)", () => {
    for (const step of TOUR_DEFINITIONS.admin.steps) {
      if (step.target?.startsWith("nav-")) expect(step.requiresNavHref, step.id).toBe(`/admin/${step.target.slice("nav-".length)}`)
    }
  })
})

describe("roteiro do OPERATOR = o do ADMIN sem as telas só-ADMIN", () => {
  const admin = resolveSteps(TOUR_DEFINITIONS.admin, ctxFor("ADMIN", true))
  const operator = resolveSteps(TOUR_DEFINITIONS.operator, ctxFor("OPERATOR", true))
  const operatorHrefs = getAdminNav("OPERATOR").flatMap((g) => g.items.map((i) => i.href))
  const adminOnlyNavs = getAdminNav("ADMIN")
    .flatMap((g) => g.items)
    .filter((i) => !operatorHrefs.includes(i.href))

  it("o OPERATOR não vê passo que aponta para tela só-ADMIN", () => {
    expect(adminOnlyNavs.length).toBeGreaterThan(0) // se esvaziar, o teste deixou de provar algo
    for (const item of adminOnlyNavs) {
      const target = `nav-${item.href.replace("/admin/", "")}`
      expect(operator.map((s) => s.target)).not.toContain(target)
    }
  })

  it("o ADMIN vê os passos de gateway e configurações; o OPERATOR não (e o resto é o mesmo)", () => {
    expect(admin.map((s) => s.id)).toEqual(expect.arrayContaining(["gateway", "configuracoes"]))
    expect(operator.map((s) => s.id)).not.toContain("gateway")
    expect(operator.map((s) => s.id)).not.toContain("configuracoes")
    const adminOnlyIds = new Set(["gateway", "configuracoes", "backups"])
    expect(admin.filter((s) => !adminOnlyIds.has(s.id)).map((s) => s.id)).toEqual(operator.map((s) => s.id))
  })

  it("o texto do OPERATOR não cita Rede nem o checklist (que é só do ADMIN)", () => {
    const text = operator.map((s) => `${s.title} ${s.body}`).join(" ")
    expect(text).not.toMatch(/\bRede\b|Primeiros passos/)
  })
})

describe("backups: preparado, inerte até a tela existir", () => {
  const adminIds = (ctx: TourContext) => resolveSteps(TOUR_DEFINITIONS.admin, ctx).map((s) => s.id)

  it("o passo acompanha o menu: com a rota no menu aparece, sem ela não aparece (feature check, sem flag manual)", () => {
    const admin = ctxFor("ADMIN", true)
    expect(adminIds({ ...admin, navHrefs: admin.navHrefs.filter((h) => h !== BACKUPS_NAV_HREF) })).not.toContain("backups")
    expect(adminIds({ ...admin, navHrefs: [...admin.navHrefs.filter((h) => h !== BACKUPS_NAV_HREF), BACKUPS_NAV_HREF] })).toContain("backups")
  })

  it("no menu REAL de hoje: o passo existe se e somente se a tela já está no menu (quando ela entrar no adminNav, o passo aparece sozinho; REVISAR o texto dele nesse dia)", () => {
    const inNav = getAdminNav("ADMIN").flatMap((g) => g.items.map((i) => i.href)).includes(BACKUPS_NAV_HREF)
    expect(adminIds(ctxFor("ADMIN", true)).includes("backups")).toBe(inNav)
  })

  it("só para quem tem a rota: o OPERATOR nunca vê o passo de backups", () => {
    const operator = ctxFor("OPERATOR", true)
    expect(resolveSteps(TOUR_DEFINITIONS.operator, { ...operator, navHrefs: operator.navHrefs.filter((h) => h !== BACKUPS_NAV_HREF) }).map((s) => s.id)).not.toContain("backups")
  })
})

describe("tela estreita (menu em drawer fechado)", () => {
  const narrow = resolveSteps(TOUR_DEFINITIONS.admin, ctxFor("ADMIN", false))

  it("só sobram passos cujo alvo existe com a sidebar escondida", () => {
    expect(narrow.map((s) => s.id)).toEqual(["welcome", "menu", "atalhos", "fim"])
    expect(narrow.find((s) => s.id === "menu")?.target).toBe("admin-menu-button")
  })

  it("o texto do menu estreito lista as áreas reais do menu do papel", () => {
    const menu = narrow.find((s) => s.id === "menu")!
    for (const label of getAdminNav("ADMIN").flatMap((g) => g.items.map((i) => i.label))) expect(menu.body).toContain(label)
    const operatorMenu = resolveSteps(TOUR_DEFINITIONS.operator, ctxFor("OPERATOR", false)).find((s) => s.id === "menu")!
    expect(operatorMenu.body).not.toContain("Auditoria")
  })

  it("o motorista tem os mesmos passos em qualquer largura (a navegação existe sempre)", () => {
    expect(resolveSteps(TOUR_DEFINITIONS.driver, ctxFor("DRIVER", false)).map((s) => s.id)).toEqual(resolveSteps(TOUR_DEFINITIONS.driver, ctxFor("DRIVER", true)).map((s) => s.id))
  })
})

describe("afirmações do roteiro conferidas contra o menu real", () => {
  it("o passo Financeiro cita só telas que existem no grupo", () => {
    const financeiro = resolveSteps(TOUR_DEFINITIONS.admin, ctxFor("ADMIN", true)).find((s) => s.id === "financeiro")!
    const labels = getAdminNav("OPERATOR").flatMap((g) => g.items.map((i) => i.label))
    for (const name of ["Faturamento", "Movimento diário", "Pagamentos", "Carteiras"]) {
      expect(financeiro.body).toContain(name)
      expect(labels).toContain(name)
    }
  })

  it("os grupos citados no passo do menu são os do menu do papel", () => {
    const menuBody = (role: "ADMIN" | "OPERATOR") => resolveSteps(TOUR_DEFINITIONS[role === "ADMIN" ? "admin" : "operator"], ctxFor(role, true)).find((s) => s.id === "menu")!.body
    for (const g of getAdminNav("ADMIN")) expect(menuBody("ADMIN")).toContain(g.title)
    expect(menuBody("OPERATOR")).not.toContain("Rede")
  })
})

describe("tourIdForRole", () => {
  it("um tour por papel; visitante não tem", () => {
    expect(tourIdForRole("DRIVER")).toBe("driver")
    expect(tourIdForRole("ADMIN")).toBe("admin")
    expect(tourIdForRole("OPERATOR")).toBe("operator")
    expect(tourIdForRole(undefined)).toBeUndefined()
  })
})
