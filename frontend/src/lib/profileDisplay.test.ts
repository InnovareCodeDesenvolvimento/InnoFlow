import { describe, expect, it } from "vitest"
import { firstName, nameInitial } from "./profileDisplay"

describe("nameInitial / firstName", () => {
  it("inicial maiúscula do primeiro nome, com acento e espaços sobrando", () => {
    expect(nameInitial("carla motorista")).toBe("C")
    expect(nameInitial("  érica silva")).toBe("É")
  })

  it("sem nome: '?' e primeiro nome vazio", () => {
    expect(nameInitial(null)).toBe("?")
    expect(nameInitial("   ")).toBe("?")
    expect(firstName(undefined)).toBe("")
  })

  it("primeiro nome ignora o resto e espaços duplicados", () => {
    expect(firstName("Carla   Maria Silva")).toBe("Carla")
  })
})
