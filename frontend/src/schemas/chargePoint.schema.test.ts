import { describe, expect, it } from "vitest"
import { chargePointFormSchema } from "./chargePoint.schema"

const base = { siteId: "site_1", ocppIdentity: "CP-01" }
const secretErrors = (basicAuthSecret?: string) => {
  const r = chargePointFormSchema.safeParse({ ...base, basicAuthSecret })
  return r.success ? [] : r.error.issues.filter((i) => i.path[0] === "basicAuthSecret").map((i) => i.message)
}

describe("chargePointFormSchema — basicAuthSecret 16–40 (espelha o backend)", () => {
  it("aceita exatamente 16 e exatamente 40 caracteres", () => {
    expect(secretErrors("a".repeat(16))).toEqual([])
    expect(secretErrors("a".repeat(40))).toEqual([])
  })

  it("recusa 15 (o mínimo antigo era 8) e 41 caracteres, com mensagem em português", () => {
    expect(secretErrors("a".repeat(15))).toEqual([expect.stringMatching(/mínimo 16 caracteres/)])
    expect(secretErrors("a".repeat(8))).toEqual([expect.stringMatching(/mínimo 16 caracteres/)])
    expect(secretErrors("a".repeat(41))).toEqual([expect.stringMatching(/máximo 40 caracteres/)])
  })

  it("vazio ou ausente passa no schema (edição = manter o segredo; a criação é cobrada pelo diálogo)", () => {
    expect(secretErrors("")).toEqual([])
    expect(secretErrors(undefined)).toEqual([])
  })

  it("recusa segredo dentro de 16–40 caracteres que estoura 72 bytes (bcrypt truncaria em silêncio)", () => {
    // "ã" ocupa 2 bytes em UTF-8: 40 × 2 = 80 bytes (recusa); 36 × 2 = 72 bytes (limite exato, aceita).
    expect(secretErrors("ã".repeat(40))).toEqual([expect.stringMatching(/72 bytes/)])
    expect(secretErrors("ã".repeat(36))).toEqual([])
  })
})
