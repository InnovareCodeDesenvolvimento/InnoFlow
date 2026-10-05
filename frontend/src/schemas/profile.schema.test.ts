import { describe, expect, it } from "vitest"
import { buildChangePasswordSchema, buildProfilePatch, byteLength, profileFormSchema, type ProfileFormValues } from "./profile.schema"

/** Primeiro erro de cada campo - é o que o react-hook-form mostra (um erro por campo). */
const issuesOf = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) => {
  if (r.success) return []
  const seen = new Set<string>()
  return r.error!.issues.filter((i) => !seen.has(String(i.path[0])) && seen.add(String(i.path[0]))).map((i) => `${String(i.path[0])}: ${i.message}`)
}

describe("profileFormSchema", () => {
  const ok: ProfileFormValues = { name: "Carla Motorista", phone: "(11) 91234-5678", cpf: "" }

  it("aceita dados válidos e campos opcionais vazios", () => {
    expect(profileFormSchema.safeParse(ok).success).toBe(true)
    expect(profileFormSchema.safeParse({ name: "A", phone: "", cpf: "" }).success).toBe(true)
  })

  it("nome: obrigatório (após trim) e até 120 caracteres", () => {
    expect(issuesOf(profileFormSchema.safeParse({ ...ok, name: "   " }))).toEqual(["name: Informe o nome."])
    expect(profileFormSchema.safeParse({ ...ok, name: "a".repeat(120) }).success).toBe(true)
    expect(profileFormSchema.safeParse({ ...ok, name: "a".repeat(121) }).success).toBe(false)
  })

  it("telefone: só dígitos, espaço, +, ( ) e -, com 8 a 15 dígitos (mesma regra do servidor)", () => {
    expect(profileFormSchema.safeParse({ ...ok, phone: "+55 (11) 91234-5678" }).success).toBe(true)
    expect(issuesOf(profileFormSchema.safeParse({ ...ok, phone: "11 9abcd" }))).toEqual(["phone: Use apenas números, espaço, +, ( ) e -."])
    expect(issuesOf(profileFormSchema.safeParse({ ...ok, phone: "1234567" }))).toEqual(["phone: Telefone com 8 a 15 dígitos."])
    expect(issuesOf(profileFormSchema.safeParse({ ...ok, phone: "1".repeat(16) }))).toEqual(["phone: Telefone com 8 a 15 dígitos."])
  })

  it("CPF: vazio passa; preenchido precisa do dígito verificador (com ou sem pontuação)", () => {
    expect(profileFormSchema.safeParse({ ...ok, cpf: "529.982.247-25" }).success).toBe(true)
    expect(profileFormSchema.safeParse({ ...ok, cpf: "52998224725" }).success).toBe(true)
    expect(issuesOf(profileFormSchema.safeParse({ ...ok, cpf: "111.111.111-11" }))).toEqual(["cpf: CPF inválido."])
    expect(issuesOf(profileFormSchema.safeParse({ ...ok, cpf: "123" }))).toEqual(["cpf: CPF inválido."])
  })
})

describe("buildProfilePatch - só vai ao servidor o que mudou", () => {
  const initial = { name: "Carla Motorista", phone: "(11) 91234-5678" as string | null }

  it("nada mudou: null (o servidor exige ao menos um campo)", () => {
    expect(buildProfilePatch({ name: "Carla Motorista", phone: "(11) 91234-5678", cpf: "" }, initial)).toBeNull()
    expect(buildProfilePatch({ name: "  Carla Motorista  ", phone: " (11) 91234-5678 ", cpf: "" }, initial)).toBeNull()
  })

  it("só o nome mudou", () => {
    expect(buildProfilePatch({ name: " Carla M. ", phone: "(11) 91234-5678", cpf: "" }, initial)).toEqual({ name: "Carla M." })
  })

  it("telefone esvaziado vira null (apaga); telefone novo vai como texto", () => {
    expect(buildProfilePatch({ name: initial.name, phone: "", cpf: "" }, initial)).toEqual({ phone: null })
    expect(buildProfilePatch({ name: initial.name, phone: "11 98888-7777", cpf: "" }, initial)).toEqual({ phone: "11 98888-7777" })
  })

  it("sem telefone salvo, campo vazio não manda nada", () => {
    expect(buildProfilePatch({ name: "X", phone: "", cpf: "" }, { name: "X", phone: null })).toBeNull()
  })

  it("CPF digitado vai; CPF vazio NUNCA apaga o salvo", () => {
    expect(buildProfilePatch({ name: initial.name, phone: initial.phone!, cpf: "529.982.247-25" }, initial)).toEqual({ cpf: "529.982.247-25" })
    expect(buildProfilePatch({ name: initial.name, phone: initial.phone!, cpf: "" }, initial)).toBeNull()
  })
})

