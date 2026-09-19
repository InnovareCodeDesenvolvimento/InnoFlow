import { describe, expect, it } from "vitest"
import { resolvePostAuthPath, safeRedirect } from "./authRedirect"

describe("safeRedirect", () => {
  it("aceita caminho interno (fluxo do QR)", () => {
    expect(safeRedirect("/c/CP-VILA-NORTE-01/1")).toBe("/c/CP-VILA-NORTE-01/1")
  })

  it("rejeita o que sairia do site ou não é caminho", () => {
    expect(safeRedirect("//evil.com")).toBeNull()
    expect(safeRedirect("https://evil.com")).toBeNull()
    expect(safeRedirect("evil")).toBeNull()
    expect(safeRedirect("")).toBeNull()
    expect(safeRedirect(null)).toBeNull()
  })
})

describe("resolvePostAuthPath", () => {
  it("redirect seguro vence o destino padrão do papel", () => {
    expect(resolvePostAuthPath({ role: "DRIVER" }, "/c/CP-01/1")).toBe("/c/CP-01/1")
  })

  it("sem redirect: cada papel vai pra própria casa", () => {
    expect(resolvePostAuthPath({ role: "DRIVER" }, null)).toBe("/app")
    expect(resolvePostAuthPath({ role: "ADMIN" }, null)).toBe("/admin")
    expect(resolvePostAuthPath({ role: "OPERATOR" }, null)).toBe("/admin")
  })

  it("redirect inseguro é ignorado (cai no padrão do papel)", () => {
    expect(resolvePostAuthPath({ role: "DRIVER" }, "//evil.com")).toBe("/app")
  })
})
