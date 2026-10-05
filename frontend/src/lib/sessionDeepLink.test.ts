import { describe, expect, it } from "vitest"
import { adminSessionPath, readSessionParam } from "./sessionDeepLink"

describe("link direto para a sessão", () => {
  it("monta /admin/sessoes?sessao=<id> e o id volta igual na leitura", () => {
    expect(adminSessionPath("demo_stuck_late_stop")).toBe("/admin/sessoes?sessao=demo_stuck_late_stop")
    expect(readSessionParam("cmg1a2b3c4d5e6f7g8h9i0j1k")).toBe("cmg1a2b3c4d5e6f7g8h9i0j1k")
  })

  it("codifica o que não é seguro na URL", () => {
    expect(adminSessionPath("a b/c")).toBe("/admin/sessoes?sessao=a%20b%2Fc")
  })

  it("ignora ausente, vazio, longo demais e com caracteres fora do formato (não vira chamada de API)", () => {
    expect(readSessionParam(null)).toBeNull()
    expect(readSessionParam("")).toBeNull()
    expect(readSessionParam("x".repeat(65))).toBeNull()
    expect(readSessionParam("../admin")).toBeNull()
    expect(readSessionParam("a b")).toBeNull()
    expect(readSessionParam("id?x=1")).toBeNull()
  })
})
