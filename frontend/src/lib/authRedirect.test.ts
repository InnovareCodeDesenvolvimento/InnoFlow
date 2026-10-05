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

  it("rejeita barra invertida (o navegador a lê como '/')", () => {
    expect(safeRedirect("/\\evil.example")).toBeNull()
    expect(safeRedirect("/\\/evil.example")).toBeNull()
    expect(safeRedirect("/c/CP-01\\1")).toBeNull()
  })

  it("rejeita TAB, quebra de linha e outros caracteres de controle (o navegador remove TAB/LF/CR de dentro da URL)", () => {
    expect(safeRedirect("/" + String.fromCharCode(9) + "/evil.example")).toBeNull()
    expect(safeRedirect("/" + String.fromCharCode(10) + "/evil.example")).toBeNull()
    expect(safeRedirect("/" + String.fromCharCode(13) + "/evil.example")).toBeNull()
    expect(safeRedirect("/c/CP-01" + String.fromCharCode(0) + "1")).toBeNull()
    expect(safeRedirect("/c/CP-01" + String.fromCharCode(0x7f))).toBeNull()
  })

  it("não recusa o que é legítimo: acentos, percent-encoding, querystring e hash", () => {
    expect(safeRedirect("/c/CP-VILA-NORTE-01/1?x=1&y=a%20b#topo")).toBe("/c/CP-VILA-NORTE-01/1?x=1&y=a%20b#topo")
    expect(safeRedirect("/app/sessões")).toBe("/app/sessões")
    expect(safeRedirect("/c/%5Cevil")).toBe("/c/%5Cevil") // %5C literal não é barra invertida
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
    expect(resolvePostAuthPath({ role: "DRIVER" }, "/\\evil.example")).toBe("/app")
    expect(resolvePostAuthPath({ role: "ADMIN" }, "/" + String.fromCharCode(9) + "/evil.example")).toBe("/admin")
  })
})
