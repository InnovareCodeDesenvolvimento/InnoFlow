import { describe, expect, it } from "vitest"
import { getAdminNav } from "@/components/admin/adminNav"
import { CONFIG_BASE_PATH, CONFIG_TABS, CONFIG_TAB_IDS, DEFAULT_CONFIG_TAB, configTabFromPathname, configTabHref, isConfigTabId } from "./tabs"

describe("abas de /admin/configuracoes (subrotas)", () => {
  it("cada aba tem href próprio sob a base, na mesma ordem dos ids", () => {
    expect(CONFIG_TABS.map((t) => t.id)).toEqual([...CONFIG_TAB_IDS])
    for (const id of CONFIG_TAB_IDS) expect(configTabHref(id)).toBe(`${CONFIG_BASE_PATH}/${id}`)
    expect(DEFAULT_CONFIG_TAB).toBe("geral")
  })

  it("a aba sai do caminho; fora das abas dá null", () => {
    expect(configTabFromPathname("/admin/configuracoes/email")).toBe("email")
    expect(configTabFromPathname("/admin/configuracoes/alertas/")).toBe("alertas")
    expect(configTabFromPathname("/admin/configuracoes")).toBeNull()
    expect(configTabFromPathname("/admin/configuracoes/xyz")).toBeNull()
    expect(configTabFromPathname("/admin/comunicacao")).toBeNull()
    expect(isConfigTabId("whatsapp")).toBe(true)
    expect(isConfigTabId("pagamentos")).toBe(false)
  })

  it("o menu tem UM item \"Configurações\" só para ADMIN, apontando para a base das abas, e já não tem \"Comunicação\"", () => {
    const labels = (role: "ADMIN" | "OPERATOR") => getAdminNav(role).flatMap((g) => g.items.map((i) => `${i.label}|${i.href}`))
    expect(labels("ADMIN")).toContain(`Configurações|${CONFIG_BASE_PATH}`)
    expect(labels("ADMIN").some((l) => l.startsWith("Comunicação"))).toBe(false)
    expect(labels("OPERATOR").some((l) => l.startsWith("Configurações"))).toBe(false)
  })
})