describe("buildChangePasswordSchema", () => {
  const valid = { currentPassword: "senha-antiga-1", newPassword: "senha-nova-123", confirmPassword: "senha-nova-123" }

  it("conta com senha: aceita atual + nova válida + confirmação igual", () => {
    expect(buildChangePasswordSchema(true).safeParse(valid).success).toBe(true)
  })

  it("conta com senha: a atual é obrigatória", () => {
    expect(issuesOf(buildChangePasswordSchema(true).safeParse({ ...valid, currentPassword: "" }))).toEqual(["currentPassword: Informe a senha atual."])
  })

  it("conta só-Google: NÃO pede a atual", () => {
    expect(buildChangePasswordSchema(false).safeParse({ ...valid, currentPassword: "" }).success).toBe(true)
  })

  it("nova senha: mínimo de 10 caracteres", () => {
    expect(issuesOf(buildChangePasswordSchema(true).safeParse({ ...valid, newPassword: "curta123", confirmPassword: "curta123" }))).toEqual([
      "newPassword: A nova senha precisa de pelo menos 10 caracteres.",
    ])
    expect(buildChangePasswordSchema(true).safeParse({ ...valid, newPassword: "a".repeat(10), confirmPassword: "a".repeat(10) }).success).toBe(true)
  })

  it("nova senha: o teto é de 72 BYTES, não de caracteres (acento ocupa 2)", () => {
    const ascii72 = "a".repeat(72)
    const acento = "ã".repeat(40) // 40 caracteres, 80 bytes
    expect(byteLength(acento)).toBe(80)
    expect(buildChangePasswordSchema(true).safeParse({ ...valid, newPassword: ascii72, confirmPassword: ascii72 }).success).toBe(true)
    expect(buildChangePasswordSchema(true).safeParse({ ...valid, newPassword: ascii72 + "a", confirmPassword: ascii72 + "a" }).success).toBe(false)
    expect(issuesOf(buildChangePasswordSchema(true).safeParse({ ...valid, newPassword: acento, confirmPassword: acento }))).toEqual([
      "newPassword: A nova senha pode ter no máximo 72 bytes (acentos e emojis ocupam mais de um).",
    ])
  })

  it("nova igual à atual é recusada no cliente (o servidor também recusa: PASSWORD_UNCHANGED)", () => {
    expect(issuesOf(buildChangePasswordSchema(true).safeParse({ currentPassword: "mesma-senha-1", newPassword: "mesma-senha-1", confirmPassword: "mesma-senha-1" }))).toEqual([
      "newPassword: A nova senha precisa ser diferente da atual.",
    ])
  })

  it("confirmação diferente: erro no campo da confirmação; vazia: pede para repetir", () => {
    expect(issuesOf(buildChangePasswordSchema(true).safeParse({ ...valid, confirmPassword: "outra-coisa-123" }))).toEqual(["confirmPassword: As senhas não conferem."])
    expect(issuesOf(buildChangePasswordSchema(true).safeParse({ ...valid, confirmPassword: "" }))).toEqual(["confirmPassword: Repita a nova senha."])
  })
})
