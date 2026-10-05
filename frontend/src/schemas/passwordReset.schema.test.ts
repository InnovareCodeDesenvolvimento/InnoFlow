import { describe, expect, it } from "vitest"
import { forgotPasswordSchema, NEW_PASSWORD_TOO_LONG, NEW_PASSWORD_TOO_SHORT, passwordRuleStatus, resetPasswordFormSchema } from "./passwordReset.schema"

const parse = (newPassword: string, confirmPassword = newPassword) => resetPasswordFormSchema.safeParse({ newPassword, confirmPassword })
const firstMessage = (r: ReturnType<typeof parse>) => (r.success ? null : r.error.issues[0].message)

describe("nova senha: 10 caracteres a 72 BYTES (igual ao backend)", () => {
  it("9 caracteres é curta; 10 passa", () => {
    expect(firstMessage(parse("123456789"))).toBe(NEW_PASSWORD_TOO_SHORT)
    expect(parse("1234567890").success).toBe(true)
  })

  it("72 bytes ASCII passa; 73 não", () => {
    expect(parse("a".repeat(72)).success).toBe(true)
    expect(firstMessage(parse("a".repeat(73)))).toBe(NEW_PASSWORD_TOO_LONG)
  })

  it("conta BYTES UTF-8, não caracteres: 'ã' x 36 = 72 bytes passa; x 37 = 74 bytes (só 37 caracteres) é recusada", () => {
    expect(parse("ã".repeat(36)).success).toBe(true)
    expect(firstMessage(parse("ã".repeat(37)))).toBe(NEW_PASSWORD_TOO_LONG)
    // emoji = 4 bytes: 18 emojis = 72; 19 = 76
    expect(parse("😀".repeat(18)).success).toBe(true)
    expect(parse("😀".repeat(19)).success).toBe(false)
  })

  it("confirmação diferente aponta para o campo de confirmação", () => {
    const r = parse("1234567890", "1234567891")
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.map((i) => [i.path[0], i.message])).toContainEqual(["confirmPassword", "As senhas não conferem."])
  })

  it("confirmação vazia pede para repetir", () => {
    expect(firstMessage(parse("1234567890", ""))).toBe("Repita a nova senha.")
  })

  it("dicas ao vivo: mesma conta do schema", () => {
    expect(passwordRuleStatus("")).toEqual({ minChars: false, maxBytes: true, bytes: 0 })
    expect(passwordRuleStatus("1234567890")).toEqual({ minChars: true, maxBytes: true, bytes: 10 })
    expect(passwordRuleStatus("ã".repeat(37))).toEqual({ minChars: true, maxBytes: false, bytes: 74 })
  })
})

describe("e-mail do 'esqueci minha senha'", () => {
  it("aparado e validado como no cadastro (até 180)", () => {
    const ok = forgotPasswordSchema.safeParse({ email: "  a@b.co  " })
    expect(ok.success && ok.data.email).toBe("a@b.co")
    for (const email of ["", "   ", "sem-arroba", "a@", `${"a".repeat(180)}@b.co`]) expect(forgotPasswordSchema.safeParse({ email }).success, email).toBe(false)
  })
})
