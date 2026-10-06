import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { consumeReturnTo, peekReturnTo, rememberReturnTo, resolvePostAuthPath, RETURN_TO_STORAGE_KEY, RETURN_TO_TTL_MS, safeRedirect } from "./authRedirect"

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

describe("destino de retorno (sessionStorage)", () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it("guarda e devolve o caminho; consume lê e apaga (uso único)", () => {
    rememberReturnTo("/admin/dashboard?periodo=7d")
    expect(peekReturnTo()).toBe("/admin/dashboard?periodo=7d")
    expect(peekReturnTo()).toBe("/admin/dashboard?periodo=7d") // peek não apaga
    expect(consumeReturnTo()).toBe("/admin/dashboard?periodo=7d")
    expect(consumeReturnTo()).toBeNull()
    expect(sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull()
  })

  it("sem nada guardado: null", () => {
    expect(peekReturnTo()).toBeNull()
    expect(consumeReturnTo()).toBeNull()
  })

  it("valor hostil NA GRAVAÇÃO é ignorado (nada chega ao storage)", () => {
    for (const hostil of ["//evil.com", "https://evil.com", "evil", "", null, undefined, "/\\evil.example", "/" + String.fromCharCode(9) + "/evil.example"]) {
      rememberReturnTo(hostil)
    }
    expect(sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull()
  })

  it("valor hostil que já estava no storage (adulterado) é ignorado NA LEITURA e apagado no consume", () => {
    sessionStorage.setItem(RETURN_TO_STORAGE_KEY, JSON.stringify({ path: "//evil.com", at: Date.now() }))
    expect(peekReturnTo()).toBeNull()
    expect(consumeReturnTo()).toBeNull()
    expect(sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull()
  })

  it.each([
    ["JSON quebrado", "{nao-e-json"],
    ["sem o campo at", JSON.stringify({ path: "/app" })],
    ["at que não é número", JSON.stringify({ path: "/app", at: "agora" })],
    ["path que não é texto", JSON.stringify({ path: 42, at: Date.now() })],
    ["null", "null"],
  ])("conteúdo malformado (%s) é ignorado sem lançar", (_nome, bruto) => {
    sessionStorage.setItem(RETURN_TO_STORAGE_KEY, bruto)
    expect(peekReturnTo()).toBeNull()
    expect(consumeReturnTo()).toBeNull()
  })

  it("vale 30 min: aos 29 min ainda devolve, depois dos 30 min é ignorado", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"))
    rememberReturnTo("/app/carteira")
    vi.setSystemTime(Date.now() + RETURN_TO_TTL_MS - 60_000)
    expect(peekReturnTo()).toBe("/app/carteira")
    vi.setSystemTime(Date.now() + 2 * 60_000)
    expect(peekReturnTo()).toBeNull()
    expect(consumeReturnTo()).toBeNull()
    expect(sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull()
  })

  it("relógio que andou para trás (gravado 'no futuro') não é confiável", () => {
    sessionStorage.setItem(RETURN_TO_STORAGE_KEY, JSON.stringify({ path: "/app", at: Date.now() + 10 * 60_000 }))
    expect(peekReturnTo()).toBeNull()
  })

  it("não guarda as próprias telas de acesso (voltar para o login deixaria a pessoa parada nele)", () => {
    for (const p of ["/login", "/login?x=1", "/cadastro", "/cadastro#topo"]) rememberReturnTo(p)
    expect(sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull()
    rememberReturnTo("/loginx")
    expect(peekReturnTo()).toBe("/loginx")
  })

  it("sessionStorage indisponível (modo privado/bloqueado): nada lança e tudo cai no 'sem destino'", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError")
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError")
    })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError")
    })
    expect(() => rememberReturnTo("/app")).not.toThrow()
    expect(peekReturnTo()).toBeNull()
    expect(consumeReturnTo()).toBeNull()
    expect(resolvePostAuthPath({ role: "DRIVER" }, consumeReturnTo())).toBe("/app")
    expect(resolvePostAuthPath({ role: "ADMIN" }, consumeReturnTo())).toBe("/admin")
  })
})
